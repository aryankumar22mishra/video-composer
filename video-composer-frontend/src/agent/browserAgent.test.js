import test from 'node:test'
import assert from 'node:assert/strict'
import { createBrowserAgent } from './browserAgent.js'

test('paid execution requires a separate user approval after preparation', async (t) => {
  const requests = [], reviews = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options })
    return { ok: true, json: async () => url.includes('prepare') ? { approval_token: 'bound-token', provider: 'gateway.example', cost_notice: 'One credit' } : { asset_id: 'real' } }
  })
  const call = { id: 'one', name: 'generate_image', arguments: { prompt: 'Coffee', width: 1280, height: 720 } }
  const declined = createBrowserAgent({ context: () => ({ recordingState: 'idle' }), assertFresh: () => {}, review: async (details) => { reviews.push(details); return false } })
  await assert.rejects(declined.io.service(call, null), /declined/)
  assert.equal(requests.length, 1)
  assert.ok(requests[0].url.endsWith('/media/prepare/'))
  assert.equal(reviews[0].kind, 'charge')
  const approved = createBrowserAgent({ context: () => ({ recordingState: 'idle' }), assertFresh: () => {}, review: async () => true })
  await approved.io.service(call, null)
  assert.equal(requests.length, 3)
  assert.equal(requests[2].options.body.get('approval_token'), 'bound-token')
})

test('stale approval never submits the paid job', async (t) => {
  let fetches = 0
  t.mock.method(globalThis, 'fetch', async () => { fetches += 1; return { ok: true, json: async () => ({ approval_token: 'token' }) } })
  const agent = createBrowserAgent({ context: () => ({}), review: async () => true, assertFresh: () => { throw new Error('Stale') } })
  await assert.rejects(agent.io.service({ id: 'a', name: 'generate_image', arguments: {} }, null), /Stale/)
  assert.equal(fetches, 1)
})

test('capability request sends the current recording state without corrupting the query', async (t) => {
  let requested
  t.mock.method(globalThis, 'fetch', async (url) => { requested = url; return { ok: true, json: async () => ({ tools: [] }) } })
  const agent = createBrowserAgent({ context: () => ({ recordingState: 'recording' }) })
  await agent.io.tools()
  assert.equal(requested, '/api/ai/tools/?recording_state=recording')
})
