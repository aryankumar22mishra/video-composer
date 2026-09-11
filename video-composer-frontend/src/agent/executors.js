import { applyEditingActions } from '../state/editingCommands.js'
import { createCompositionClip } from '../state/composition.js'

function requireAsset(stage, id) {
  const asset = stage.assets.find((item) => item.id === id)
  if (!asset || !asset.approved) throw new Error('Asset is missing or has not been approved in preview.')
  return asset
}

function validateEdit(composition, action) {
  const clip = action.clip_id && composition.tracks[0].clips.find((item) => item.id === action.clip_id)
  if (action.clip_id && !clip) throw new Error('The requested clip no longer exists.')
  const frame = 1 / (composition.fps || 30)
  if (action.type === 'trim_clip' && action.duration > clip.duration) throw new Error('Trimming cannot extend a clip. Choose a shorter duration.')
  if (action.type === 'split_clip' && (action.at_seconds < frame || clip.duration - action.at_seconds < frame)) throw new Error('Both split segments must be at least one frame.')
  if (['keep_clip_range', 'remove_clip_range'].includes(action.type)) {
    if (action.start_seconds >= action.end_seconds || action.end_seconds > clip.duration || action.end_seconds - action.start_seconds < frame) throw new Error('Select a range of at least one frame within the clip.')
  }
}

export const EXECUTORS = {
  edit: async (stage, call, context) => {
    const action = { type: call.name, ...call.arguments }
    validateEdit(stage.composition, action)
    const before = stage.composition
    const result = applyEditingActions(before, [action], context)
    stage.composition = result.composition
    stage.lastEditedTarget = result.lastEditedTarget
    const newClips = result.composition.tracks[0].clips.filter((c) => !before.tracks[0].clips.some((old) => old.id === c.id))
    const newTexts = (result.composition.texts || []).filter((t) => !(before.texts || []).some((old) => old.id === t.id))
    const changed = JSON.stringify(before) !== JSON.stringify(result.composition)
    return { changed, summary: changed ? result.summaries.join(' ') : 'No change was needed.',
      clip_ids: newClips.map((c) => c.id), text_ids: newTexts.map((t) => t.id),
      clip: action.clip_id ? result.composition.tracks[0].clips.find((c) => c.id === action.clip_id) || null : undefined }
  },
  append: async (stage, call) => {
    const asset = requireAsset(stage, call.arguments.asset_id)
    if (!/^(image|video)\//.test(asset.type)) throw new Error('Only images and videos can be appended to the video timeline.')
    if (asset.type.startsWith('video/') && (!Number.isFinite(asset.duration) || call.arguments.duration > asset.duration)) throw new Error('Requested duration exceeds the video asset duration.')
    const composition = stage.composition
    const clip = createCompositionClip(asset.file, asset.fileIndex, composition.duration, call.arguments.duration)
    clip.sourceDuration = call.arguments.duration
    stage.composition = { ...composition, duration: composition.duration + clip.duration,
      tracks: composition.tracks.map((track, index) => index === 0 ? { ...track, clips: [...track.clips, clip] } : track) }
    return { changed: true, clip_id: clip.id, asset_id: asset.id, summary: `Added ${asset.name} for ${clip.duration}s.` }
  },
  audio: async (stage, call) => {
    const asset = requireAsset(stage, call.arguments.asset_id)
    if (!asset.type.startsWith('audio/')) throw new Error('Choose an audio asset for background narration or music.')
    const changed = stage.composition.backgroundAudioAssetId !== asset.id
    stage.composition = { ...stage.composition, backgroundAudioAssetId: asset.id }
    return { changed, asset_id: asset.id, summary: `Set background audio to ${asset.name}.` }
  },
  scenes: async (stage, call, context) => {
    if (!await context.review({ kind: 'scenes', title: call.arguments.title, scenes: call.arguments.scenes })) throw new Error('Scene plan declined. Describe the changes you want and try again.')
    stage.scenePlan = call.arguments
    return { approved: true, scenes: call.arguments.scenes, summary: 'Scene plan approved.' }
  },
  ui: async (stage, call, context) => {
    // UI effects run only after the plan completes, outside the staged editing transaction.
    stage.uiCalls.push(call)
    const messages = { open_recording_setup: 'Recording setup will open after this request completes.',
      open_media_upload: 'Upload panel will open after this request completes; choose files there.',
      stop_recording: 'Recording stop is queued until this request completes.' }
    if (call.name === 'stop_recording' && context.recordingState !== 'recording') throw new Error('There is no active recording to stop.')
    return { deferred: true, summary: messages[call.name] }
  },
  service: async (stage, call, context) => {
    const source = call.name === 'transcribe' ? requireAsset(stage, call.arguments.asset_id) : null
    const result = await context.service(call, source)
    if (call.name === 'transcribe') return { text: result.text, operation_id: result.operation_id, summary: 'Transcription completed.' }
    const asset = await context.loadGenerated(result)
    try {
      if (!await context.review({ kind: 'asset', title: 'Preview generated asset', asset })) throw new Error('Generated asset declined. No timeline changes were committed.')
    } finally {
      context.releasePreview(asset)
    }
    asset.approved = true
    if (!asset.type.startsWith('audio/')) {
      asset.fileIndex = stage.files.length
      stage.files.push(asset.file)
    }
    stage.assets.push(asset)
    return { asset_id: asset.id, name: asset.name, type: asset.type, duration: asset.duration,
      summary: `${asset.name} generated and approved; it is available for assembly.` }
  },
}
