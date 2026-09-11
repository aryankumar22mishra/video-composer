const MIN_CLIP_DURATION = 0.25
const MAX_SPEED = 8
const MIN_DIMENSION = 2
const MAX_DIMENSION = 7680

import registry from '../agent/toolRegistry.json' with { type: 'json' }

export const SUPPORTED_EDITING_TOOLS = registry.filter((tool) => ['edit', 'ui'].includes(tool.executor)).map((tool) => tool.name)

function relayout(clips) {
  let runningTime = 0
  const relaid = clips.map((clip) => {
    const duration = Number(clip.duration) > 0 ? Number(clip.duration) : MIN_CLIP_DURATION
    const updated = { ...clip, duration, startTime: runningTime }
    runningTime += duration
    return updated
  })
  return { clips: relaid, duration: runningTime }
}

function clipIdFor(action, context) {
  return action.clip_id || context.selectedClipId || null
}

function requireClip(clips, id) {
  const index = clips.findIndex((clip) => clip.id === id)
  if (index < 0) throw new Error('Select a clip or include a valid clip_id.')
  return index
}

function finiteNumber(value, label) {
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`${label} must be a number.`)
  return number
}

function updateClip(clips, id, updater) {
  const index = requireClip(clips, id)
  return clips.map((clip, clipIndex) => clipIndex === index ? updater(clip) : clip)
}

function sourceStart(clip) {
  return Number(clip.sourceStart ?? clip.sourceOffset ?? 0)
}


function uniqueSegmentId(originalId, suffix) {
  return `${originalId}-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function shiftTimedItems(items, removeStart, removeEnd) {
  const removedDuration = removeEnd - removeStart
  const result = []
  for (const item of items || []) {
    const itemStart = Number(item.startTime || 0)
    const itemDuration = Number(item.duration || 0)
    const itemEnd = itemStart + itemDuration
    if (itemEnd <= removeStart) {
      result.push(item)
      continue
    }
    if (itemStart >= removeEnd) {
      result.push({ ...item, startTime: itemStart - removedDuration })
      continue
    }
    const keptBefore = Math.max(0, removeStart - itemStart)
    const keptAfter = Math.max(0, itemEnd - removeEnd)
    if (keptBefore > 0) {
      result.push({ ...item, duration: keptBefore })
    }
    if (keptAfter > 0) {
      result.push({
        ...item,
        ...(item.id ? { id: uniqueSegmentId(item.id, 'after') } : {}),
        startTime: removeStart,
        duration: keptAfter,
      })
    }
  }
  return result
}

function applyAction(composition, action, context) {
  const type = action?.type
  if (!SUPPORTED_EDITING_TOOLS.includes(type)) {
    throw new Error(`Unsupported editing tool: ${type || 'unknown'}.`)
  }

  let next = { ...composition, tracks: composition.tracks.map((track) => ({ ...track, clips: [...track.clips] })) }
  let clips = [...next.tracks[0].clips]

  if (type === 'trim_clip') {
    const id = clipIdFor(action, context)
    const amount = action.duration != null
      ? finiteNumber(action.duration, 'duration')
      : finiteNumber(action.delta ?? 0, 'delta')
    clips = updateClip(clips, id, (clip) => ({ ...clip, duration: Math.max(MIN_CLIP_DURATION, amount) }))
  } else if (type === 'split_clip') {
    const id = clipIdFor(action, context)
    const index = requireClip(clips, id)
    const original = clips[index]
    const at = finiteNumber(action.at_seconds ?? action.position, 'split position')
    if (at <= 0 || at >= original.duration) throw new Error('Split position must be inside the selected clip.')
    const first = { ...original, id: uniqueSegmentId(original.id, 'a'), duration: at, sourceStart: sourceStart(original), sourceDuration: at * (original.speed || 1), baseDuration: at * (original.speed || 1) }
    const second = { ...original, id: uniqueSegmentId(original.id, 'b'), duration: original.duration - at, sourceStart: sourceStart(original) + at * (original.speed || 1), sourceDuration: (original.duration - at) * (original.speed || 1), baseDuration: (original.duration - at) * (original.speed || 1) }
    clips.splice(index, 1, first, second)
  } else if (type === 'remove_clip_range') {
    const id = clipIdFor(action, context)
    const index = requireClip(clips, id)
    const original = clips[index]
    const start = finiteNumber(action.start_seconds, 'start_seconds')
    const end = finiteNumber(action.end_seconds, 'end_seconds')
    if (start < 0 || end <= start || end > original.duration) {
      throw new Error('Removal range must be within the selected clip playback duration.')
    }

    const speed = Number(original.speed || 1)
    const originalSourceStart = sourceStart(original)
    const prefixDuration = start
    const suffixDuration = original.duration - end
    const replacement = []
    if (prefixDuration > 0) {
      replacement.push({
        ...original,
        duration: prefixDuration,
        sourceStart: originalSourceStart,
        sourceDuration: prefixDuration * speed,
      })
    }
    if (suffixDuration > 0) {
      replacement.push({
        ...original,
        id: uniqueSegmentId(original.id, 'after'),
        duration: suffixDuration,
        sourceStart: originalSourceStart + end * speed,
        sourceDuration: suffixDuration * speed,
      })
    }
    const removeStart = original.startTime + start
    const removeEnd = original.startTime + end
    clips.splice(index, 1, ...replacement)
    next.texts = shiftTimedItems(next.texts, removeStart, removeEnd)
    next.tracks[1] = {
      ...next.tracks[1],
      clips: shiftTimedItems(next.tracks[1].clips, removeStart, removeEnd),
    }
  } else if (type === 'keep_clip_range') {
    const id = clipIdFor(action, context)
    const index = requireClip(clips, id)
    const original = clips[index]
    const start = finiteNumber(action.start_seconds, 'start_seconds')
    const end = finiteNumber(action.end_seconds, 'end_seconds')
    if (start < 0 || end <= start || end > original.duration) {
      throw new Error('Keep range must be within the selected clip playback duration.')
    }

    const speed = Number(original.speed || 1)
    const clipStart = original.startTime
    const clipEnd = clipStart + original.duration
    const kept = {
      ...original,
      duration: end - start,
      sourceStart: sourceStart(original) + start * speed,
      sourceDuration: (end - start) * speed,
    }
    clips.splice(index, 1, kept)
    const afterRangeStart = clipStart + end
    const beforeRangeEnd = clipStart + start
    next.texts = shiftTimedItems(
      shiftTimedItems(next.texts, afterRangeStart, clipEnd),
      clipStart,
      beforeRangeEnd,
    )
    next.tracks[1] = {
      ...next.tracks[1],
      clips: shiftTimedItems(
        shiftTimedItems(next.tracks[1].clips, afterRangeStart, clipEnd),
        clipStart,
        beforeRangeEnd,
      ),
    }
  } else if (type === 'reorder_clips') {
    const ids = Array.isArray(action.clip_ids) ? action.clip_ids : []
    if (ids.length !== clips.length || new Set(ids).size !== clips.length || clips.some((clip) => !ids.includes(clip.id))) {
      throw new Error('reorder_clips must include every timeline clip exactly once.')
    }
    clips = ids.map((id) => clips.find((clip) => clip.id === id))
  } else if (type === 'update_text') {
    const textId = action.text_id || context.selectedTextId
    const textIndex = next.texts.findIndex((text) => text.id === textId)
    if (textIndex < 0) throw new Error('Select a text overlay or include a valid text_id.')
    const content = String(action.content ?? '').trim()
    if (!content) throw new Error('Text content cannot be empty.')
    next.texts = next.texts.map((text, index) => index === textIndex ? { ...text, content } : text)
  } else if (type === 'add_text') {
    const content = String(action.content ?? '').trim()
    if (!content) throw new Error('Text content cannot be empty.')
    next.texts = [...(next.texts || []), {
      id: `text-${Date.now()}-${Math.random()}`,
      content,
      x: Number(action.x ?? 0.5),
      y: Number(action.y ?? 0.5),
      startTime: Number(action.start_time ?? 0),
      duration: Math.max(MIN_CLIP_DURATION, Number(action.duration ?? 3)),
      size: Number(action.size ?? 48),
      color: action.color || '#ffffff',
      font: 'sans-serif',
      align: 'center',
      weight: 700,
      opacity: 1,
      strokeColor: '#000000',
      strokeWidth: 2,
    }]
  } else if (type === 'set_speed') {
    const id = clipIdFor(action, context)
    const speed = Math.min(MAX_SPEED, Math.max(0.1, finiteNumber(action.speed, 'speed')))
    clips = updateClip(clips, id, (clip) => {
      const baseDuration = clip.duration * (clip.speed || 1)
      return { ...clip, speed, baseDuration, duration: baseDuration / speed }
    })
  } else if (type === 'set_volume') {
    const id = clipIdFor(action, context)
    const volume = Math.min(1, Math.max(0, finiteNumber(action.volume, 'volume')))
    clips = updateClip(clips, id, (clip) => ({ ...clip, volume }))
  } else if (type === 'set_dimensions') {
    const width = Math.round(finiteNumber(action.width, 'width'))
    const height = Math.round(finiteNumber(action.height, 'height'))
    if (width < MIN_DIMENSION || height < MIN_DIMENSION || width > MAX_DIMENSION || height > MAX_DIMENSION) {
      throw new Error('Dimensions must be between 2 and 7680 pixels.')
    }
    next.width = width % 2 ? width - 1 : width
    next.height = height % 2 ? height - 1 : height
  } else if (type === 'set_grayscale') {
    const id = clipIdFor(action, context)
    clips = updateClip(clips, id, (clip) => ({ ...clip, grayscale: Boolean(action.enabled) }))
  } else if (type === 'open_recording_setup') {
    if (typeof context.openRecordingSetup !== 'function') {
      throw new Error('Recording setup is not available.')
    }
    context.openRecordingSetup()
  } else if (type === 'open_media_upload') {
    if (typeof context.openMediaUpload !== 'function') {
      throw new Error('Media upload is not available.')
    }
    context.openMediaUpload()
  } else if (type === 'stop_recording') {
    if (context.recordingState !== 'recording') {
      throw new Error('There is no active recording to stop.')
    }
    if (typeof context.stopRecording !== 'function') {
      throw new Error('Recording stop is not available.')
    }
    context.stopRecording()
  }

  const layout = relayout(clips)
  next.duration = layout.duration
  next.tracks[0] = { ...next.tracks[0], clips: layout.clips }
  return next
}

export function applyEditingActions(composition, actions, context = {}) {
  if (!Array.isArray(actions) || actions.length === 0) throw new Error('The agent returned no editing actions.')
  let next = composition
  const summaries = []
  let lastEditedTarget = context.lastEditedTarget || null
  for (const action of actions) {
    const before = next
    next = applyAction(next, action, context)
    const targetId = action.clip_id || action.text_id || context.selectedClipId || context.selectedTextId
    if (targetId) lastEditedTarget = { type: action.text_id ? 'text' : 'clip', id: targetId }
    const oldClip = targetId ? before.tracks[0].clips.find((clip) => clip.id === targetId) : null
    const newClip = targetId ? next.tracks[0].clips.find((clip) => clip.id === targetId) : null
    if ((action.type === 'remove_clip_range' || action.type === 'keep_clip_range') && oldClip) {
      const start = Number(action.start_seconds)
      const end = Number(action.end_seconds)
      const newDuration = action.type === 'keep_clip_range' ? end - start : oldClip.duration - (end - start)
      const verb = action.type === 'keep_clip_range' ? 'Kept' : 'Removed'
      summaries.push(`${verb} ${end - start}s; clip duration changed from ${oldClip.duration}s to ${newDuration}s.`)
    } else if (action.type === 'set_speed' && oldClip && newClip) {
      summaries.push(`Speed changed to ${newClip.speed}x; duration is now ${newClip.duration}s.`)
    } else if (action.type === 'set_volume' && newClip) {
      summaries.push(`Volume changed to ${Math.round(newClip.volume * 100)}%.`)
    } else {
      summaries.push(action.summary || action.type)
    }
  }
  return { composition: next, summaries, lastEditedTarget }
}

export function syncTimelineItems(timelineItems, composition) {
  const clips = composition.tracks[0].clips
  return clips.map((clip) => {
    const existing = timelineItems.find((item) => item.uid === clip.id)
    return existing || { clipIndex: clip.fileIndex, uid: clip.id }
  })
}
