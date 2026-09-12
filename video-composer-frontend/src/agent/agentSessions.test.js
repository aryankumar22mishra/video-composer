import test from 'node:test'
import assert from 'node:assert/strict'
import { AGENT_MODES, createAgentSessions, updateAgentSession } from './agentSessions.js'

test('mode switches preserve independent chats, drafts, briefs and generation preference', () => {
  let sessions = createAgentSessions()
  sessions = updateAgentSession(sessions, 'edit', 'draft', 'Trim this clip')
  sessions = updateAgentSession(sessions, 'edit', 'messages', [{ role: 'user', content: 'Add a title' }])
  sessions = updateAgentSession(sessions, 'plan', 'draft', 'A video about college AI')
  sessions = updateAgentSession(sessions, 'plan', 'goal', { brief: { audience: 'students' } })
  sessions = updateAgentSession(sessions, 'plan', 'generateAssets', true)
  sessions = updateAgentSession(sessions, 'plan', 'messages', (messages) => [...messages, { role: 'user', content: 'Plan my video' }])
  assert.equal(sessions.edit.draft, 'Trim this clip')
  assert.equal(sessions.edit.messages[0].content, 'Add a title')
  assert.equal(sessions.edit.goal, null)
  assert.equal(sessions.edit.generateAssets, false)
  assert.equal(sessions.plan.draft, 'A video about college AI')
  assert.equal(sessions.plan.goal.brief.audience, 'students')
  assert.equal(sessions.plan.messages.length, 1)
  assert.notEqual(AGENT_MODES.edit.placeholder, AGENT_MODES.plan.placeholder)
  assert.ok(AGENT_MODES.edit.prompts.includes('Change to 9:16'))
})
