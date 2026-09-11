"""Tests for composer.ai_agent."""
import json
import os
from unittest import mock

from django.test import TestCase, override_settings

from composer import ai_agent


class IdentifierTests(TestCase):
    """Tests for ai_agent._identifier."""

    def test_valid_string_identifier(self):
        self.assertTrue(ai_agent._identifier("clip-123"))

    def test_empty_string_is_invalid(self):
        self.assertFalse(ai_agent._identifier(""))

    def test_non_string_is_invalid(self):
        self.assertFalse(ai_agent._identifier(123))
        self.assertFalse(ai_agent._identifier(None))
        self.assertFalse(ai_agent._identifier([]))

    def test_whitespace_only_is_invalid(self):
        self.assertFalse(ai_agent._identifier("   "))


class NumberTests(TestCase):
    """Tests for ai_agent._number."""

    def test_valid_integer(self):
        action = {"duration": 5}
        self.assertEqual(ai_agent._number(action, "duration", positive=True), 5)

    def test_valid_float(self):
        action = {"speed": 1.5}
        self.assertEqual(ai_agent._number(action, "speed", positive=True), 1.5)

    def test_boolean_is_rejected(self):
        action = {"volume": True}
        with self.assertRaises(ValueError):
            ai_agent._number(action, "volume")

    def test_non_numeric_is_rejected(self):
        action = {"duration": "abc"}
        with self.assertRaises(ValueError):
            ai_agent._number(action, "duration")

    def test_none_is_rejected(self):
        action = {"duration": None}
        with self.assertRaises(ValueError):
            ai_agent._number(action, "duration")

    def test_inf_is_rejected(self):
        action = {"duration": float("inf")}
        with self.assertRaises(ValueError):
            ai_agent._number(action, "duration")

    def test_nan_is_rejected(self):
        action = {"duration": float("nan")}
        with self.assertRaises(ValueError):
            ai_agent._number(action, "duration")

    def test_minimum_constraint(self):
        action = {"volume": -0.1}
        with self.assertRaises(ValueError):
            ai_agent._number(action, "volume", minimum=0)

    def test_maximum_constraint(self):
        action = {"volume": 1.1}
        with self.assertRaises(ValueError):
            ai_agent._number(action, "volume", maximum=1)

    def test_positive_constraint_rejects_zero(self):
        action = {"speed": 0}
        with self.assertRaises(ValueError):
            ai_agent._number(action, "speed", positive=True)

    def test_positive_constraint_allows_positive(self):
        action = {"speed": 0.5}
        self.assertEqual(ai_agent._number(action, "speed", positive=True), 0.5)

    def test_integer_constraint_rejects_float(self):
        action = {"width": 1080.5}
        with self.assertRaises(ValueError):
            ai_agent._number(action, "width", integer=True)

    def test_integer_constraint_accepts_whole_float(self):
        action = {"width": 1080.0}
        self.assertEqual(ai_agent._number(action, "width", integer=True), 1080)
        self.assertIsInstance(action["width"], int)


class ExtractJsonTests(TestCase):
    """Tests for ai_agent._extract_json."""

    def test_plain_json_object(self):
        result = ai_agent._extract_json('{"actions":[]}')
        self.assertEqual(result, {"actions": []})

    def test_plain_json_array(self):
        result = ai_agent._extract_json('[1, 2, 3]')
        self.assertEqual(result, [1, 2, 3])

    def test_json_in_code_block(self):
        content = "```json\n{\"actions\":[]}\n```"
        result = ai_agent._extract_json(content)
        self.assertEqual(result, {"actions": []})

    def test_json_in_unlabeled_code_block(self):
        content = "```\n{\"actions\":[]}\n```"
        result = ai_agent._extract_json(content)
        self.assertEqual(result, {"actions": []})

    def test_empty_string_raises(self):
        with self.assertRaises(ValueError):
            ai_agent._extract_json("")

    def test_whitespace_only_raises(self):
        with self.assertRaises(ValueError):
            ai_agent._extract_json("   ")

    def test_non_string_raises(self):
        with self.assertRaises(ValueError):
            ai_agent._extract_json(None)
        with self.assertRaises(ValueError):
            ai_agent._extract_json(123)

    def test_malformed_json_raises(self):
        with self.assertRaises(ValueError):
            ai_agent._extract_json('{"actions":')

    def test_incomplete_code_block_raises(self):
        with self.assertRaises(ValueError):
            ai_agent._extract_json("```json\n{\"actions\":[]}")

    def test_unterminated_code_block_raises(self):
        with self.assertRaises(ValueError):
            ai_agent._extract_json("```\n{\"actions\":[]}")


class SettingTests(TestCase):
    """Tests for ai_agent._setting."""

    def test_returns_value_when_set(self):
        with mock.patch.dict(os.environ, {"AI_PROVIDER": "google"}, clear=False):
            self.assertEqual(ai_agent._setting("AI_PROVIDER"), "google")

    def test_strips_whitespace(self):
        with mock.patch.dict(os.environ, {"AI_PROVIDER": "  openai  "}, clear=False):
            self.assertEqual(ai_agent._setting("AI_PROVIDER"), "openai")

    def test_returns_default_when_unset(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(ai_agent._setting("AI_MISSING_VAR", "default"), "default")

    def test_returns_none_when_unset_and_no_default(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(ai_agent._setting("AI_MISSING_VAR"))


class EnabledToolsTests(TestCase):
    """Tests for ai_agent._enabled_tools."""

    def test_default_enabled_tools(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            tools = ai_agent._enabled_tools()
            self.assertEqual(tools, ai_agent.SUPPORTED_TOOLS)

    def test_extra_tools_added(self):
        with mock.patch.dict(os.environ, {"AI_EXTRA_TOOLS": "open_recording_setup,stop_recording"}, clear=True):
            tools = ai_agent._enabled_tools()
            self.assertEqual(tools, ai_agent.SUPPORTED_TOOLS | {"open_recording_setup", "stop_recording"})

    def test_unknown_extra_tools_rejected(self):
        with mock.patch.dict(os.environ, {"AI_EXTRA_TOOLS": "bogus_tool"}, clear=True):
            with self.assertRaises(ai_agent.ProviderConfigurationError):
                ai_agent._enabled_tools()

    def test_duplicate_extra_tools_deduplicated(self):
        with mock.patch.dict(os.environ, {"AI_EXTRA_TOOLS": "open_recording_setup,open_recording_setup"}, clear=True):
            tools = ai_agent._enabled_tools()
            self.assertEqual(tools, ai_agent.SUPPORTED_TOOLS | {"open_recording_setup"})

    def test_empty_extra_tools(self):
        with mock.patch.dict(os.environ, {"AI_EXTRA_TOOLS": ""}, clear=True):
            tools = ai_agent._enabled_tools()
            self.assertEqual(tools, ai_agent.SUPPORTED_TOOLS)


class ValidateAgentResponseTests(TestCase):
    """Tests for ai_agent.validate_agent_response."""

    def setUp(self):
        self.enabled_tools = ai_agent.SUPPORTED_TOOLS

    def test_valid_empty_actions_with_summary(self):
        payload = {"actions": [], "summary": "Nothing to do."}
        result = ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)
        self.assertEqual(result["actions"], [])
        self.assertEqual(result["summary"], "Nothing to do.")
        self.assertIsNone(result["clarification"])

    def test_valid_actions_returned(self):
        payload = {
            "actions": [{"type": "set_dimensions", "width": 1920, "height": 1080}],
            "summary": "Set dimensions.",
            "clarification": None,
        }
        result = ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)
        self.assertEqual(len(result["actions"]), 1)
        self.assertEqual(result["actions"][0]["type"], "set_dimensions")

    def test_non_dict_payload_rejected(self):
        with self.assertRaises(ValueError):
            ai_agent.validate_agent_response([], enabled_tools=self.enabled_tools)

    def test_actions_not_list_rejected(self):
        payload = {"actions": "not-a-list", "summary": "x"}
        with self.assertRaises(ValueError):
            ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)

    def test_too_many_actions_rejected(self):
        payload = {"actions": [{"type": "set_dimensions", "width": 2, "height": 2}] * 21, "summary": "x"}
        with self.assertRaises(ValueError):
            ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)

    def test_summary_not_string_rejected(self):
        payload = {"actions": [], "summary": 123}
        with self.assertRaises(ValueError):
            ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)

    def test_clarification_must_be_string_or_null(self):
        payload = {"actions": [], "summary": "x", "clarification": 123}
        with self.assertRaises(ValueError):
            ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)

    def test_clarification_with_actions_rejected(self):
        payload = {
            "actions": [{"type": "set_dimensions", "width": 2, "height": 2}],
            "summary": "x",
            "clarification": "Which clip?",
        }
        with self.assertRaises(ValueError):
            ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)

    def test_empty_everything_rejected(self):
        payload = {"actions": [], "summary": "", "clarification": None}
        with self.assertRaises(ValueError):
            ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)

    def test_non_dict_action_rejected(self):
        payload = {"actions": ["not-a-dict"], "summary": "x"}
        with self.assertRaises(ValueError):
            ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)

    def test_unsupported_action_type_rejected(self):
        payload = {"actions": [{"type": "bogus_tool"}], "summary": "x"}
        with self.assertRaises(ValueError):
            ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)

    def test_disabled_optional_tool_rejected(self):
        payload = {"actions": [{"type": "open_recording_setup"}], "summary": "x"}
        with self.assertRaises(ValueError):
            ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)

    def test_unexpected_fields_rejected(self):
        payload = {"actions": [{"type": "trim_clip", "clip_id": "c1", "duration": 5, "bogus": 1}], "summary": "x"}
        with self.assertRaises(ValueError):
            ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)

    def test_missing_required_field_rejected(self):
        payload = {"actions": [{"type": "trim_clip", "duration": 5}], "summary": "x"}
        with self.assertRaises(ValueError):
            ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)

    def test_invalid_clip_id_rejected(self):
        payload = {"actions": [{"type": "trim_clip", "clip_id": "", "duration": 5}], "summary": "x"}
        with self.assertRaises(ValueError):
            ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)

    def test_invalid_text_id_rejected(self):
        payload = {"actions": [{"type": "update_text", "text_id": 123, "content": "hello"}], "summary": "x"}
        with self.assertRaises(ValueError):
            ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)

    def test_text_content_too_long_rejected(self):
        payload = {"actions": [{"type": "add_text", "content": "x" * 5001}], "summary": "x"}
        with self.assertRaises(ValueError):
            ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)

    def test_text_content_non_string_rejected(self):
        payload = {"actions": [{"type": "add_text", "content": 123}], "summary": "x"}
        with self.assertRaises(ValueError):
            ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)

    def test_trim_clip_valid(self):
        payload = {"actions": [{"type": "trim_clip", "clip_id": "c1", "duration": 10}], "summary": "x"}
        result = ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)
        self.assertEqual(result["actions"][0]["duration"], 10)

    def test_split_clip_valid(self):
        payload = {"actions": [{"type": "split_clip", "clip_id": "c1", "at_seconds": 5.5}], "summary": "x"}
        self.assertEqual(ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)["actions"][0]["at_seconds"], 5.5)

    def test_split_clip_zero_seconds_rejected(self):
        payload = {"actions": [{"type": "split_clip", "clip_id": "c1", "at_seconds": 0}], "summary": "x"}
        with self.assertRaises(ValueError):
            ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)

    def test_reorder_clips_valid(self):
        payload = {"actions": [{"type": "reorder_clips", "clip_ids": ["a", "b", "c"]}], "summary": "x"}
        result = ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)
        self.assertEqual(result["actions"][0]["clip_ids"], ["a", "b", "c"])

    def test_reorder_clips_empty_list_rejected(self):
        payload = {"actions": [{"type": "reorder_clips", "clip_ids": []}], "summary": "x"}
        with self.assertRaises(ValueError):
            ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)

    def test_reorder_clips_duplicates_rejected(self):
        payload = {"actions": [{"type": "reorder_clips", "clip_ids": ["a", "a"]}], "summary": "x"}
        with self.assertRaises(ValueError):
            ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)

    def test_reorder_clips_non_string_id_rejected(self):
        payload = {"actions": [{"type": "reorder_clips", "clip_ids": [1, 2]}], "summary": "x"}
        with self.assertRaises(ValueError):
            ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)

    def test_set_speed_valid(self):
        payload = {"actions": [{"type": "set_speed", "clip_id": "c1", "speed": 1.5}], "summary": "x"}
        result = ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)
        self.assertEqual(result["actions"][0]["speed"], 1.5)

    def test_set_speed_zero_rejected(self):
        payload = {"actions": [{"type": "set_speed", "clip_id": "c1", "speed": 0}], "summary": "x"}
        with self.assertRaises(ValueError):
            ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)

    def test_set_volume_valid(self):
        payload = {"actions": [{"type": "set_volume", "clip_id": "c1", "volume": 0.5}], "summary": "x"}
        result = ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)
        self.assertEqual(result["actions"][0]["volume"], 0.5)

    def test_set_volume_above_1_rejected(self):
        payload = {"actions": [{"type": "set_volume", "clip_id": "c1", "volume": 1.5}], "summary": "x"}
        with self.assertRaises(ValueError):
            ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)

    def test_set_volume_negative_rejected(self):
        payload = {"actions": [{"type": "set_volume", "clip_id": "c1", "volume": -0.1}], "summary": "x"}
        with self.assertRaises(ValueError):
            ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)

    def test_set_dimensions_valid(self):
        payload = {"actions": [{"type": "set_dimensions", "width": 1920, "height": 1080}], "summary": "x"}
        result = ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)
        self.assertEqual(result["actions"][0]["width"], 1920)
        self.assertEqual(result["actions"][0]["height"], 1080)

    def test_set_dimensions_odd_rejected(self):
        payload = {"actions": [{"type": "set_dimensions", "width": 1921, "height": 1080}], "summary": "x"}
        with self.assertRaises(ValueError):
            ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)

    def test_set_dimensions_too_small_rejected(self):
        payload = {"actions": [{"type": "set_dimensions", "width": 1, "height": 1080}], "summary": "x"}
        with self.assertRaises(ValueError):
            ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)

    def test_set_dimensions_too_large_rejected(self):
        payload = {"actions": [{"type": "set_dimensions", "width": 4000, "height": 1080}], "summary": "x"}
        with self.assertRaises(ValueError):
            ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)

    def test_set_grayscale_valid(self):
        payload = {"actions": [{"type": "set_grayscale", "clip_id": "c1", "enabled": True}], "summary": "x"}
        result = ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)
        self.assertTrue(result["actions"][0]["enabled"])

    def test_set_grayscale_non_bool_rejected(self):
        payload = {"actions": [{"type": "set_grayscale", "clip_id": "c1", "enabled": "yes"}], "summary": "x"}
        with self.assertRaises(ValueError):
            ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)

    def test_keep_clip_range_valid(self):
        payload = {"actions": [{"type": "keep_clip_range", "clip_id": "c1", "start_seconds": 2, "end_seconds": 5}], "summary": "x"}
        result = ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)
        self.assertEqual(result["actions"][0]["start_seconds"], 2)

    def test_remove_clip_range_valid(self):
        payload = {"actions": [{"type": "remove_clip_range", "clip_id": "c1", "start_seconds": 0, "end_seconds": 3}], "summary": "x"}
        self.assertIn("start_seconds", ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)["actions"][0])

    def test_range_end_before_start_rejected(self):
        payload = {"actions": [{"type": "keep_clip_range", "clip_id": "c1", "start_seconds": 5, "end_seconds": 2}], "summary": "x"}
        with self.assertRaises(ValueError):
            ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)

    def test_range_end_equals_start_rejected(self):
        payload = {"actions": [{"type": "keep_clip_range", "clip_id": "c1", "start_seconds": 3, "end_seconds": 3}], "summary": "x"}
        with self.assertRaises(ValueError):
            ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)

    def test_add_text_valid_without_start_duration(self):
        payload = {"actions": [{"type": "add_text", "content": "Hello"}], "summary": "x"}
        result = ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)
        self.assertEqual(result["actions"][0]["content"], "Hello")

    def test_add_text_valid_with_start_duration(self):
        payload = {"actions": [{"type": "add_text", "content": "Hello", "start_time": 2, "duration": 3}], "summary": "x"}
        result = ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)
        self.assertEqual(result["actions"][0]["start_time"], 2)

    def test_update_text_valid(self):
        payload = {"actions": [{"type": "update_text", "text_id": "t1", "content": "New text"}], "summary": "x"}
        result = ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)
        self.assertEqual(result["actions"][0]["content"], "New text")

    def test_stop_recording_rejected_when_not_recording(self):
        payload = {"actions": [{"type": "stop_recording"}], "summary": "x"}
        with self.assertRaises(ValueError):
            ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools, recording_state="idle")

    def test_stop_recording_valid_when_recording(self):
        with mock.patch.dict(os.environ, {"AI_EXTRA_TOOLS": "stop_recording"}, clear=True):
            enabled = ai_agent._enabled_tools()
            payload = {"actions": [{"type": "stop_recording"}], "summary": "x"}
            result = ai_agent.validate_agent_response(payload, enabled_tools=enabled, recording_state="recording")
            self.assertEqual(result["actions"], [{"type": "stop_recording"}])

    def test_stop_recording_rejected_when_optional_disabled(self):
        payload = {"actions": [{"type": "stop_recording"}], "summary": "x"}
        with self.assertRaises(ValueError):
                        ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools, recording_state="recording")

    def test_summary_truncated_to_300_chars(self):
        long_summary = "x" * 400
        payload = {"actions": [], "summary": long_summary}
        result = ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)
        self.assertEqual(len(result["summary"]), 300)

    def test_clarification_truncated_to_300_chars(self):
        long_clarification = "q" * 400
        payload = {"actions": [], "summary": "x", "clarification": long_clarification}
        result = ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)
        self.assertEqual(len(result["clarification"]), 300)

    def test_multiple_actions_validated(self):
        payload = {
            "actions": [
                {"type": "trim_clip", "clip_id": "c1", "duration": 5},
                {"type": "set_speed", "clip_id": "c1", "speed": 2},
                {"type": "set_volume", "clip_id": "c1", "volume": 0.8},
            ],
            "summary": "Multiple edits.",
        }
        result = ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)
        self.assertEqual(len(result["actions"]), 3)

    def test_duration_must_be_positive(self):
        payload = {"actions": [{"type": "trim_clip", "clip_id": "c1", "duration": -1}], "summary": "x"}
        with self.assertRaises(ValueError):
            ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)

    def test_start_time_must_be_non_negative(self):
        payload = {"actions": [{"type": "add_text", "content": "hi", "start_time": -1}], "summary": "x"}
        with self.assertRaises(ValueError):
            ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)

    def test_action_with_extra_field_rejected(self):
        payload = {"actions": [{"type": "trim_clip", "clip_id": "c1", "duration": 5}], "summary": "x", "extra": "no"}
        with self.assertRaises(ValueError):
            ai_agent.validate_agent_response(payload, enabled_tools=self.enabled_tools)


class RequestEditingActionsConfigTests(TestCase):
    """Tests for ai_agent.request_editing_actions configuration validation."""

    def test_empty_prompt_raises_provider_response_error(self):
        with self.assertRaises(ai_agent.ProviderResponseError):
            ai_agent.request_editing_actions("", {}, None, [])

    def test_whitespace_prompt_raises_provider_response_error(self):
        with self.assertRaises(ai_agent.ProviderResponseError):
            ai_agent.request_editing_actions("   ", {}, None, [])

    def test_non_string_prompt_raises_provider_response_error(self):
        with self.assertRaises(ai_agent.ProviderResponseError):
            ai_agent.request_editing_actions(123, {}, None, [])

    def test_non_dict_composition_raises_response_error(self):
        with self.assertRaises(ai_agent.ProviderResponseError):
            ai_agent.request_editing_actions("test", None, None, [])

    def test_non_list_history_raises_response_error(self):
        with self.assertRaises(ai_agent.ProviderResponseError):
            ai_agent.request_editing_actions("test", {}, None, [], history="not-a-list")

    def test_missing_api_key_raises_configuration_error(self):
        env = {"AI_PROVIDER": "google", "AI_MODEL": "gemini-flash"}
        with mock.patch.dict(os.environ, env, clear=True):
            with self.assertRaises(ai_agent.ProviderConfigurationError):
                ai_agent.request_editing_actions("test", {}, None, [])

    def test_missing_model_raises_configuration_error(self):
        env = {"AI_PROVIDER": "google", "AI_API_KEY": "test-key"}
        with mock.patch.dict(os.environ, env, clear=True):
            with self.assertRaises(ai_agent.ProviderConfigurationError):
                ai_agent.request_editing_actions("test", {}, None, [])

    def test_invalid_provider_raises_configuration_error(self):
        env = {"AI_PROVIDER": "invalid", "AI_API_KEY": "key", "AI_MODEL": "model"}
        with mock.patch.dict(os.environ, env, clear=True):
            with self.assertRaises(ai_agent.ProviderConfigurationError):
                ai_agent.request_editing_actions("test", {}, None, [])


class ParseResponseTests(TestCase):
    """Tests for ai_agent._parse_response wrapping validation errors."""

    def test_valid_response_parsed_successfully(self):
        content = json.dumps({"actions": [], "summary": "ok", "clarification": None})
        result = ai_agent._parse_response(content, ai_agent.SUPPORTED_TOOLS, "idle")
        self.assertEqual(result["summary"], "ok")

    def test_malformed_json_raises_provider_response_error(self):
        content = '{"actions":'
        with self.assertRaises(ai_agent.ProviderResponseError):
            ai_agent._parse_response(content, ai_agent.SUPPORTED_TOOLS, "idle")

    def test_validation_error_wrapped_as_provider_response_error(self):
        content = json.dumps({"actions": [{"type": "bogus_tool"}], "summary": "x"})
        with self.assertRaises(ai_agent.ProviderResponseError):
            ai_agent._parse_response(content, ai_agent.SUPPORTED_TOOLS, "idle")

    def test_empty_content_raises_provider_response_error(self):
        with self.assertRaises(ai_agent.ProviderResponseError):
            ai_agent._parse_response("", ai_agent.SUPPORTED_TOOLS, "idle")

    def test_none_content_raises_provider_response_error(self):
        with self.assertRaises(ai_agent.ProviderResponseError):
            ai_agent._parse_response(None, ai_agent.SUPPORTED_TOOLS, "idle")


class ExceptionHierarchyTests(TestCase):
    """Tests for the custom exception classes."""

    def test_provider_configuration_error_is_exception(self):
        self.assertTrue(issubclass(ai_agent.ProviderConfigurationError, Exception))

    def test_provider_request_error_is_exception(self):
        self.assertTrue(issubclass(ai_agent.ProviderRequestError, Exception))

    def test_provider_response_error_is_exception(self):
        self.assertTrue(issubclass(ai_agent.ProviderResponseError, Exception))

    def test_exceptions_are_distinct(self):
        self.assertFalse(issubclass(ai_agent.ProviderConfigurationError, ai_agent.ProviderRequestError))
        self.assertFalse(issubclass(ai_agent.ProviderResponseError, ai_agent.ProviderConfigurationError))


class SystemPromptTests(TestCase):
    """Tests for the SYSTEM_PROMPT content."""

    def test_system_prompt_contains_required_directives(self):
        self.assertIn("video editor", ai_agent.SYSTEM_PROMPT)

    def test_system_prompt_demands_json_output(self):
        self.assertIn("{\"actions\":[],\"summary\":\"\",\"clarification\":null}", ai_agent.SYSTEM_PROMPT)

    def test_system_prompt_mentions_supported_action_types(self):
        self.assertIn("trim_clip", ai_agent.SYSTEM_PROMPT)
        self.assertIn("set_dimensions", ai_agent.SYSTEM_PROMPT)

    def test_action_fields_coverage(self):
        for tool in ai_agent.SUPPORTED_TOOLS:
            self.assertIn(tool, ai_agent.ACTION_FIELDS)

    def test_supported_tools_subset_of_action_fields(self):
        for tool in ai_agent.SUPPORTED_TOOLS:
            self.assertIn(tool, ai_agent.ACTION_FIELDS)
