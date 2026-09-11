// Phase 4 â€” fast client-side exporters (WebCodecs + muxers).
// Requires: npm i mp4-muxer webm-muxer
//   MP4  = VideoEncoder(avc1.42001f) + AudioEncoder(mp4a.40.2) -> mp4-muxer
//   WebM = VideoEncoder(vp09.00.10.08) + AudioEncoder(opus) -> webm-muxer
// Faster than real-time (frames drawn as fast as possible). Falls back to
// the Phase-3 MediaRecorder WebM path when WebCodecs is unavailable.

import { drawCompositionFrame, findActiveClip, sourceTimeForClip } from './CompositionRenderer'
import { buildMixedAudioBuffer } from './AudioPipeline'

const MAX_EXPORT_SIDE = 3840

export function webCodecsSupported() {
  return typeof window !== 'undefined'
    && 'VideoEncoder' in window
    && 'AudioEncoder' in window
    && 'VideoFrame' in window
}

function timelineDuration(composition) {
  if (composition.duration > 0) return composition.duration
  return composition.tracks[0].clips.reduce((sum, clip) => sum + clip.duration, 0)
}

function waitForSeek(video) {
  return new Promise((resolve) => {
    if (video.readyState >= 2 && video.seeking === false) { resolve(); return }
    const timer = setTimeout(() => { resolve() }, 4000)
    video.addEventListener('seeked', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}

async function buildSeekVideos(composition, clips, report) {
  const videos = {}
  const urls = []
  const needed = new Set()
  for (const clip of composition.tracks[0].clips) {
    if (clip.fileType?.startsWith('video/') && clips[clip.fileIndex]) needed.add(clip.fileIndex)
  }
  let done = 0
  for (const fileIndex of needed) {
    if (report) report({ stage: 'load-video', done, total: needed.size })
    const url = URL.createObjectURL(clips[fileIndex])
    urls.push(url)
    const video = document.createElement('video')
    video.muted = true
    video.preload = 'auto'
    video.playsInline = true
    video.src = url
    await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(), 15000)
      video.oncanplay = () => { clearTimeout(timer); resolve() }
      video.onerror = () => { clearTimeout(timer); resolve() }
    })
    videos[fileIndex] = video
    done += 1
  }
  if (report) report({ stage: 'load-video', done, total: needed.size })
  return { videos, urls }
}

async function fastEncode(args) {
  const { composition, clips, audioFile, mediaImages, codec, onProgress } = args
  const totalDuration = timelineDuration(composition)
  if (!totalDuration || totalDuration <= 0) {
    throw new Error('Add at least one clip to the timeline before exporting.')
  }
  const longest = Math.max(composition.width, composition.height)
  if (longest > MAX_EXPORT_SIDE) throw new Error('Composition exceeds the 3840px client export cap.')
  if (!webCodecsSupported()) throw new Error('WebCodecs not supported â€” use WebM export instead.')

  const report = (p) => { if (onProgress) { try { onProgress(p) } catch { /* noop */ } } }
  const fps = composition.fps || 30
  const totalFrames = Math.max(1, Math.round(totalDuration * fps))

  const muxerModule = codec === 'mp4' ? await import('mp4-muxer') : await import('webm-muxer')
  const Muxer = muxerModule.Muxer
  const videoCodec = codec === 'mp4' ? 'avc' : 'V_VP9'
  const audioCodec = codec === 'mp4' ? 'aac' : 'A_OPUS'
  const encVideoCodec = codec === 'mp4' ? 'avc1.42001f' : 'vp09.00.10.08'
  const encAudioCodec = codec === 'mp4' ? 'mp4a.40.2' : 'opus'

  const built = await buildSeekVideos(composition, clips, (p) => report({ ...p, phase: 'loading' }))
  const videos = built.videos
  const urls = built.urls
  const images = { ...(mediaImages || {}) }

  report({ phase: 'mixing', stage: 'mix' })
  const mixed = await buildMixedAudioBuffer({
    composition, clips, audioFile,
    onProgress: (p) => report({ phase: 'mixing', ...p }),
  })

  const canvas = document.createElement('canvas')
  canvas.width = composition.width
  canvas.height = composition.height
  const ctx = canvas.getContext('2d')

  const sampleRate = (mixed.audioBuffer && mixed.audioBuffer.sampleRate) || 48000
  const muxerOpts = {
    target: new muxerModule.ArrayBufferTarget(),
    video: { codec: videoCodec, width: composition.width, height: composition.height },
    firstTimestampBehavior: 'offset',
  }
  if (mixed.hasAudio && mixed.audioBuffer) {
    muxerOpts.audio = { codec: audioCodec, sampleRate, numberOfChannels: mixed.audioBuffer.numberOfChannels }
  }
  const muxer = new Muxer(muxerOpts)

  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { throw e },
  })
  videoEncoder.configure({ codec: encVideoCodec, width: composition.width, height: composition.height, bitrate: 8000000, framerate: fps })

  let audioEncoder = null
  if (mixed.hasAudio && mixed.audioBuffer) {
    audioEncoder = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: (e) => { throw e },
    })
    audioEncoder.configure({ codec: encAudioCodec, sampleRate, numberOfChannels: mixed.audioBuffer.numberOfChannels, bitrate: 128000 })
  }
  try {
    const frameDurationUs = Math.round(1000000 / fps)
    for (let i = 0; i < totalFrames; i += 1) {
      const t = Math.min((i * frameDurationUs) / 1000000, totalDuration - 0.0001)
      const activeClip = findActiveClip(composition, t)
      if (activeClip && activeClip.fileType && activeClip.fileType.startsWith('video/')) {
        const video = videos[activeClip.fileIndex]
        if (video) {
          try {
            const sourceTime = sourceTimeForClip(activeClip, t)
            if (Math.abs(video.currentTime - sourceTime) > 0.04) {
              video.currentTime = sourceTime
              await waitForSeek(video)
            }
          } catch { /* draw current frame */ }
        }
      }
      drawCompositionFrame(ctx, canvas, composition, t, { images, videos })
      const frame = new VideoFrame(canvas, { timestamp: i * frameDurationUs, duration: frameDurationUs })
      videoEncoder.encode(frame, { keyFrame: i % (fps * 2) === 0 })
      frame.close()
      if (i % 10 === 0 || i === totalFrames - 1) {
        report({ phase: 'encoding', frame: i + 1, totalFrames, progress: (i + 1) / totalFrames })
      }
      if (fastEncode.cancelRequested) throw new Error('Export cancelled.')
      if (videoEncoder.encodeQueueSize > 4) {
        await new Promise((r) => setTimeout(r, 0))
      }
    }
    await videoEncoder.flush()
    if (audioEncoder && mixed.audioBuffer) {
      const channels = mixed.audioBuffer.numberOfChannels
      const totalSamples = mixed.audioBuffer.length
      const CHUNK = 20480
      for (let offset = 0; offset < totalSamples; offset += CHUNK) {
        const len = Math.min(CHUNK, totalSamples - offset)
        const data = new Float32Array(len * channels)
        for (let c = 0; c < channels; c += 1) {
          const ch = mixed.audioBuffer.getChannelData(c).subarray(offset, offset + len)
          data.set(ch, c * len)
        }
        const audioData = new AudioData({
          format: 'f32-planar',
          sampleRate: sampleRate,
          numberOfFrames: len,
          numberOfChannels: channels,
          timestamp: Math.round((offset / sampleRate) * 1000000),
          data: data,
        })
        audioEncoder.encode(audioData)
        audioData.close()
      }
      await audioEncoder.flush()
    }
  } finally {
    try { videoEncoder.close() } catch { /* noop */ }
    try { if (audioEncoder) audioEncoder.close() } catch { /* noop */ }
    Object.values(videos).forEach((v) => { try { v.pause(); v.removeAttribute('src') } catch { /* noop */ } })
    urls.forEach((u) => { try { URL.revokeObjectURL(u) } catch { /* noop */ } })
    canvas.width = 0
  }

  muxer.finalize()
  const outBuffer = muxer.target.buffer
  const mime = codec === 'mp4' ? 'video/mp4' : 'video/webm'
  const blob = new Blob([outBuffer], { type: mime })
  if (!blob.size) throw new Error('Export produced an empty file.')
  return { blob: blob, url: URL.createObjectURL(blob), duration: totalDuration, mimeType: mime }
}

fastEncode.cancelRequested = false

export async function exportMP4(opts) {
  return fastEncode({ ...opts, codec: 'mp4' })
}
export async function exportFastWebM(opts) {
  return fastEncode({ ...opts, codec: 'webm' })
}
export function cancelFastExport() { fastEncode.cancelRequested = true }
export function resetFastExportCancel() { fastEncode.cancelRequested = false }

