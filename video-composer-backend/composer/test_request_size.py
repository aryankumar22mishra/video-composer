import json
import os
import urllib.error
from unittest import mock
from django.test import SimpleTestCase
from . import ai_agent
from .planner import PLANNER_PROMPT, provider_tool_definitions, request_plan
from .tool_registry import tool_definitions


class RequestSizeTests(SimpleTestCase):
    def test_registry_sent_once_with_smaller_size_and_all_available_schemas(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            full = tool_definitions()
        compact = provider_tool_definitions(full)
        before = len(PLANNER_PROMPT + json.dumps(full) + json.dumps({"tool_definitions": full}))
        after = len(PLANNER_PROMPT + json.dumps({"tool_definitions": compact}, separators=(",", ":")))
        self.assertLess(after, before * .65)
        for original, transmitted in zip(full, compact):
            self.assertEqual(original["name"], transmitted["name"])
            self.assertNotIn("executor", transmitted)
            if original["available"]:
                self.assertEqual(original["arguments"], transmitted["arguments"])
            else:
                self.assertEqual(original["unavailable_reason"], transmitted["unavailable_reason"])

    def test_wire_payload_preserves_brief_and_result_ids_without_registry_duplication(self):
        captured = []
        def send(request, **kwargs):
            payload = json.loads(request.data)
            context = json.loads(payload["contents"][0]["parts"][0]["text"])
            captured.append((payload, context))
            response = mock.MagicMock()
            response.__enter__.return_value.read.return_value = json.dumps({"candidates": [{"content": {"parts": [{"text": json.dumps({"status": "done", "calls": []})}]}}]}).encode()
            return response
        brief = {"subject": "AI college", "audience": "college students", "key_message": "Learn faster", "duration_seconds": 30, "format": "16:9"}
        receipts = [{"id": "split", "name": "split_clip", "status": "success", "output": {"clip_ids": ["real-a", "real-b"]}}]
        with mock.patch.dict(os.environ, {"AI_PROVIDER": "google", "AI_API_KEY": "test", "AI_MODEL": "test"}, clear=True), mock.patch("composer.ai_agent.urllib.request.urlopen", side_effect=send):
            request_plan({"prompt": "Finish", "composition": {}, "brief": brief, "tool_results": receipts})
        payload, context = captured[0]
        self.assertEqual(context["brief"], brief)
        self.assertEqual(context["tool_results"], receipts)
        self.assertNotIn('"additionalProperties"', payload["systemInstruction"]["parts"][0]["text"])
        self.assertIn("tool_definitions", context)

    def test_google_413_is_actionable_and_not_retried(self):
        error = urllib.error.HTTPError("https://example.invalid", 413, "Too large", {}, None)
        with mock.patch.dict(os.environ, {"AI_PROVIDER": "google", "AI_API_KEY": "test", "AI_MODEL": "test"}, clear=True), mock.patch("composer.ai_agent.urllib.request.urlopen", side_effect=error) as send:
            with self.assertRaisesRegex(ai_agent.ProviderRequestError, "too large.*413") as raised:
                ai_agent.request_editing_actions("Edit", {}, None, [])
            self.assertNotIn("API key", str(raised.exception))
            send.assert_called_once()

    def test_openai_compatible_413_is_actionable(self):
        error = Exception("Upstream payload with secret details")
        error.response = mock.Mock(status_code=413)
        with mock.patch.dict(os.environ, {"AI_PROVIDER": "openai", "AI_API_KEY": "test", "AI_MODEL": "test"}, clear=True), mock.patch("openai.OpenAI") as client:
            client.return_value.chat.completions.create.side_effect = error
            with self.assertRaisesRegex(ai_agent.ProviderRequestError, "too large.*413") as raised:
                ai_agent.request_editing_actions("Edit", {}, None, [])
            self.assertNotIn("secret", str(raised.exception))
            client.return_value.chat.completions.create.assert_called_once()
