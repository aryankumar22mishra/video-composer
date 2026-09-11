import test from 'node:test'
import assert from 'node:assert/strict'
import { beginGoalTurn, receiveGoalPlan, mergeBrief } from './goalBrief.js'
import { createBrowserAgent } from './browserAgent.js'
import { createComposition } from '../state/composition.js'

test('exact promotional conversation sends accumulated brief, history and pending clarification on every request', async (t) => {
  const composition = createComposition()
  const prompts = ['Create a short promotional video.', 'AI video for college, 30 seconds.', 'College students.']
  const questions = [
    { field: 'subject', question: 'What subject or product should the promotional video feature?' },
    { field: 'audience', question: 'Who is the promotional video for?' },
    { field: 'key_message', question: 'What key message should college students take away?' },
  ]
  const sent = []
  let goal = null
  const history = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.includes('/tools/')) return { ok: true, json: async () => ({ tools: [] }) }
    assert.equal(url, '/api/ai/plan/')
    const body = JSON.parse(options.body)
    const index = sent.length
    sent.push(body)
    // Mock only provider/backend transport. Real browser request serialization,
    // executor round handling and independent goal state all run here.
    return { ok: true, json: async () => ({ status: 'clarify', calls: [], message: questions[index].question,
      goal_id: body.goal_id, goal_kind: body.goal_kind, brief: body.brief, pending_clarification: questions[index] }) }
  })
  for (const prompt of prompts) {
    goal = beginGoalTurn(goal, prompt, composition)
    history.push({ role: 'user', content: prompt })
    const agent = createBrowserAgent({ context: () => ({ recordingState: 'idle' }), getVersion: () => 1,
      progress: () => {}, onPlan: (plan) => { goal = receiveGoalPlan(goal, plan); return goal },
      commit: () => assert.fail('Clarification must not commit composition edits'),
    })
    const result = await agent.run({ ...goal, prompt, history: [...history], composition, files: [], assets: [] })
    history.push({ role: 'assistant', content: result.message })
  }
  assert.equal(sent[1].brief.subject, 'AI video for college')
  assert.equal(sent[1].brief.duration_seconds, 30)
  assert.equal(sent[2].brief.audience, 'college students')
  assert.equal(sent[2].brief.subject, 'AI video for college')
  assert.equal(sent[2].brief.duration_seconds, 30)
  assert.equal(sent[2].history.length, 5)
  assert.deepEqual(sent[2].pending_clarification, questions[1])
  assert.equal(goal.pending_clarification.field, 'key_message')
  assert.equal(history.at(-1).content, 'What key message should college students take away?')
  assert.equal(new Set(sent.map((body) => body.goal_id)).size, 1)
})

test('corrections replace only the relevant field; omitted/empty fields never erase prior answers', () => {
  const initial = { goal_id: 'one', goal_kind: 'promotional_video', brief: {
    subject: 'AI video for college', audience: 'college students', key_message: null, duration_seconds: 30, format: '16:9',
  }, pending_clarification: { field: 'key_message', question: 'What message?' } }
  const corrected = beginGoalTurn(initial, 'Actually, make the video 45 seconds.', createComposition())
  assert.deepEqual(corrected.brief, { ...initial.brief, duration_seconds: 45 })
  assert.equal(corrected.goal_id, initial.goal_id)
  assert.deepEqual(beginGoalTurn(initial, 'Make the video 45 seconds.', createComposition()).brief, { ...initial.brief, duration_seconds: 45 })
  const audience = beginGoalTurn(initial, 'The audience is teachers.', createComposition())
  assert.deepEqual(audience.brief, { ...initial.brief, audience: 'teachers' })
  assert.deepEqual(mergeBrief(initial.brief, { subject: null, audience: '', duration_seconds: null }), initial.brief)
})

test('a clearly new promotional goal creates a fresh brief and clears the old question', () => {
  const previous = { goal_id: 'old', goal_kind: 'promotional_video', brief: { subject: 'College', audience: 'students', duration_seconds: 45 }, pending_clarification: { field: 'key_message' } }
  const next = beginGoalTurn(previous, 'Create a new promotional video for a bakery.', createComposition())
  assert.notEqual(next.goal_id, previous.goal_id)
  assert.equal(next.brief.subject, null)
  assert.equal(next.brief.audience, null)
  assert.equal(next.brief.duration_seconds, 30)
  assert.equal(next.pending_clarification, null)
})
