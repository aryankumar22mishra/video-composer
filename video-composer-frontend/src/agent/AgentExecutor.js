import { validateCall } from './registry.js'
import { EXECUTORS } from './executors.js'

export const LIMITS = { rounds: 10, calls: 24, plannerRetries: 1 }
const publicAsset = ({ file: _file, previewUrl: _preview, ...metadata }) => metadata
const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item)

/** One transaction per user goal. Never mutates live editor state before commit. */
export class AgentExecutor {
  constructor(dependencies) { this.io = dependencies; this.running = false }

  async run(request) {
    if (this.running) throw new Error('An agent request is already running.')
    this.running = true
    const io = this.io
    const version = io.getVersion()
    const assertFresh = () => {
      if (io.signal?.aborted) throw new Error('Request cancelled. Staged edits were discarded.')
      if (io.getVersion() !== version) throw new Error('The editor changed while the agent was working. Staged edits were discarded; send the request again.')
    }
    const stage = { composition: structuredClone(request.composition), files: [...request.files],
      assets: request.assets.map((a) => ({ ...a })), uiCalls: [], lastEditedTarget: null }
    const results = []
    const executed = new Map()
    const serviceResults = new Map()
    let round = 0
    let goalContext = { brief: request.brief, goal_id: request.goal_id, goal_kind: request.goal_kind, pending_clarification: request.pending_clarification }
    const contextFor = () => ({ ...request, ...goalContext, files: undefined, assets: stage.assets.map(publicAsset),
      composition: stage.composition, selected_clip: stage.composition.tracks[0].clips.find((c) => c.id === request.selected_clip?.id) || null,
      recording_state: io.context().recordingState, tool_results: results, round })
    try {
      const tools = await io.tools()
      assertFresh()
      for (; round < LIMITS.rounds; round += 1) {
        assertFresh()
        io.progress({ phase: 'planning', message: `Planning step ${round + 1}`, results: [...results] })
        let plan
        for (let attempt = 0; attempt <= LIMITS.plannerRetries; attempt += 1) {
          try { plan = await io.plan(contextFor()); break }
          catch (error) {
            assertFresh()
            if (attempt === LIMITS.plannerRetries || !error.retryable) throw error
          }
        }
        assertFresh()
        if (!plan || !['continue', 'done', 'clarify', 'unavailable'].includes(plan.status) || !Array.isArray(plan.calls) || plan.calls.length > 6 || Boolean(plan.calls.length) !== (plan.status === 'continue')) throw new Error('Invalid agent plan.')
        // Persist conversation updates before any disposable editing work.
        if (io.onPlan) goalContext = io.onPlan(plan)
        if (plan.status !== 'continue') {
          if (plan.status !== 'done') return { status: plan.status, message: plan.message, results, committed: false }
          const changed = JSON.stringify(stage.composition) !== JSON.stringify(request.composition)
          assertFresh()
          // Validate deferred effects before committing any composition changes.
          for (const call of stage.uiCalls) {
            if (call.name === 'stop_recording' && io.context().recordingState !== 'recording') throw new Error('Recording ended before the stop action could be applied.')
          }
          io.commit(stage)
          const uiResults = []
          for (const call of stage.uiCalls) {
            const receipt = results.find((r) => r.id === call.id)
            try {
              const summary = await io.executeUI(call)
              uiResults.push(summary)
              receipt.output = { completed: true, summary }
            } catch {
              const summary = `${call.name} could not be completed.`
              uiResults.push(summary)
              receipt.status = 'error'
              receipt.error = summary
            }
          }
          const summaries = changed ? results.filter((r) => r.output.changed).map((r) => r.output.summary) : []
          const completedServices = [...new Set(results.filter((r) => r.name === 'transcribe' || r.output.asset_id && r.name.startsWith('generate') || r.name === 'text_to_speech').map((r) => r.output.summary))]
          return { status: 'done', committed: changed, results,
            message: [...summaries, ...completedServices, ...uiResults].join(' ') || 'No composition changes were needed.' }
        }
        // Preflight the entire batch before any side effects, preserving dependency order.
        const known = new Set(results.map((r) => r.id))
        const batch = new Set()
        for (const call of plan.calls) {
          validateCall(call, tools)
          if (batch.has(call.id) || (call.depends_on || []).some((id) => !known.has(id))) throw new Error('Unresolved, duplicate or forward tool dependency.')
          batch.add(call.id); known.add(call.id)
        }
        if (results.length + [...batch].filter((id) => !executed.has(id)).length > LIMITS.calls) throw new Error('Tool call limit reached. Staged edits were discarded; try a smaller goal.')
        for (const call of plan.calls) {
          assertFresh()
          const signature = canonical([call.name, call.arguments, call.depends_on || []])
          const previous = executed.get(call.id)
          if (previous) {
            if (previous !== signature) throw new Error('A call ID was reused with different arguments.')
            continue
          }
          if (results.length >= LIMITS.calls) throw new Error('Tool call limit reached. Staged edits were discarded; try a smaller goal.')
          const tool = validateCall(call, tools)
          if (request.mode && !tool.modes.includes(request.mode)) throw new Error('This tool is not available in the selected mode.')
          if (request.mode === 'plan' && ['generate_image', 'generate_video'].includes(call.name) && !request.generate_assets) throw new Error('Enable Generate Assets before requesting generated footage.')
          if (request.mode === 'plan' && ['edit', 'append', 'audio', 'service'].includes(tool.executor)
              && !request.scene_plan_approved && !stage.scenePlan) throw new Error('Approve a scene plan before creating or editing the timeline in Plan New Video.')
          const executor = EXECUTORS[tool.executor]
          if (!executor) throw new Error('This tool has no registered executor.')
          executed.set(call.id, signature)
          io.progress({ phase: 'executing', message: `Running ${tool.name}`, results: [...results] })
          let output
          try {
            const serviceKey = canonical([call.name, call.arguments])
            output = tool.executor === 'service' && serviceResults.has(serviceKey) ? serviceResults.get(serviceKey) : await executor(stage, call, { ...io.context(), ...io, review: async (details) => {
              assertFresh()
              const accepted = await io.review(details)
              assertFresh()
              return accepted
            } })
            if (tool.executor === 'service') serviceResults.set(serviceKey, output)
          } catch (error) {
            results.push({ id: call.id, name: call.name, status: 'error', error: error.message })
            throw error
          }
          assertFresh()
          if (stage.composition.duration > 1800) throw new Error('The timeline exceeds the 30-minute browser export limit.')
          results.push({ id: call.id, name: call.name, status: 'success', output })
          io.progress({ phase: 'staged', message: output.summary, results: [...results] })
        }
      }
      throw new Error('Planning round limit reached. Staged edits were discarded; try a smaller goal.')
    } catch (error) {
      // Return the actual failure to the planner without accepting further execution.
      if (!io.signal?.aborted && io.getVersion() === version && results.some((r) => r.status === 'error')) {
        try { await io.plan({ ...contextFor(), round: Math.min(round, LIMITS.rounds - 1), terminal_failure: true }) } catch { /* preserve execution error */ }
      }
      error.receipts = results
      throw error
    } finally { this.running = false }
  }
}
