import json
import os
from unittest import mock
from django.test import TestCase
from .tool_registry import tool_definitions, validate_call
from .planner import request_plan


class AgentModeTests(TestCase):
    def test_edit_mode_disables_planning_and_generation(self):
        tools = {tool['name']: tool for tool in tool_definitions(mode='edit')}
        self.assertTrue(tools['trim_clip']['available'])
        for name in ('plan_scenes', 'generate_video', 'generate_image', 'text_to_speech'):
            self.assertFalse(tools[name]['available'])
        with self.assertRaises(ValueError):
            validate_call({'id': 'a', 'name': 'plan_scenes', 'arguments': {}}, mode='edit')

    def test_generation_requires_configuration_and_opt_in(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            tools = {t['name']: t for t in tool_definitions(mode='plan', generate_assets=True)}
            self.assertFalse(tools['generate_video']['configured'])
            self.assertFalse(tools['generate_video']['available'])
        with mock.patch.dict(os.environ, {'VIDEO_GENERATION_SERVICE_URL': 'https://gateway.example/', 'VIDEO_GENERATION_API_KEY': 'test'}):
            tools = {t['name']: t for t in tool_definitions(mode='plan')}
            self.assertTrue(tools['generate_video']['configured'])
            self.assertFalse(tools['generate_video']['available'])
            enabled = {t['name']: t for t in tool_definitions(mode='plan', generate_assets=True)}
            self.assertTrue(enabled['generate_video']['available'])

    def test_edit_request_does_not_start_promotional_brief_collection(self):
        def provider(*args, **kwargs):
            self.assertEqual(kwargs['planner_context']['mode'], 'edit')
            self.assertIn('MODE: Edit Video', kwargs['system_override'])
            return kwargs['response_parser'](json.dumps({'status': 'unavailable', 'calls': [], 'message': 'Switch to Plan New Video for a new idea.'}))
        with mock.patch('composer.planner.request_editing_actions', side_effect=provider):
            result = request_plan({'mode': 'edit', 'prompt': 'Create a promotional video', 'composition': {}})
        self.assertEqual(result['status'], 'unavailable')
        self.assertIsNone(result['goal_kind'])

    def test_plan_mode_collects_brief_for_non_promotional_topic(self):
        with mock.patch('composer.planner.request_editing_actions') as provider:
            provider.side_effect = lambda *args, **kw: kw['response_parser'](json.dumps({'status': 'clarify', 'calls': [], 'message': 'What topic?'}))
            result = request_plan({'mode': 'plan', 'prompt': 'A documentary about college AI', 'composition': {}})
        self.assertEqual(result['pending_clarification']['field'], 'subject')
        self.assertEqual(result['brief']['duration_seconds'], 30)

    def test_tools_endpoint_respects_mode(self):
        response = self.client.get('/api/ai/tools/?mode=edit')
        self.assertEqual(response.status_code, 200)
        tools = {t['name']: t for t in response.json()['tools']}
        self.assertFalse(tools['plan_scenes']['available'])
        self.assertEqual(self.client.get('/api/ai/tools/?mode=unknown').status_code, 400)
