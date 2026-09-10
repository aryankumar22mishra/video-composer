// Phase 3 — WebM real-time exporter. Zero new dependencies: headless canvas
// + captureStream(fps) + MediaRecorder, the same pattern the screen recorder
// already proves. Draws via the SHARED drawCompositionFrame so the export is
// pixel-identical to the live preview; audio comes from the Phase-2 mixed
// buffer played through a MediaStreamDestination (perfect sync, no element
// audio routing). Real-time speed: a 60s timeline takes ~60s to export.
// Keep this tab foregrounded while exporting — background tabs throttle
// requestAnimationFrame, which would freeze exported frames.

import { drawCompositionFrame, findActiveClip } from './CompositionRenderer'
import { buildMixedAudioBuffer } from './AudioPipeline'

const MAX_EXPORT_SIDE = 3840

const WEBM_MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
]

export function pickWebMMimeType() {
  if (typeof MediaRecorder === 'undefined') return ''
  return WEBM_MIME_CANDIDATES.find((type) => {
    try { return MediaRecorder.isTypeSupported(type) } catch { return false }
  }) || ''
}

function timelineDuration(composition) {
  if (composition.duration > 0) return composition.duration
  return composition.tracks[0].clips.reduce((sum, clip) => sum + clip.duration, 0)
}

function waitForVideoReady(video, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (video.readyState >= 2) { resolve(); return }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Video not ready: ${video.dataset.name || 'clip'}`))
    }, timeoutMs)
    const onReady = () => { cleanup(); resolve() }
    const onError = () => {
      cleanup()
      reject(new Error(`Could not load video: ${video.dataset.name || 'clip'}`))
    }
    const cleanup = () => {
      clearTimeout(timer)
      video.removeEventListener('canplay', onReady)
      video.removeEventListener('error', onError)
    }
    video.addEventListener('canplay', onReady)
    video.addEventListener('error', onError)
  })
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()))

// Build fresh export-safe <video> elements (muted — soundtrack comes from
// the mixed buffer). Reusing the preview's hidden videos would fight the
// preview clock; these are owned entirely by the export.
async function buildExportVideos(composition, clips, report) {
  const videos = {}
  const urls = []
  const needed = new Set()
  for (const clip of composition.tracks[0].clips) {
    if (!clip.fileType?.startsWith('video/')) continue
    if (clips[clip.fileIndex]) needed.add(clip.fileIndex)
  }
  let done = 0
  for (const fileIndex of needed) {
    report?.({ stage: 'load-video', done, total: needed.size })
    const file = clips[fileIndex]
    const url = URL.createObjectURL(file)
    urls.push(url)
    const video = document.createElement('video')
    video.muted = true
    video.preload = 'auto'
    video.playsInline = true
    video.dataset.name = file.name
    video.src = url
    await waitForVideoReady(video)
    videos[fileIndex] = video
    done += 1
  }
  report?.({ stage: 'load-video', done, total: needed.size })
  return { videos, urls }
}

function buildExportImages(composition, clips, mediaImages) {
  // Reuse already-decoded preview <img> elements where possible; build
  // fresh ones for any missing index so export never depends on preview.
  const images = { ...(mediaImages || {}) }
  const jobs = []
  for (const clip of composition.tracks[0].clips) {
    if (!clip.fileType?.startsWith('image/')) continue
    if (images[clip.fileIndex]) continue
    const file = clips[clip.fileIndex]
    if (!file) continue
    jobs.push(new Promise((resolve) => {
      const url = URL.createObjectURL(file)
      const img = new Image()
      img.onload = () => { URL.revokeObjectURL(url); images[clip.fileIndex] = img; resolve() }
      img.onerror = () => { URL.revokeObjectURL(url); resolve() }
      img.src = url
    }))
  }
  return Promise.all(jobs).then(() => images)
}
export async function exportWebM({
  composition,
  clips,
  audioFile,
  mediaImages,
  mimeType,
  onProgress,
} = {}) {
  const totalDuration = timelineDuration(composition)
  if (!totalDuration || totalDuration <= 0) {
    throw new Error('Add at least one clip to the timeline before exporting.')
  }
  const longest = Math.max(composition.width, composition.height)
  if (longest > MAX_EXPORT_SIDE) {
    throw new Error('Composition exceeds the 3840px client export cap.')
  }
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('MediaRecorder is not supported in this browser.')
  }

  const fps = composition.fps || 30
  const report = (p) => { if (onProgress) { try { onProgress(p) } catch { /* noop */ } } }
  const cancelled = () => exportWebM.cancelRequested

  const canvas = document.createElement('canvas')
  canvas.width = composition.width
  canvas.height = composition.height
  const ctx = canvas.getContext('2d')

  let audioCtx = null
  let audioSource = null
  let exportUrls = []
  let exportVideos = {}
  let recorder = null
  const chunks = []

  try {
    const [built, images] = await Promise.all([
      buildExportVideos(composition, clips, (p) => report({ ...p, phase: 'loading' })),
      buildExportImages(composition, clips, mediaImages),
    ])
    exportVideos = built.videos
    exportUrls = built.urls
    if (cancelled()) throw new Error('Export cancelled.')

    await Promise.all(Object.values(exportVideos).map(async (video) => {
      try { video.currentTime = 0; await waitForVideoReady(video, 8000) } catch { /* play retries */ }
      video.pause()
    }))
    if (cancelled()) throw new Error('Export cancelled.')

    report({ phase: 'mixing', stage: 'mix' })
    const mixed = await buildMixedAudioBuffer({
      composition, clips, audioFile,
      onProgress: (p) => report({ phase: 'mixing', ...p }),
    })
    if (cancelled()) throw new Error('Export cancelled.')

    const canvasStream = canvas.captureStream(fps)
    if (mixed.hasAudio && mixed.audioBuffer) {
      const Ctx = window.AudioContext || window.webkitAudioContext
      audioCtx = new Ctx()
      await audioCtx.resume().catch(() => {})
      audioSource = audioCtx.createBufferSource()
      audioSource.buffer = mixed.audioBuffer
      const dest = audioCtx.createMediaStreamDestination()
      audioSource.connect(dest)
      audioSource.connect(audioCtx.destination)
      const audioTrack = dest.stream.getAudioTracks()[0]
      if (audioTrack) canvasStream.addTrack(audioTrack)
    }

    const chosenMime = mimeType || pickWebMMimeType()
    recorder = chosenMime
      ? new MediaRecorder(canvasStream, { mimeType: chosenMime })
      : new MediaRecorder(canvasStream)
    const stopped = new Promise((resolve) => { recorder.onstop = resolve })
    recorder.onerror = () => {}
    recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data) }
    recorder.start(250)

    const renderStart = performance.now()
    if (audioSource) { try { audioSource.start() } catch { /* noop */ } }

    const activeById = new Map()
    let finished = false
    while (!finished) {
      if (cancelled()) throw new Error('Export cancelled.')
      const elapsed = (performance.now() - renderStart) / 1000
      const t = Math.min(elapsed, totalDuration)
      const activeClip = findActiveClip(composition, t)

      for (const [fileIndex, video] of Object.entries(exportVideos)) {
        const isActive = Boolean(
          activeClip?.fileType?.startsWith('video/')
          && Number(activeClip.fileIndex) === Number(fileIndex),
        )
        const wasActive = activeById.get(fileIndex) || false
        if (isActive && !wasActive) {
          try { video.currentTime = 0 } catch { /* noop */ }
          if (video.paused) { try { await video.play() } catch { /* draw anyway */ } }
          activeById.set(fileIndex, true)
        } else if (!isActive && wasActive) {
          try { video.pause() } catch { /* noop */ }
          activeById.set(fileIndex, false)
        } else if (isActive && video.paused) {
          try { await video.play() } catch { /* noop */ }
        }
      }

      drawCompositionFrame(ctx, canvas, composition, t, { images, videos: exportVideos })
      report({ phase: 'rendering', elapsed: t, total: totalDuration, progress: t / totalDuration })

      if (elapsed >= totalDuration) { finished = true; break }
      await nextFrame()
    }

    await new Promise((resolve) => setTimeout(resolve, 300))
    try { if (audioSource) audioSource.stop() } catch { /* noop */ }
    if (recorder.state !== 'inactive') recorder.stop()
    await stopped

    const blob = new Blob(chunks, { type: 'video/webm' })
    if (!blob.size) throw new Error('Export produced an empty file — retry with this tab foregrounded.')
    return {
      blob,
      url: URL.createObjectURL(blob),
      duration: totalDuration,
      mimeType: recorder.mimeType || chosenMime,
    }
  } finally {
    Object.values(exportVideos).forEach((v) => {
      try { v.pause(); v.removeAttribute('src') } catch { /* noop */ }
    })
    exportUrls.forEach((u) => { try { URL.revokeObjectURL(u) } catch { /* noop */ } })
    if (audioCtx) { try { await audioCtx.close() } catch { /* noop */ } }
    canvas.width = 0
  }
}

exportWebM.cancelRequested = false
export function cancelWebMExport() { exportWebM.cancelRequested = true }
export function resetWebMExportCancel() { exportWebM.cancelRequested = false }

