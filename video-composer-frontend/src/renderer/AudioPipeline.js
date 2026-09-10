// Client-side audio pipeline (Phase 2). Decodes clip audio + the uploaded
// background track to PCM and mixes them into ONE time-aligned buffer.
//
// Mix semantics mirror the live preview (clip audio AND background music play
// together) and the backend's apad behaviour (background audio pads with
// silence to the full timeline length instead of truncating the video).
// The single mixed buffer feeds both exporters:
//   - WebM real-time export plays it via AudioBufferSourceNode -> the
//     MediaRecorder stream (perfect sync, no element routing needed).
//   - MP4 fast export hands the same PCM to the AudioEncoder.

const DEFAULT_SAMPLE_RATE = 48000
// 30 minutes matches the backend's per-clip duration ceiling.
const MAX_EXPORT_SECONDS = 1800

let decodeContext = null
function getDecodeContext() {
  if (!decodeContext) {
    const Ctx = window.AudioContext || window.webkitAudioContext
    decodeContext = new Ctx()
  }
  if (decodeContext.state === 'suspended') decodeContext.resume().catch(() => {})
  return decodeContext
}

// Decode a File (video or audio) to an AudioBuffer. Video files without an
// audio track reject — callers treat that as silence, not failure.
export async function decodeAudioFile(file) {
  const arrayBuffer = await file.arrayBuffer()
  const ctx = getDecodeContext()
  // slice() because decodeAudioData detaches the input buffer.
  const copy = arrayBuffer.slice(0)
  return ctx.decodeAudioData(copy)
}

function timelineDuration(composition) {
  if (composition.duration > 0) return composition.duration
  return composition.tracks[0].clips.reduce((sum, clip) => sum + clip.duration, 0)
}

// Build the mixed export soundtrack. Returns { audioBuffer, hasAudio } —
// hasAudio is false when every source is silent/missing (exporters then skip
// the audio track entirely). Speed is applied via playbackRate; pitch
// preservation (FFmpeg atempo) is a documented Phase-4 refinement.
export async function buildMixedAudioBuffer({
  composition,
  clips,
  audioFile,
  sampleRate = DEFAULT_SAMPLE_RATE,
  onProgress,
}) {
  const totalDuration = timelineDuration(composition)
  if (!totalDuration || totalDuration <= 0) return { audioBuffer: null, hasAudio: false }
  if (totalDuration > MAX_EXPORT_SECONDS) {
    throw new Error(`Timeline is ${(totalDuration / 60).toFixed(1)} min — client export caps at 30 min.`)
  }

  const ctx = new OfflineAudioContext(2, Math.ceil(totalDuration * sampleRate), sampleRate)
  let scheduled = 0
  const report = (stage) => { if (onProgress) { try { onProgress(stage) } catch { /* noop */ } } }

  const scheduleBuffer = (buffer, { startTime, wallDuration, speed = 1, offset = 0 }) => {
    if (!buffer || wallDuration <= 0) return
    const available = Math.max(0, buffer.duration - offset)
    if (available <= 0) return
    // start(when, offset, duration): offset/duration are BUFFER seconds, so
    // the wall-clock play length is duration / playbackRate.
    const sourceDuration = Math.min(available, wallDuration * speed)
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.playbackRate.value = speed
    source.connect(ctx.destination)
    source.start(startTime, offset, sourceDuration)
    scheduled += 1
  }

  // 1) Clip audio, laid end-to-end at each clip's timeline position.
  const videoClips = composition.tracks[0].clips
  for (let i = 0; i < videoClips.length; i += 1) {
    const clip = videoClips[i]
    report({ stage: 'decode-clip', index: i, total: videoClips.length })
    if (clip.fileType?.startsWith('image/')) continue
    const file = clips[clip.fileIndex]
    if (!file) continue
    try {
      const decoded = await decodeAudioFile(file)
      scheduleBuffer(decoded, {
        startTime: clip.startTime,
        wallDuration: clip.duration,
        speed: clip.speed || 1,
        offset: 0, // clips always play from their source head in this app
      })
    } catch {
      // No decodable audio in this clip — silence for its span.
    }
  }

  // 2) Background track from t=0, padded with silence (apad parity) when
  // shorter than the timeline, trimmed when longer.
  if (audioFile) {
    report({ stage: 'decode-background' })
    try {
      const decoded = await decodeAudioFile(audioFile)
      scheduleBuffer(decoded, {
        startTime: 0,
        wallDuration: totalDuration,
        speed: 1,
        offset: 0,
      })
    } catch {
      // Undecodable background file — export proceeds without it.
    }
  }

  if (scheduled === 0) return { audioBuffer: null, hasAudio: false }

  report({ stage: 'mix' })
  const audioBuffer = await ctx.startRendering()
  return { audioBuffer, hasAudio: true }
}

// Quick synchronous check for UI gating (exporters still verify by decoding).
export function hasExportAudio(composition, clips, audioFile) {
  if (audioFile) return true
  return composition.tracks[0].clips.some((clip) => {
    if (clip.fileType?.startsWith('image/')) return false
    return Boolean(clips[clip.fileIndex])
  })
}
