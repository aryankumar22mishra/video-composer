import { AgentExecutor } from './AgentExecutor.js'
import { loadAssetMetadata } from '../assets/AssetManager.js'

const identities = new WeakMap()
export function assetId(file) {
  if (!identities.has(file)) identities.set(file, crypto.randomUUID())
  return identities.get(file)
}

export function describeAssets(files, durations, audioAssets = []) {
  const assets = files.map((file, fileIndex) => ({ id: assetId(file), file, fileIndex,
    name: file.name, type: file.type, size: file.size, duration: durations[fileIndex] || null, approved: true }))
  for (const file of audioAssets.filter(Boolean)) {
    if (!assets.some((a) => a.id === assetId(file))) assets.push({ id: assetId(file), file,
      name: file.name, type: file.type, size: file.size, approved: true })
  }
  return assets
}

async function requestJSON(path, body, signal) {
  let response
  const [route, query] = path.split('?')
  const timeoutSignal = AbortSignal.timeout(route === 'plan' ? 180000 : route === 'media/execute' ? 75000 : 15000)
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  try {
    response = await fetch(`/api/ai/${route}/${query ? `?${query}` : ''}`, { method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : body instanceof FormData ? { body } : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), signal: requestSignal })
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Request cancelled. A submitted media job may still complete; check its service account before retrying.')
    if (error.name === 'TimeoutError') throw new Error('The agent request timed out. A submitted media job may still complete; check the service account before starting another job.')
    throw new Error('The agent backend could not be reached. Start Django and try again, or use the editor controls manually.')
  }
  const result = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(result.detail || `Agent request failed (HTTP ${response.status}).`)
    // Retry only planning overloads; never retry media service requests here.
    error.retryable = path === 'plan' && response.status === 429
    throw error
  }
  return result
}

async function loadGenerated(result, signal) {
  if (typeof result.url !== 'string' || !result.url.startsWith('/media/agent/generated/') || result.url.includes('..')) throw new Error('The service returned an invalid asset location.')
  const response = await fetch(result.url, { signal })
  if (!response.ok) throw new Error('Generated asset could not be downloaded for preview.')
  const blob = await response.blob()
  const file = new File([blob], result.name, { type: result.type })
  identities.set(file, result.asset_id)
  let metadata
  if (file.type.startsWith('audio/')) {
    const ctx = new AudioContext()
    try {
      const audio = await ctx.decodeAudioData(await file.arrayBuffer())
      metadata = { duration: audio.duration, url: URL.createObjectURL(file) }
    } finally { await ctx.close() }
  } else {
    metadata = await loadAssetMetadata(file)
  }
  return { id: result.asset_id, name: file.name, type: file.type, size: file.size,
    file, duration: metadata.duration, previewUrl: metadata.url, approved: false }
}

export function createBrowserAgent(options) {
  const runId = crypto.randomUUID()
  return new AgentExecutor({
    ...options,
    tools: async () => (await requestJSON(`tools?recording_state=${encodeURIComponent(options.context().recordingState)}${options.mode ? `&mode=${options.mode}&generate_assets=${Boolean(options.generateAssets)}` : ''}`, undefined, options.signal)).tools,
    plan: (context) => requestJSON('plan', context, options.signal),
    loadGenerated: (result) => loadGenerated(result, options.signal),
    releasePreview: (asset) => URL.revokeObjectURL(asset.previewUrl),
    service: async (call, source) => {
      let digest = ''
      if (source) {
        if (!/^(audio|video)\//.test(source.type) || source.file.size > 20 * 1024 * 1024) throw new Error('Transcription requires an audio/video asset no larger than 20 MB.')
        digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await source.file.arrayBuffer()))].map((b) => b.toString(16).padStart(2, '0')).join('')
      }
      const prepared = await requestJSON('media/prepare', { run_id: runId, operation_id: crypto.randomUUID(), call, media_digest: digest }, options.signal)
      if (!await options.review({ kind: 'charge', title: 'Confirm media service request', ...prepared })) throw new Error('Media service request declined. No chargeable job was submitted.')
      // The app's review gate checks freshness on both sides of user input.
      options.assertFresh()
      const form = new FormData()
      form.append('approval_token', prepared.approval_token)
      if (source) form.append('media', source.file)
      return requestJSON('media/execute', form, options.signal)
    },
  })
}
