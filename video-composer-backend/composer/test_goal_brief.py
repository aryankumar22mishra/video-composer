import json
import os
from unittest import mock
from django.test import TestCase
from .goal_brief import goal_context, merge_brief
from .planner import request_plan


class PromotionalBriefTests(TestCase):
    def test_creation_worded_subject_reply_preserves_goal_and_discards_speculative_calls(self):
        with mock.patch("composer.planner.request_editing_actions") as provider:
            provider.side_effect = lambda *args, **kw: kw["response_parser"](json.dumps({
                "status": "clarify", "message": "Who is this for?", "calls": [{"name": "generate_video", "arguments": {}}],
            }))
            result = request_plan({"prompt": "Create a promotional video about AI for college, 30 seconds",
                "composition": {}, "goal_id": "existing-goal", "goal_kind": "promotional_video",
                "brief": {"format": "9:16"}, "pending_clarification": {"field": "subject", "question": "What subject?"}})
        self.assertEqual(result["goal_id"], "existing-goal")
        self.assertEqual(result["brief"]["subject"], "AI for college")
        self.assertEqual(result["brief"]["duration_seconds"], 30)
        self.assertEqual(result["brief"]["format"], "9:16")
        self.assertEqual(result["pending_clarification"]["field"], "audience")
        self.assertEqual(result["calls"], [])

    def test_exact_conversation_reaches_provider_with_brief_and_only_asks_for_missing_message(self):
        captured = []

        def provider_http(request, **kwargs):
            context = json.loads(json.loads(request.data)["contents"][0]["parts"][0]["text"])
            captured.append(context)
            # Intentionally simulate the previous bug: the text model repeatedly
            # asks for audience and returns null for known fields. The backend
            # merge and clarification policy must still produce the right next question.
            plan = {"status": "clarify", "calls": [], "message": "Who is the audience?",
                    "brief_update": {"audience": None, "duration_seconds": None}}
            response = mock.MagicMock()
            response.__enter__.return_value.read.return_value = json.dumps({"candidates": [{"content": {"parts": [{"text": json.dumps(plan)}]}}]}).encode()
            return response

        goal = {"brief": {}, "pending_clarification": None}
        history = []
        messages = ["Create a short promotional video.", "AI video for college, 30 seconds.", "College students."]
        with mock.patch.dict(os.environ, {"AI_PROVIDER": "google", "AI_MODEL": "test", "AI_API_KEY": "test"}, clear=True), mock.patch("composer.ai_agent.urllib.request.urlopen", side_effect=provider_http):
            for message in messages:
                history.append({"role": "user", "content": message})
                response = self.client.post("/api/ai/plan/", {**goal, "prompt": message, "history": history,
                    "round": 0, "composition": {"width": 1280, "height": 720}}, content_type="application/json")
                self.assertEqual(response.status_code, 200, response.content)
                result = response.json()
                goal = {key: result[key] for key in ("brief", "goal_id", "goal_kind", "pending_clarification")}
                history.append({"role": "assistant", "content": result["message"]})
        self.assertEqual(result["brief"]["audience"], "college students")
        self.assertEqual(result["brief"]["duration_seconds"], 30)
        self.assertEqual(result["brief"]["subject"], "AI video for college")
        self.assertEqual(result["pending_clarification"]["field"], "key_message")
        self.assertEqual(result["message"], "What key message should college students take away?")
        self.assertEqual(captured[2]["brief"], result["brief"])
        self.assertEqual(captured[2]["pending_clarification"]["field"], "audience")
        self.assertEqual(len(captured[2]["history"]), 5)
        self.assertEqual(captured[1]["brief"]["duration_seconds"], 30)

    def test_complete_brief_proceeds_to_scene_plan_without_optional_questions(self):
        contexts = []
        def provider(*args, **kwargs):
            contexts.append(kwargs["planner_context"])
            plan = {"status": "continue", "calls": [{"id": "scenes", "name": "plan_scenes", "arguments": {
                "title": "AI for college", "scenes": [{"description": "AI helps students learn", "duration": 30}]
            }}]}
            return kwargs["response_parser"](json.dumps(plan))
        with mock.patch("composer.planner.request_editing_actions", side_effect=provider):
            result = request_plan({"prompt": "AI helps students learn.", "composition": {}, "goal_kind": "promotional_video",
                "brief": {"subject": "AI for college", "audience": "college students", "duration_seconds": 30},
                "pending_clarification": {"field": "key_message", "question": "What key message?"}})
        self.assertEqual(result["calls"][0]["name"], "plan_scenes")
        self.assertEqual(result["brief"]["key_message"], "AI helps students learn")
        self.assertEqual(result["brief"]["format"], "16:9")
        self.assertEqual(len(contexts), 1)

    def test_correction_and_new_goal_do_not_mix_fields(self):
        original = {"subject": "College AI", "audience": "college students", "duration_seconds": 30, "format": "16:9"}
        data = {"goal_id": "old", "goal_kind": "promotional_video", "brief": original, "composition": {},
                "pending_clarification": {"field": "key_message"}}
        corrected = goal_context({**data, "prompt": "Actually, make the video 45 seconds."})
        self.assertEqual(corrected["brief"], {**original, "key_message": None, "duration_seconds": 45})
        self.assertEqual(goal_context({**data, "prompt": "Make the video 45 seconds."})["brief"], corrected["brief"])
        audience = goal_context({**data, "prompt": "The audience is teachers."})
        self.assertEqual(audience["brief"], {**original, "key_message": None, "audience": "teachers"})
        self.assertEqual(merge_brief(original, {"audience": None, "duration_seconds": None})["audience"], "college students")
        fresh = goal_context({**data, "prompt": "Create a new promotional video for a bakery."})
        self.assertNotEqual(fresh["goal_id"], "old")
        self.assertIsNone(fresh["brief"]["audience"])
        self.assertIsNone(fresh["pending_clarification"])

    def test_complete_brief_repairs_repeated_question_once_and_retains_brief(self):
        contexts = []
        def provider(*args, **kwargs):
            contexts.append(kwargs["planner_context"])
            return kwargs["response_parser"](json.dumps({"status": "clarify", "calls": [], "message": "Who is the audience?"}))
        with mock.patch("composer.planner.request_editing_actions", side_effect=provider):
            result = request_plan({"prompt": "AI helps students learn.", "composition": {}, "goal_kind": "promotional_video",
                "brief": {"subject": "AI", "audience": "college students", "key_message": "AI helps students learn"}})
        self.assertEqual(len(contexts), 2)
        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(contexts[1]["brief"]["audience"], "college students")
        self.assertIsNone(result["pending_clarification"])

    def test_approved_scene_plan_does_not_restart_briefing_for_later_edits(self):
        with mock.patch("composer.planner.request_editing_actions") as provider:
            provider.side_effect = lambda *args, **kw: kw["response_parser"](json.dumps({"status": "done", "calls": []}))
            result = request_plan({"prompt": "Make it quieter", "composition": {}, "goal_kind": "promotional_video", "scene_plan_approved": True,
                "brief": {"subject": "AI", "audience": "college students", "key_message": "Learn faster"}})
            self.assertEqual(provider.call_count, 1)
            self.assertEqual(result["status"], "done")
