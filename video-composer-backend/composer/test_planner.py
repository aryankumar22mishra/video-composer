import base64
import json
import os
import tempfile
import uuid
from unittest import mock
from django.test import TestCase, override_settings
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.signing import BadSignature

from .ai_agent import ProviderResponseError
from .planner import request_plan, PLANNER_PROMPT
from .tool_registry import REGISTRY, tool_definitions, validate_call
from .media_tools import prepare_operation, execute_operation, SERVICE_EXECUTORS
from .models import AgentOperation


def call(name="set_volume", arguments=None, id="step-1", depends_on=None):
    return {"id": id, "name": name, "arguments": arguments or {"clip_id": "clip-1", "volume": .5}, "depends_on": depends_on or []}


class RegistryTests(TestCase):
    def test_missing_services_explain_configuration_and_alternative(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            tools = {t["name"]: t for t in tool_definitions()}
        for name in SERVICE_EXECUTORS:
            self.assertFalse(tools[name]["available"])
            self.assertIn("_SERVICE_URL", tools[name]["unavailable_reason"])
            self.assertIn("_API_KEY", tools[name]["unavailable_reason"])
            self.assertIn(tools[name]["alternative"], tools[name]["unavailable_reason"])

    def test_registry_executor_coverage(self):
        self.assertEqual({name for name, tool in REGISTRY.items() if tool["executor"] == "service"}, set(SERVICE_EXECUTORS))

    def test_invalid_tools_arguments_and_code_rejected(self):
        for candidate in [call("exec", {"code": "print(1)"}), call(arguments={"clip_id": "c", "volume": True}),
                          call(arguments={"clip_id": "c", "volume": 2}), call(arguments={"clip_id": "c", "volume": .5, "shell": "echo"}),
                          call("set_dimensions", {"width": 1281, "height": 720})]:
            with self.assertRaises(ValueError):
                validate_call(candidate)

    def test_recording_availability_is_dynamic(self):
        with self.assertRaises(ValueError):
            validate_call(call("stop_recording", {}))
        stop = {"id": "stop", "name": "stop_recording", "arguments": {}}
        self.assertEqual(validate_call(stop, "recording")["executor"], "ui")


class PlannerTests(TestCase):
    def plan(self, response, **context):
        def provider(*args, **kwargs):
            self.sent = kwargs
            return kwargs["response_parser"](json.dumps(response))
        with mock.patch("composer.planner.request_editing_actions", side_effect=provider):
            return request_plan({"prompt": "Make the clip quieter", "composition": {"tracks": []}, **context})

    def test_single_edit_is_schema_validated(self):
        result = self.plan({"status": "continue", "calls": [call()], "goal": "Quieter audio", "message": ""})
        self.assertEqual(result["calls"][0]["name"], "set_volume")
        self.assertIn('"arguments"', self.sent["system_override"])
        self.assertIn("set_volume", self.sent["system_override"])

    def test_real_results_are_fed_back_for_dependent_planning(self):
        receipts = [{"id": "split", "status": "success", "output": {"clip_ids": ["actual-a", "actual-b"]}}]
        self.plan({"status": "continue", "calls": [call(arguments={"clip_id": "actual-b", "volume": 0}, depends_on=["split"])]}, tool_results=receipts)
        self.assertEqual(self.sent["planner_context"]["tool_results"], receipts)

    def test_forward_and_duplicate_dependencies_rejected(self):
        for calls in [[call(depends_on=["future"])], [call(), call()]]:
            with self.assertRaises(ProviderResponseError):
                self.plan({"status": "continue", "calls": calls})

    def test_goal_clarification_and_unavailable_response(self):
        result = self.plan({"status": "clarify", "calls": [], "message": "What product, audience, duration and format should the promotion use?"})
        self.assertEqual(result["status"], "clarify")
        self.assertIn("plan_scenes", PLANNER_PROMPT)
        with self.assertRaises(ProviderResponseError):
            self.plan({"status": "clarify", "calls": [call()], "message": "Which clip?"})

    def test_limits_reject_before_provider(self):
        with mock.patch("composer.planner.request_editing_actions") as provider:
            for extra in [{"round": 10}, {"tool_results": [{}] * 25}]:
                with self.assertRaises(ValueError):
                    request_plan({"prompt": "x", "composition": {}, **extra})
            provider.assert_not_called()

    def test_api_routes(self):
        response = self.client.get("/api/ai/tools/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("tools", response.json())
        with mock.patch("composer.views.request_plan", return_value={"status": "done", "calls": []}):
            response = self.client.post("/api/ai/plan/", {"prompt": "Hello", "composition": {}}, content_type="application/json")
            self.assertEqual(response.status_code, 200)


class MediaServiceTests(TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.settings_override = override_settings(MEDIA_ROOT=self.directory.name)
        self.settings_override.enable()
        self.addCleanup(self.settings_override.disable)
        self.env = mock.patch.dict(os.environ, {"IMAGE_GENERATION_SERVICE_URL": "https://gateway.example/image",
            "IMAGE_GENERATION_API_KEY": "secret-not-for-browser", "TRANSCRIPTION_SERVICE_URL": "https://gateway.example/transcribe",
            "TRANSCRIPTION_API_KEY": "secret"})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.data = {"operation_id": str(uuid.uuid4()), "run_id": str(uuid.uuid4()),
                     "call": call("generate_image", {"prompt": "Coffee", "width": 1280, "height": 720})}

    def test_preparation_does_not_generate_and_confirmation_is_bound(self):
        with mock.patch.dict(SERVICE_EXECUTORS, {"generate_image": mock.Mock()}) as executors:
            approval = prepare_operation(self.data)
            executors["generate_image"].assert_not_called()
        self.assertNotIn("secret-not-for-browser", json.dumps(approval))
        with self.assertRaises(BadSignature):
            execute_operation(approval["approval_token"] + "tampered")
        self.data["call"]["arguments"]["prompt"] = "Changed"
        with self.assertRaisesRegex(ValueError, "reused"):
            prepare_operation(self.data)

    def test_confirmed_operation_executes_once_and_replays_actual_asset_id(self):
        approval = prepare_operation(self.data)
        gateway = mock.Mock(return_value={"mime_type": "image/png", "base64": base64.b64encode(b"fake image for transport test").decode()})
        with mock.patch.dict(SERVICE_EXECUTORS, {"generate_image": gateway}):
            first = execute_operation(approval["approval_token"])
            second = execute_operation(approval["approval_token"])
        gateway.assert_called_once()
        self.assertEqual(first, second)
        self.assertTrue(first["asset_id"].startswith("generated-"))
        self.assertTrue(first["url"].startswith("/media/agent/generated/"))

    def test_failed_or_inflight_service_never_resubmits(self):
        approval = prepare_operation(self.data)
        gateway = mock.Mock(side_effect=TimeoutError("secret upstream data"))
        with mock.patch.dict(SERVICE_EXECUTORS, {"generate_image": gateway}):
            with self.assertRaisesRegex(ValueError, "may have been billed") as error:
                execute_operation(approval["approval_token"])
            self.assertNotIn("secret upstream", str(error.exception))
            with self.assertRaisesRegex(ValueError, "will not be submitted again"):
                execute_operation(approval["approval_token"])
        gateway.assert_called_once()
        self.assertEqual(AgentOperation.objects.get(id=self.data["operation_id"]).status, "uncertain")

    def test_media_budget_and_changed_service_require_new_approval(self):
        approval = prepare_operation(self.data)
        with mock.patch.dict(os.environ, {"IMAGE_GENERATION_SERVICE_URL": "https://different.example/"}):
            with self.assertRaisesRegex(ValueError, "configuration changed"):
                execute_operation(approval["approval_token"])
        for _ in range(3):
            self.data["operation_id"] = str(uuid.uuid4())
            prepare_operation(self.data)
        self.data["operation_id"] = str(uuid.uuid4())
        with self.assertRaisesRegex(ValueError, "four"):
            prepare_operation(self.data)

    def test_transcription_requires_confirmed_exact_source_bytes(self):
        import hashlib
        content = b"source audio"
        self.data["call"] = call("transcribe", {"asset_id": "audio-1"})
        self.data["media_digest"] = hashlib.sha256(content).hexdigest()
        approval = prepare_operation(self.data)
        self.assertTrue(approval["sends_source_media"])
        with self.assertRaisesRegex(ValueError, "changed after confirmation"):
            execute_operation(approval["approval_token"], SimpleUploadedFile("voice.wav", b"other", content_type="audio/wav"))
        gateway = mock.Mock(return_value={"text": "Fresh coffee every morning"})
        with mock.patch.dict(SERVICE_EXECUTORS, {"transcribe": gateway}):
            result = execute_operation(approval["approval_token"], SimpleUploadedFile("voice.wav", content, content_type="audio/wav"))
        self.assertEqual(result["text"], "Fresh coffee every morning")

    def test_external_urls_cannot_be_returned_as_generated_assets(self):
        approval = prepare_operation(self.data)
        with mock.patch.dict(SERVICE_EXECUTORS, {"generate_image": mock.Mock(return_value={"url": "http://internal/secret"})}):
            with self.assertRaisesRegex(ValueError, "invalid result"):
                execute_operation(approval["approval_token"])
