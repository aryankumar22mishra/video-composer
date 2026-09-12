import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentExecutor, LIMITS } from './AgentExecutor.js'
import { TOOL_REGISTRY } from './registry.js'
import { EXECUTORS } from './executors.js'
import { createComposition } from '../state/composition.js'
import { createHistory, recordHistory, restoreHistory } from '../state/compositionHistory.js'
import { receiveGoalPlan } from './goalBrief.js'

const call = (id, name, args, depends_on = []) => ({ id, name, arguments: args, depends_on })
const next = (...calls) => ({ status: 'continue', calls, message: '' })
const done = { status: 'done', calls: [], message: 'MODEL CLAIM THAT MUST NOT BE DISPLAYED' }
function fixture(plans, overrides = {}) {
  const composition = createComposition()
  composition.tracks[0].clips = [{ id: 'clip-1', duration: 10, startTime: 0, fileIndex: 0, fileType: 'video/mp4', speed: 1, sourceStart: 2 }]
  composition.duration = 10
  const commits = [], contexts = []
  let index = 0
  const io = {
    getVersion: () => 1, context: () => ({ recordingState: 'idle' }),
    tools: async () => Object.values(TOOL_REGISTRY).map((t) => ({ ...t, available: true })),
    plan: async (context) => {
      contexts.push(structuredClone(context))
      const plan = plans[index++]
      return typeof plan === 'function' ? plan(context) : plan
    },
    commit: (stage) => commits.push(stage), progress: () => {}, review: async () => true,
    executeUI: async () => 'Opened setup.', releasePreview: () => {}, ...overrides,
  }
  const request = { prompt: 'Edit my video', composition, files: [{ name: 'clip.mp4' }],
    assets: [{ id: 'asset-1', name: 'clip.mp4', type: 'video/mp4', fileIndex: 0, duration: 10, file: { name: 'clip.mp4', type: 'video/mp4' }, approved: true }] }
  return { agent: new AgentExecutor(io), request, commits, contexts, io }
}

test('every advertised tool has a trusted executor', () => {
  for (const tool of Object.values(TOOL_REGISTRY)) assert.equal(typeof EXECUTORS[tool.executor], 'function', tool.name)
})

test('single natural-language edit commits once and reports executor results', async () => {
  const f = fixture([next(call('a', 'set_volume', { clip_id: 'clip-1', volume: .4 })), done])
  f.request.prompt = 'Make it a little quieter'
  const result = await f.agent.run(f.request)
  assert.equal(f.commits.length, 1)
  assert.equal(f.commits[0].composition.tracks[0].clips[0].volume, .4)
  assert.equal(f.request.composition.tracks[0].clips[0].volume, undefined)
  assert.match(result.message, /40%/)
  assert.doesNotMatch(result.message, /MODEL/)
})

test('split results supply real IDs for a dependent editing round and preserve source offsets', async () => {
  const f = fixture([
    next(call('split', 'split_clip', { clip_id: 'clip-1', at_seconds: 4 })),
    (ctx) => {
      const ids = ctx.tool_results[0].output.clip_ids
      assert.equal(ids.length, 2)
      assert.equal(ctx.composition.tracks[0].clips[1].sourceStart, 6)
      return next(call('quiet', 'set_volume', { clip_id: ids[1], volume: 0 }, ['split']))
    }, done,
  ])
  await f.agent.run(f.request)
  assert.equal(f.commits.length, 1)
  assert.equal(f.commits[0].composition.tracks[0].clips[1].volume, 0)
})

test('failure halfway rolls back the entire transaction and returns actual failure feedback', async () => {
  const f = fixture([next(call('a', 'set_grayscale', { clip_id: 'clip-1', enabled: true }), call('b', 'split_clip', { clip_id: 'clip-1', at_seconds: 15 }, ['a'])), done])
  await assert.rejects(f.agent.run(f.request), /split segments/)
  assert.equal(f.commits.length, 0)
  assert.equal(f.request.composition.tracks[0].clips[0].grayscale, undefined)
  assert.equal(f.contexts.at(-1).terminal_failure, true)
  assert.equal(f.contexts.at(-1).tool_results[1].status, 'error')
})

test('duplicate calls execute once; changed payload with same ID is rejected', async () => {
  const action = call('a', 'add_text', { content: 'Hello' })
  const f = fixture([next(action), next(action), done])
  await f.agent.run(f.request)
  assert.equal(f.commits[0].composition.texts.length, 1)
  const bad = fixture([next(action), next(call('a', 'add_text', { content: 'Different' }))])
  await assert.rejects(bad.agent.run(bad.request), /reused/)
  assert.equal(bad.commits.length, 0)
})

test('forward dependencies and unknown tools are rejected before execution', async () => {
  for (const action of [call('a', 'add_text', { content: 'Hello' }, ['future']), call('a', 'run_shell', { command: 'anything' })]) {
    const f = fixture([next(action)])
    await assert.rejects(f.agent.run(f.request), /dependency|Unknown tool/)
    assert.equal(f.commits.length, 0)
  }
})

test('stale responses, including ABA revisions, never commit', async () => {
  let version = 1
  const f = fixture([() => { version = 3; return next(call('a', 'add_text', { content: 'Hello' })) }], { getVersion: () => version })
  await assert.rejects(f.agent.run(f.request), /editor changed/)
  assert.equal(f.commits.length, 0)
})

test('focused clarification and unavailable capability discard staged changes', async () => {
  for (const status of ['clarify', 'unavailable']) {
    const f = fixture([next(call('a', 'add_text', { content: 'Hello' })), { status, calls: [], message: 'Which product should this promote?' }])
    const result = await f.agent.run(f.request)
    assert.equal(result.status, status)
    assert.equal(f.commits.length, 0)
  }
})

test('promotional goal approves scene plan then selects assets and assembles editable clips/text', async () => {
  const reviews = []
  const f = fixture([
    next(call('scenes', 'plan_scenes', { title: 'Coffee launch', scenes: [{ description: 'Show the coffee', duration: 3, asset_id: 'asset-1', text: 'Fresh daily' }] })),
    next(call('append', 'append_asset', { asset_id: 'asset-1', duration: 3 }, ['scenes']), call('title', 'add_text', { content: 'Fresh daily', start_time: 10, duration: 3 }, ['append'])), done,
  ], { review: async (details) => { reviews.push(details); return true } })
  f.request.prompt = 'Create a 3-second coffee promotion for commuters using my uploaded clip'
  await f.agent.run(f.request)
  assert.equal(reviews[0].kind, 'scenes')
  assert.equal(f.commits[0].composition.tracks[0].clips.length, 2)
  assert.equal(f.commits[0].composition.texts[0].content, 'Fresh daily')
})

test('scene plan rejection stops before assembly', async () => {
  const f = fixture([next(call('scenes', 'plan_scenes', { title: 'Plan', scenes: [{ description: 'Opening', duration: 3 }] })), done], { review: async () => false })
  await assert.rejects(f.agent.run(f.request), /declined/)
  assert.equal(f.commits.length, 0)
})

test('generated media is previewed before its ID is exposed and before assembly', async () => {
  const events = []
  const f = fixture([
    next(call('gen', 'generate_image', { prompt: 'Coffee', width: 1280, height: 720 })),
    (ctx) => {
      assert.deepEqual(events, ['service', 'load', 'preview'])
      const assetId = ctx.tool_results[0].output.asset_id
      assert.equal(assetId, 'real-generated-id')
      return next(call('append', 'append_asset', { asset_id: assetId, duration: 3 }, ['gen']))
    }, done,
  ], {
    service: async () => { events.push('service'); return {} },
    loadGenerated: async () => { events.push('load'); return { id: 'real-generated-id', type: 'image/png', name: 'coffee.png', file: { name: 'coffee.png', type: 'image/png' } } },
    review: async () => { events.push('preview'); return true },
  })
  await f.agent.run(f.request)
  assert.equal(f.commits[0].files.length, 2)
  assert.equal(f.commits[0].composition.tracks[0].clips[1].fileIndex, 1)
})

test('media preview rejection or service failure cannot commit prior edits', async () => {
  for (const failService of [true, false]) {
    const f = fixture([next(call('text', 'add_text', { content: 'Hello' }), call('gen', 'generate_image', { prompt: 'Coffee', width: 1280, height: 720 })), done], {
      service: async () => { if (failService) throw new Error('Service failed'); return {} },
      loadGenerated: async () => ({ id: 'generated', type: 'image/png', file: {} }), review: async () => false,
    })
    await assert.rejects(f.agent.run(f.request), /failed|declined/)
    assert.equal(f.commits.length, 0)
  }
})

test('round and tool budgets terminate non-converging plans', async () => {
  const f = fixture(Array.from({ length: LIMITS.rounds }, (_, i) => next(call(`a-${i}`, 'add_text', { content: 'Hello' }))))
  await assert.rejects(f.agent.run(f.request), /round limit/)
  assert.equal(f.commits.length, 0)
  const g = fixture(Array.from({ length: 6 }, (_, i) => next(...Array.from({ length: 6 }, (_, j) => call(`a-${i}-${j}`, 'add_text', { content: 'Hello' })))))
  await assert.rejects(g.agent.run(g.request), /call limit/)
  assert.equal(g.commits.length, 0)
})

test('concurrent run is rejected and cancellation cannot commit', async () => {
  let resolvePlan
  const controller = new AbortController()
  const f = fixture([], { signal: controller.signal, plan: () => new Promise((resolve) => { resolvePlan = resolve }) })
  const first = f.agent.run(f.request)
  await Promise.resolve()
  await assert.rejects(f.agent.run(f.request), /already running/)
  controller.abort()
  resolvePlan(done)
  await assert.rejects(first, /cancelled/)
  assert.equal(f.commits.length, 0)
})

test('multi-step agent edits undo/redo together including background audio; editing after undo retains history', async () => {
  const f = fixture([next(call('a', 'set_volume', { clip_id: 'clip-1', volume: 0 }), call('b', 'add_text', { content: 'Launch' }), call('c', 'set_background_audio', { asset_id: 'voice' })), done])
  f.request.assets.push({ id: 'voice', name: 'voice.wav', type: 'audio/wav', file: {}, approved: true })
  const history = createHistory(f.request.composition)
  await f.agent.run(f.request)
  const committed = f.commits[0].composition
  recordHistory(history, committed)
  assert.equal(history.past.length, 1)
  const previous = restoreHistory(history, 'undo')
  assert.deepEqual(previous, f.request.composition)
  recordHistory(history, previous)
  assert.deepEqual(restoreHistory(history, 'redo'), committed)
  assert.equal(committed.backgroundAudioAssetId, 'voice')
  const undone = restoreHistory(history, 'undo')
  recordHistory(history, { ...undone, width: 640 })
  assert.equal(history.past.length, 1)
  assert.equal(history.future.length, 0)
  assert.deepEqual(restoreHistory(history, 'undo'), f.request.composition)
})

test('repeated generation with another call ID reuses the real result without another service call', async () => {
  let calls = 0
  const args = { prompt: 'Coffee', width: 1280, height: 720 }
  const f = fixture([next(call('one', 'generate_image', args)), next(call('two', 'generate_image', args)), done], {
    service: async () => { calls += 1; return {} },
    loadGenerated: async () => ({ id: 'real', name: 'coffee.png', type: 'image/png', file: {} }),
  })
  await f.agent.run(f.request)
  assert.equal(calls, 1)
  assert.equal(f.commits[0].assets.filter((a) => a.id === 'real').length, 1)
})

test('unavailable service gives the precise reason and never runs', async () => {
  let executed = false
  const f = fixture([next(call('gen', 'generate_image', { prompt: 'Coffee', width: 1280, height: 720 }))], {
    tools: async () => [{ name: 'generate_image', available: false, unavailable_reason: 'Missing IMAGE_GENERATION_SERVICE_URL. Upload an image instead.' }],
    service: async () => { executed = true },
  })
  await assert.rejects(f.agent.run(f.request), /IMAGE_GENERATION_SERVICE_URL/)
  assert.equal(executed, false)
})

test('planner retries are bounded; service calls are never retried after an uncertain failure', async () => {
  let attempts = 0
  const f = fixture([], { plan: async () => { attempts += 1; throw Object.assign(new Error('Busy'), { retryable: true }) } })
  await assert.rejects(f.agent.run(f.request), /Busy/)
  assert.equal(attempts, LIMITS.plannerRetries + 1)
})

test('brief updates survive clarify rollback and reach subsequent execution rounds', async () => {
  let goal = { goal_id: 'college-promo', goal_kind: 'promotional_video', brief: { subject: 'College', duration_seconds: 30 }, pending_clarification: null }
  const f = fixture([
    { ...next(call('a', 'add_text', { content: 'Draft' })), brief: { audience: 'college students' } },
    (ctx) => {
      assert.equal(ctx.brief.audience, 'college students')
      assert.equal(ctx.brief.duration_seconds, 30)
      assert.equal(ctx.goal_id, 'college-promo')
      assert.deepEqual(ctx.history, [{ role: 'user', content: 'College students.' }])
      return { status: 'clarify', calls: [], message: 'What key message?', brief: { audience: null },
        pending_clarification: { field: 'key_message', question: 'What key message?' } }
    },
  ], { onPlan: (plan) => { goal = receiveGoalPlan(goal, plan); return goal } })
  Object.assign(f.request, goal, { history: [{ role: 'user', content: 'College students.' }] })
  await f.agent.run(f.request)
  assert.equal(f.commits.length, 0)
  assert.equal(f.request.composition.texts.length, 0)
  assert.equal(goal.brief.audience, 'college students')
  assert.equal(goal.brief.duration_seconds, 30)
  assert.equal(goal.pending_clarification.field, 'key_message')
})

test('Edit Video cannot execute footage generation even if a provider advertises it', async () => {
  const f = fixture([next(call('gen', 'generate_video', { prompt: 'College', width: 1280, height: 720, duration: 5 }))])
  f.request.mode = 'edit'
  await assert.rejects(f.agent.run(f.request), /selected mode/)
  assert.equal(f.commits.length, 0)
})

test('Plan New Video requires scene approval before assembly', async () => {
  const f = fixture([next(call('append', 'append_asset', { asset_id: 'asset-1', duration: 3 }))])
  f.request.mode = 'plan'
  await assert.rejects(f.agent.run(f.request), /Approve a scene plan/)
  assert.equal(f.commits.length, 0)
  const g = fixture([next(call('scenes', 'plan_scenes', { title: 'College AI', scenes: [{ description: 'Learning with AI', duration: 3 }] })),
    next(call('append', 'append_asset', { asset_id: 'asset-1', duration: 3 })), done])
  g.request.mode = 'plan'
  await g.agent.run(g.request)
  assert.equal(g.commits[0].composition.tracks[0].clips.length, 2)
})
