// Clip-edge edits ripple later clips and keep source time in media seconds.
export function resizeTimelineClip(composition, id, edge, delta, sourceLength = Infinity) {
  const original = composition.tracks[0].clips.find(clip => clip.id === id)
  if (!original || !Number.isFinite(delta)) return composition
  const speed = original.speed || 1
  const offset = original.sourceStart ?? original.sourceOffset ?? 0
  let duration = original.duration
  let sourceStart = offset
  if (edge === 'start') {
    const shift = Math.max(-offset / speed, Math.min(delta, duration - .25))
    sourceStart += shift * speed
    duration -= shift
  } else {
    duration = Math.max(.25, Math.min(duration + delta, (sourceLength - offset) / speed))
  }
  if (duration === original.duration && sourceStart === offset) return composition
  let time = 0
  const clips = composition.tracks[0].clips.map(clip => {
    const next = clip.id === id ? { ...clip, duration, sourceStart, sourceOffset: sourceStart, sourceDuration: duration * speed, baseDuration: duration * speed } : { ...clip }
    next.startTime = time
    time += next.duration
    return next
  })
  return { ...composition, duration: time, tracks: composition.tracks.map((track, index) => index === 0 ? { ...track, clips } : track) }
}
