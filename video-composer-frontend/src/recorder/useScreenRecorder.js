// Screen recording via the browser MediaRecorder API — Phases 3–5.
//
// Everything is layered on the Phase 2 getDisplayMedia() capture:
//
//   Share Screen -> getDisplayMedia() -> screen MediaStream
//                + getUserMedia()    -> microphone MediaStream (optional)
//                -> combined MediaStream -> MediaRecorder
//                -> dataavailable chunks
//                -> Blob -> File -> onCommit(file)   (exactly once)
//
// This module owns every browser recording internal (screen/mic streams,
// combined stream, MediaRecorder, chunks, MIME type). The parent app only
// ever receives the final File through the onCommit() contract.

import { useCallback, useEffect, useRef, useState } from 'react'

const INITIAL_STATE = {
  cameraEnabled: true,
  cameraDeviceId: '',
  cameraShape: 'circle',
  cameraSize: 'medium',
  cameraMirror: true,
  cameraPosition: 'bottom-right',
  micEnabled: true,
  micDeviceId: '',
  systemAudioEnabled: false,
  recordingState: 'idle',
  error: '',
  notice: '',
}

// Returns a short, friendly message for a getUserMedia (microphone) error.
function resolveMicError(err) {
  const name = err?.name
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone permission was denied.'
  }
  if (name === 'NotFoundError') {
    return 'No microphone was found.'
  }
  if (name === 'NotReadableError') {
    return 'Your microphone is in use by another app. Please try again.'
  }
  if (name === 'OverconstrainedError') {
    return 'Selected microphone is no longer available.'
  }
  if (name === 'AbortError') {
    return null // user dismissed the mic permission prompt — safe return
  }
  return 'Could not access your microphone.'
}

// Returns a short, friendly message for a capture API error, or null when
// the flow should silently return to the setup state (e.g. the user simply
// dismissed the native picker — that is not an error to alarm on).
function resolveCaptureError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'AbortError':
      return null // user cancelled the picker — return to setup, no error
    case 'NotSupportedError':
    case 'TypeError':
      return 'Screen sharing is not supported by this browser.'
    case 'NotFoundError':
      return 'No screen, window, or tab was found to share.'
    case 'NotReadableError':
      return 'Your screen could not be accessed. Please check your device and try again.'
    case 'SecurityError':
      return 'Screen sharing was blocked by the browser or your device.'
    default:
      return 'Could not start screen sharing. Please try again.'
  }
}

// Recording formats, most preferred first. Each is only used when the
// browser reports it as supported via MediaRecorder.isTypeSupported().
const MIME_TYPE_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4',
]

// Returns the first browser-supported recording MIME type, or '' to let
// MediaRecorder pick its own default when no candidate is supported.
function pickSupportedMimeType() {
  if (typeof MediaRecorder === 'undefined') return ''
  for (const candidate of MIME_TYPE_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(candidate)) return candidate
    } catch {
      // Some browser versions throw when handed an unsupported string.
    }
  }
  return ''
}

// Map the recorded MIME type to the right file extension (never assume
// ".webm" — a Safari MP4 recording must not be named as WebM).
function extensionForMime(mimeType) {
  const type = String(mimeType || '').toLowerCase()
  if (type.startsWith('video/mp4')) return 'mp4'
  return 'webm'
}

function createRecordingFileName(mimeType) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `screen-recording-${stamp}.${extensionForMime(mimeType)}`
}

// --- Phase 6: webcam compositing helpers --------------------------------

// Returns a short, friendly message for a getUserMedia (camera) error.
function resolveCameraError(err) {
  const name = err?.name
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Camera permission was denied. Please allow camera access or disable the camera.'
  }
  if (name === 'NotFoundError') {
    return 'No camera was found.'
  }
  if (name === 'NotReadableError') {
    return 'Your camera is in use by another app. Please try again.'
  }
  if (name === 'OverconstrainedError') {
    return 'The selected camera is unavailable. Please choose another camera.'
  }
  if (name === 'AbortError') {
    return null // user dismissed the camera prompt — safe return
  }
  return 'Could not access your camera.'
}

// Overlay size as a fraction of the recording canvas width.
const WEBCAM_SIZE_RATIO = { small: 0.18, medium: 0.25, large: 0.32 }
const WEBCAM_MARGIN = 24 // px at 1280-wide canvas, scaled proportionally

// Resolves once the video element has decodable frames (or after a timeout).
function waitForVideoReady(video, timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (!video) return resolve(false)
    if (video.readyState >= 2 && video.videoWidth > 0) return resolve(true)

    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      video.removeEventListener('loadeddata', onReady)
      video.removeEventListener('canplay', onReady)
      clearTimeout(timer)
      clearInterval(poll)
      resolve(ok)
    }
    const onReady = () => finish(true)
    video.addEventListener('loadeddata', onReady)
    video.addEventListener('canplay', onReady)
    const timer = setTimeout(() => finish(video.readyState >= 2), timeoutMs)
    const poll = setInterval(() => {
      if (video.readyState >= 2 && video.videoWidth > 0) finish(true)
    }, 100)
  })
}

// Draws the webcam overlay onto the composite canvas:
//   - S/M/L size as a fraction of the canvas width
//   - circle (clipped) or square shape
//   - optional horizontal mirror (screen content is NEVER mirrored)
//   - TL/TR/BL/BR position with a margin, clamped inside the canvas
//   - cover-style center crop so the camera is never stretched
function drawWebcamOverlay(ctx, canvas, video, settings) {
  const { shape, size, mirror, position } = settings
  const side = Math.round(canvas.width * (WEBCAM_SIZE_RATIO[size] || WEBCAM_SIZE_RATIO.medium))
  const margin = Math.max(12, Math.round((WEBCAM_MARGIN * canvas.width) / 1280))

  const isLeft = position.includes('left')
  const isTop = position.startsWith('top')
  let x = isLeft ? margin : canvas.width - side - margin
  let y = isTop ? margin : canvas.height - side - margin
  x = Math.max(0, Math.min(x, canvas.width - side))
  y = Math.max(0, Math.min(y, canvas.height - side))

  // Cover-style crop: take the largest centered square from the camera
  // source so the overlay is filled without distortion or black bars.
  const sourceWidth = video.videoWidth
  const sourceHeight = video.videoHeight
  if (!sourceWidth || !sourceHeight) return
  const cropSize = Math.min(sourceWidth, sourceHeight)
  const sx = (sourceWidth - cropSize) / 2
  const sy = (sourceHeight - cropSize) / 2

  ctx.save()
  if (shape === 'circle') {
    ctx.beginPath()
    ctx.arc(x + side / 2, y + side / 2, side / 2, 0, Math.PI * 2)
    ctx.clip()
  } else if (shape === 'squircle') {
    // Rounded-square clip ("squircle"). Uses roundRect when available
    // (Chrome/Edge 99+, Firefox 112+) and falls back to a plain square
    // clip elsewhere, so the overlay can never break recording.
    const radius = Math.round(side * 0.24)
    ctx.beginPath()
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, side, side, radius)
    } else {
      ctx.rect(x, y, side, side)
    }
    ctx.clip()
  }
  ctx.translate(x + side / 2, y + side / 2)
  if (mirror) ctx.scale(-1, 1)
  ctx.drawImage(video, sx, sy, cropSize, cropSize, -side / 2, -side / 2, side, side)
  ctx.restore()
}

export function useScreenRecorder({ onCommit } = {}) {
  const [cameraEnabled, setCameraEnabled] = useState(INITIAL_STATE.cameraEnabled)
  const [cameraDeviceId, setCameraDeviceId] = useState(INITIAL_STATE.cameraDeviceId)
  const [cameraShape, setCameraShape] = useState(INITIAL_STATE.cameraShape)
  const [cameraSize, setCameraSize] = useState(INITIAL_STATE.cameraSize)
  const [cameraMirror, setCameraMirror] = useState(INITIAL_STATE.cameraMirror)
  const [cameraPosition, setCameraPosition] = useState(INITIAL_STATE.cameraPosition)
  const [micEnabled, setMicEnabled] = useState(INITIAL_STATE.micEnabled)
  const [micDeviceId, setMicDeviceId] = useState(INITIAL_STATE.micDeviceId)
  const [systemAudioEnabled, setSystemAudioEnabled] = useState(INITIAL_STATE.systemAudioEnabled)
  const [recordingState, setRecordingState] = useState(INITIAL_STATE.recordingState)
  const [error, setError] = useState(INITIAL_STATE.error)
  const [notice, setNotice] = useState(INITIAL_STATE.notice)
  const [devices, setDevices] = useState({ cameras: [], microphones: [] })

  // The canonical stream lives in a ref (never recreated across renders);
  // a state mirror drives the live <video> preview in RecordModal.
  const screenStreamRef = useRef(null)
  const [screenStream, setScreenStream] = useState(null)
  const micStreamRef = useRef(null)
  const [micStream, setMicStream] = useState(null)
  const cameraStreamRef = useRef(null)
  const [cameraStream, setCameraStream] = useState(null)
  const combinedStreamRef = useRef(null)

  // Phase 6 composite internals — all refs, never React state, so the
  // 30 FPS drawing loop never triggers a re-render.
  const screenVideoRef = useRef(null) // hidden <video> playing the screen stream
  const cameraVideoRef = useRef(null) // hidden <video> playing the camera stream
  const recordingCanvasRef = useRef(null)
  const canvasStreamRef = useRef(null)
  const compositeFrameRef = useRef(null) // requestAnimationFrame id
  const startingRef = useRef(false) // blocks double "Start Recording" clicks
  const cameraSettingsRef = useRef({
    shape: INITIAL_STATE.cameraShape,
    size: INITIAL_STATE.cameraSize,
    mirror: INITIAL_STATE.cameraMirror,
    position: INITIAL_STATE.cameraPosition,
  })
  const permissionRequestRef = useRef(false) // blocks duplicate "Share Screen" clicks
  const mountedRef = useRef(true)

  // MediaRecorder internals live in refs so chunk collection never causes
  // re-renders and the recorder object is never recreated unnecessarily.
  const mediaRecorderRef = useRef(null)
  const chunksRef = useRef([])
  const mimeTypeRef = useRef('')
  const onCommitRef = useRef(onCommit)
  const committedRef = useRef(false) // guarantees onCommit() fires exactly once
  const discardRef = useRef(false) // cancel/discard path: never call onCommit()

  // Always invoke the latest onCommit provided by the parent.
  useEffect(() => {
    onCommitRef.current = onCommit
  }, [onCommit])

  // Keep the latest camera settings available to the composite draw loop
  // without recreating it on every settings change.
  useEffect(() => {
    cameraSettingsRef.current = {
      shape: cameraShape,
      size: cameraSize,
      mirror: cameraMirror,
      position: cameraPosition,
    }
  }, [cameraShape, cameraSize, cameraMirror, cameraPosition])

  // Read-only, non-recording: build the device pickers. Labels for real
  // device names only appear once the user grants capture permission
  // (standard browser security behavior); fallbacks are shown meanwhile.
  useEffect(() => {
    let cancelled = false

    async function enumerateCaptureDevices() {
      if (!navigator.mediaDevices?.enumerateDevices) return

      try {
        const list = await navigator.mediaDevices.enumerateDevices()
        if (cancelled) return

        const cameras = list
          .filter((device) => device.kind === 'videoinput')
          .map((device, index) => ({
            deviceId: device.deviceId,
            label: device.label || `Camera ${index + 1}`,
          }))

        const microphones = list
          .filter((device) => device.kind === 'audioinput')
          .map((device, index) => ({
            deviceId: device.deviceId,
            label: device.label || `Microphone ${index + 1}`,
          }))

        setDevices({ cameras, microphones })
      } catch {
        if (!cancelled) setError('Could not list your capture devices.')
      }
    }

    enumerateCaptureDevices()

    return () => {
      cancelled = true
    }
  }, [])

  // Absolute safety net: if the modal unmounts mid-capture, release every
  // track so no screen sharing continues in the background.
  useEffect(() => {
    mountedRef.current = true // re-arm on (re)mount — required under React StrictMode's dev double-mount
    return () => {
      mountedRef.current = false
      const recorder = mediaRecorderRef.current
      if (recorder) {
        try {
          if (recorder.state !== 'inactive') recorder.stop()
        } catch {
          // ignore: recorder may already be finalizing
        }
      }
      const stream = screenStreamRef.current
      if (stream) {
        stream.getTracks().forEach((track) => {
          track.onended = null
          track.stop()
        })
      }
      screenStreamRef.current = null

      // Microphone cleanup on unmount.
      const micStream = micStreamRef.current
      if (micStream) {
        micStream.getTracks().forEach((track) => track.stop())
      }
      micStreamRef.current = null
      combinedStreamRef.current = null
      setMicStream(null)

      // Camera cleanup on unmount.
      const activeCameraStream = cameraStreamRef.current
      if (activeCameraStream) {
        activeCameraStream.getTracks().forEach((track) => track.stop())
      }
      cameraStreamRef.current = null
      setCameraStream(null)

            // Composite teardown on unmount: animation frame, video elements, canvas.
      if (compositeFrameRef.current) {
        cancelAnimationFrame(compositeFrameRef.current)
        compositeFrameRef.current = null
      }
      const activeScreenVideo = screenVideoRef.current
      if (activeScreenVideo) {
        try {
          activeScreenVideo.pause()
          activeScreenVideo.srcObject = null
          // Remove from DOM if we added it there
          if (activeScreenVideo.parentNode) {
            activeScreenVideo.parentNode.removeChild(activeScreenVideo)
          }
        } catch {
          // ignore
        }
        screenVideoRef.current = null
      }
      const activeCameraVideo = cameraVideoRef.current
      if (activeCameraVideo) {
        try {
          activeCameraVideo.pause()
          activeCameraVideo.srcObject = null
        } catch {
          // ignore
        }
        cameraVideoRef.current = null
      }
      canvasStreamRef.current = null
      recordingCanvasRef.current = null

      mediaRecorderRef.current = null
      chunksRef.current = []
      permissionRequestRef.current = false
      committedRef.current = false
    }
  }, [])

  // Stop the webcam tracks + release the camera. Called from every teardown
  // path so the camera LED can never stay on after the recorder closes.
  // NOTE: must be declared BEFORE stopScreenCapture/stopScreenTracks, which
  // reference it in their dependency arrays (TDZ otherwise).
  const stopCameraTracks = useCallback(() => {
    const cameraStream = cameraStreamRef.current
    if (cameraStream) {
      cameraStream.getTracks().forEach((track) => {
        try {
          track.onended = null
          track.stop()
        } catch {
          // ignore: track may already be ended
        }
      })
    }
    cameraStreamRef.current = null
    setCameraStream(null)
    console.debug('[Recorder] Camera cleanup complete')
  }, [])

  // --- Recording lifecycle ---------------------------------------------
  // Stop every track of the active stream and clear the preview. Safe to
  // call when nothing is captured (idempotent). Any active MediaRecorder
  // is stopped first; its onstop sees discardRef and skips finalize.
  const stopScreenCapture = useCallback(() => {
    const recorder = mediaRecorderRef.current
    if (recorder) {
      try {
        if (recorder.state !== 'inactive') recorder.stop()
      } catch {
        // ignore: recorder may already be finalizing
      }
    }
    mediaRecorderRef.current = null
    chunksRef.current = []
    mimeTypeRef.current = ''

    const stream = screenStreamRef.current
    if (stream) {
      stream.getTracks().forEach((track) => {
        track.onended = null
        track.stop()
      })
    }
    screenStreamRef.current = null
    permissionRequestRef.current = false
    setScreenStream(null)
    stopCameraTracks()
    setRecordingState(INITIAL_STATE.recordingState)
    setError(INITIAL_STATE.error)
  }, [stopCameraTracks])

  const stopMicTracks = useCallback(() => {
    const micStream = micStreamRef.current
    if (micStream) {
      micStream.getTracks().forEach((track) => {
        try {
          track.stop()
        } catch {
          // ignore: track may already be ended
        }
      })
    }
    micStreamRef.current = null
    combinedStreamRef.current = null
    setMicStream(null)
    }, [])

  // Build the raw recording stream — passes the original display video track
  // directly to MediaRecorder without any canvas compositing. This preserves
  // Chrome's native surface switching (tab/window changes) because the original
  // MediaStreamTrack is recorded as-is.
  //
  // Used when camera is OFF. No <video>, no canvas, no captureStream.
  const buildRecordingStream = useCallback(() => {
    const screen = screenStreamRef.current
    const mic = micStreamRef.current
    const stream = new MediaStream()
    if (screen) {
      screen.getVideoTracks().forEach((track) => stream.addTrack(track))
      screen.getAudioTracks().forEach((track) => stream.addTrack(track))
    }
    if (mic) {
      mic.getAudioTracks().forEach((track) => stream.addTrack(track))
    }

    // Log the raw display track for diagnostics
    const displayVideoTrack = screen?.getVideoTracks()[0]
    if (displayVideoTrack) {
      const settings = displayVideoTrack.getSettings()
      console.debug('[Recorder] RAW DISPLAY VIDEO TRACK:', {
        label: displayVideoTrack.label,
        readyState: displayVideoTrack.readyState,
        settings: {
          displaySurface: settings.displaySurface,
          width: settings.width,
          height: settings.height,
          frameRate: settings.frameRate,
        },
      })
    }

    console.debug(
      '[Recorder] Raw recording stream built — video tracks:',
      stream.getVideoTracks().length,
      'audio tracks:',
      stream.getAudioTracks().length,
    )
    return stream
  }, [])

  // Phase 6: build the composite recording stream.
  //
  // MediaRecorder cannot reliably encode two video tracks, so the screen
  // and (optional) webcam are composited onto ONE canvas whose
  // captureStream(30) provides the single video track for the recorder.
  // Audio tracks are carried over unchanged (system audio + microphone).
  //
  // Used when camera is ON. Requires <video> + canvas compositing.
  const buildCompositeStream = useCallback(async () => {
    const screen = screenStreamRef.current
    const camera = cameraStreamRef.current
    if (!screen) return null

        // Hidden screen video element (autoplay/muted/playsInline).
    // Must be appended to the DOM for "Entire Screen" captures to work —
    // Chrome requires the video element to be in the document to receive
    // frames from monitor surfaces.
    const screenVideo = document.createElement('video')
    screenVideo.srcObject = screen
    screenVideo.muted = true
    screenVideo.playsInline = true
    screenVideo.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;'
    document.body.appendChild(screenVideo)
    screenVideoRef.current = screenVideo
    try {
      await screenVideo.play()
    } catch {
      // play() may reject until frames arrive; waitForVideoReady handles it.
    }

    // Hidden camera video element (only when a camera stream exists).
    let cameraVideo = null
    if (camera) {
      cameraVideo = document.createElement('video')
      cameraVideo.srcObject = camera
      cameraVideo.muted = true
      cameraVideo.playsInline = true
      cameraVideoRef.current = cameraVideo
      try {
        await cameraVideo.play()
      } catch {
        // ignore: the overlay is skipped per-frame until frames exist
      }
    }

    // Wait until both videos have decodable frames (best-effort timeouts).
    await waitForVideoReady(screenVideo)
    if (cameraVideo) await waitForVideoReady(cameraVideo)

    // Dedicated recording canvas — never the composer canvas. Sized from
    // the actual screen video so the output matches the captured content.
    const canvas = document.createElement('canvas')
    canvas.width = screenVideo.videoWidth || 1280
    canvas.height = screenVideo.videoHeight || 720
    recordingCanvasRef.current = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx || typeof canvas.captureStream !== 'function') {
      console.error('[Recorder] Canvas captureStream is not supported in this browser')
      return null
    }

    const canvasStream = canvas.captureStream(30)
    canvasStreamRef.current = canvasStream
    console.debug('[Recorder] Canvas stream created —', canvas.width, 'x', canvas.height, '@30fps')

        // Composite render loop: screen as full background + webcam overlay.
    // Uses requestAnimationFrame (not requestVideoFrameCallback) because RAF
    // never stops firing — even when the video freezes during a surface switch.
    // This guarantees the loop keeps running and picks up new frames immediately
    // after the video re-syncs.
    const drawFrame = () => {
      compositeFrameRef.current = requestAnimationFrame(drawFrame)
      try {
        // Surface switch may change resolution — keep canvas in sync.
        if (screenVideo.readyState >= 2 && screenVideo.videoWidth > 0) {
          if (canvas.width !== screenVideo.videoWidth || canvas.height !== screenVideo.videoHeight) {
            canvas.width = screenVideo.videoWidth
            canvas.height = screenVideo.videoHeight
            console.debug('[Recorder] Canvas resized for new surface —', canvas.width, 'x', canvas.height)
          }
          ctx.drawImage(screenVideo, 0, 0, canvas.width, canvas.height)
        } else {
          ctx.fillStyle = '#000'
          ctx.fillRect(0, 0, canvas.width, canvas.height)
        }
        const camVideo = cameraVideoRef.current
        if (
          camVideo &&
          cameraStreamRef.current &&
          camVideo.readyState >= 2 &&
          camVideo.videoWidth > 0
        ) {
          // Settings come from cameraSettingsRef so the loop always uses
          // the latest shape/size/mirror/position without being recreated.
          drawWebcamOverlay(ctx, canvas, camVideo, cameraSettingsRef.current)
        }
      } catch {
        // A bad frame must never kill the recording loop.
      }
    }
    drawFrame()
    console.debug('[Recorder] Starting composite render loop')

    // Final stream: exactly ONE video track (the canvas) + existing audio.
    const finalStream = new MediaStream()
    const videoTrack = canvasStream.getVideoTracks()[0]
    if (videoTrack) finalStream.addTrack(videoTrack)
    screen.getAudioTracks().forEach((track) => finalStream.addTrack(track))
    const mic = micStreamRef.current
    if (mic) {
      mic.getAudioTracks().forEach((track) => finalStream.addTrack(track))
    }
    console.debug(
      '[Recorder] Final recording stream created — video tracks:',
      finalStream.getVideoTracks().length,
      'audio tracks:',
      finalStream.getAudioTracks().length,
    )
    return finalStream
  }, [])

  // Stop the display + mic tracks (used after a File has been finalized so
  // the captured chunks are never discarded).
  const stopScreenTracks = useCallback(() => {
    // DIAGNOSTIC: Clean up
    if (window.__recorderDiag) {
      console.debug('[Recorder][DIAGNOSTIC] Cleaning up')
      clearInterval(window.__recorderDiag.interval)
      window.__recorderDiag.video.pause()
      window.__recorderDiag.video.srcObject = null
      if (window.__recorderDiag.video.parentNode) {
        window.__recorderDiag.video.parentNode.removeChild(window.__recorderDiag.video)
      }
      window.__recorderDiag = null
    }

    const stream = screenStreamRef.current
    if (stream) {
      stream.getTracks().forEach((track) => {
        track.onended = null
        track.stop()
      })
    }
    screenStreamRef.current = null
    setScreenStream(null)
    stopMicTracks()
    stopCameraTracks()
  }, [stopMicTracks, stopCameraTracks])

  // Tear down the composite resources (animation loop, hidden video
  // elements, canvas stream). Idempotent — safe to call more than once.
    const teardownComposite = useCallback(() => {
    if (compositeFrameRef.current) {
      cancelAnimationFrame(compositeFrameRef.current)
      compositeFrameRef.current = null
    }
    const screenVideo = screenVideoRef.current
    if (screenVideo) {
      try {
        screenVideo.pause()
        screenVideo.srcObject = null
        // Remove from DOM if we added it there
        if (screenVideo.parentNode) {
          screenVideo.parentNode.removeChild(screenVideo)
        }
      } catch {
        // ignore
      }
      screenVideoRef.current = null
    }
    const cameraVideo = cameraVideoRef.current
    if (cameraVideo) {
      try {
        cameraVideo.pause()
        cameraVideo.srcObject = null
      } catch {
        // ignore
      }
      cameraVideoRef.current = null
    }
    const canvasStream = canvasStreamRef.current
    if (canvasStream) {
      canvasStream.getTracks().forEach((track) => {
        try {
          track.stop()
        } catch {
          // ignore
        }
      })
    }
    canvasStreamRef.current = null
    recordingCanvasRef.current = null
  }, [])

  // Combine the collected chunks into a Blob -> File, then hand the File
  // to the parent exactly once via onCommit(). Screen tracks are stopped
  // only once the File exists.
  const finalizeRecording = useCallback((chunks, mimeType) => {
    if (committedRef.current) return
    setRecordingState('processing')

    try {
      const blob = new Blob(chunks, { type: mimeType })
      if (!blob.size) {
        setError('The recording was empty. Please try again.')
        setRecordingState(INITIAL_STATE.recordingState)
        stopScreenTracks()
        return
      }

      const file = new File(
        [blob],
        createRecordingFileName(mimeType),
        { type: mimeType },
      )
      setRecordingState('completed')
      committedRef.current = true
      stopScreenTracks()
      stopMicTracks() // defense in depth; stopScreenTracks also stops mic
      onCommitRef.current?.(file) // exactly once
    } catch {
      setError('Could not save the recording. Please try again.')
      setRecordingState(INITIAL_STATE.recordingState)
      stopScreenTracks()
    }
  }, [stopScreenTracks])

  // Fired when MediaRecorder stops: normal stop, external stop, or cancel.
  const handleRecorderStop = useCallback(() => {
    // Stop the composite loop/canvas first — the recorder already received
    // its final data, so no more frames are needed.
    if (canvasStreamRef.current) console.debug('[Recorder] Composite recording stopped')
    teardownComposite()

    const recorder = mediaRecorderRef.current
    mediaRecorderRef.current = null
    const chunks = chunksRef.current
    const mimeType = mimeTypeRef.current
    chunksRef.current = []
    mimeTypeRef.current = ''

    if (discardRef.current || committedRef.current || !recorder) {
      discardRef.current = false
      stopMicTracks()
      stopCameraTracks()
      return
    }

    finalizeRecording(chunks, mimeType)
  }, [finalizeRecording, stopMicTracks, stopCameraTracks, teardownComposite])

  // The user (or the browser/OS) stopped sharing — e.g. Chrome's native
  // "Stop sharing" control.
  const handleTrackEnded = useCallback(() => {
    const recorder = mediaRecorderRef.current

    if (
      recorder &&
      recorder.state === 'recording' &&
      !discardRef.current &&
      !committedRef.current
    ) {
      // Sharing stopped externally mid-recording: salvage the collected
      // chunks by finalizing normally instead of losing them.
      discardRef.current = false
      setRecordingState('stopping')
      try {
        recorder.stop()
      } catch {
        finalizeRecording(chunksRef.current, mimeTypeRef.current)
      }
      return
    }

    // A stop/finalize is already in progress — let it finish.
    if (
      recordingState === 'stopping' ||
      recordingState === 'processing' ||
      recordingState === 'completed'
    ) {
      return
    }

    // Not recording — plain stop of the share.
    stopScreenCapture()
    stopMicTracks()
    setNotice('Screen sharing stopped.')
  }, [finalizeRecording, stopScreenCapture, stopMicTracks, recordingState])

  // Camera disconnected (USB unplug, OS privacy switch, app closed it...).
  // Graceful: drop the webcam overlay and keep recording screen + audio.
  // The composite draw loop skips the overlay once cameraStreamRef clears.
  const handleCameraTrackEnded = useCallback(() => {
    console.debug('[Recorder] Camera track ended')
    const wasRecording = recordingState === 'recording'
    stopCameraTracks()
    if (wasRecording) {
      setNotice('Camera disconnected. Recording will continue without camera.')
    } else {
      setNotice('Camera disconnected.')
    }
  }, [recordingState, stopCameraTracks])

  // Create a MediaRecorder for the recording stream and collect chunks into
  // a ref (never React state). Camera ON  -> composited canvas stream with
  // ONE video track; Camera OFF -> the raw screen stream (Phase 5 path).
  const startRecording = useCallback(async () => {
    const screen = screenStreamRef.current
    if (!screen || mediaRecorderRef.current || startingRef.current) return
    if (recordingState !== 'ready' && recordingState !== 'error') return
    if (typeof MediaRecorder === 'undefined') {
      setError('Recording is not supported by this browser.')
      return
    }

    const mimeType = pickSupportedMimeType()
    if (mimeType && !MediaRecorder.isTypeSupported(mimeType)) {
      setError('Recording is not supported by this browser.')
      return
    }

    startingRef.current = true

    try {
      let recordingStream = null
      const usingComposite = Boolean(cameraStreamRef.current)

      if (usingComposite) {
        // Camera ON: composite screen + webcam onto one canvas stream
        console.debug('[Recorder] Recording mode: SCREEN + WEBCAM COMPOSITE')
        recordingStream = await buildCompositeStream()
        if (!recordingStream) {
          setError('Could not prepare the webcam composite. Please try again.')
          return
        }
      } else {
        // Camera OFF: pass the raw display stream directly to MediaRecorder
        // This preserves Chrome's native surface switching (tab/window changes)
        console.debug('[Recorder] Recording mode: RAW DISPLAY')
        recordingStream = buildRecordingStream()
      }
      combinedStreamRef.current = recordingStream

      // DIAGNOSTIC: Log MediaRecorder input tracks
      console.debug('[Recorder][MEDIARECORDER INPUT]', {
        videoTracks: recordingStream.getVideoTracks().map(t => ({
          label: t.label,
          readyState: t.readyState,
          enabled: t.enabled,
          muted: t.muted,
          settings: t.getSettings?.(),
        })),
        audioTracks: recordingStream.getAudioTracks().map(t => ({
          label: t.label,
          readyState: t.readyState,
        })),
      })

      const recorder = mimeType
        ? new MediaRecorder(recordingStream, { mimeType })
        : new MediaRecorder(recordingStream)

      mimeTypeRef.current = mimeType || recorder.mimeType || 'video/webm'
      chunksRef.current = []
      discardRef.current = false

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          chunksRef.current.push(event.data)
        }
      }

      recorder.onerror = () => {
        if (discardRef.current || committedRef.current) return
        discardRef.current = true
        setError('Recording failed. Please try again.')
        try {
          if (recorder.state !== 'inactive') recorder.stop()
        } catch {
          // ignore
        }
        stopScreenTracks()
        setRecordingState(INITIAL_STATE.recordingState)
      }

      recorder.onstop = handleRecorderStop

      mediaRecorderRef.current = recorder
      recorder.start(1000) // emit chunks periodically for safety
      if (usingComposite) {
        console.debug('[Recorder] Recording started (composite)')
      } else {
        console.debug('[Recorder] Recording started (raw display)')
      }
      setRecordingState('recording')
    } catch (err) {
      console.error('[Recorder] Failed to start recording:', err?.name, '—', err?.message)
      teardownComposite()
      mediaRecorderRef.current = null
      setError('Could not start recording. Please try again.')
      setRecordingState(INITIAL_STATE.recordingState)
    } finally {
      startingRef.current = false
    }
  }, [recordingState, handleRecorderStop, stopScreenTracks, buildRecordingStream, buildCompositeStream, teardownComposite])

  // User clicked Stop Recording: finalize (never discard), then clean up.
  const stopRecording = useCallback(() => {
    if (recordingState !== 'recording') return
    const recorder = mediaRecorderRef.current
    if (!recorder || recorder.state !== 'recording') return

    discardRef.current = false
    setRecordingState('stopping')
    try {
      recorder.stop()
    } catch {
      mediaRecorderRef.current = null
      finalizeRecording(chunksRef.current, mimeTypeRef.current)
    }
  }, [recordingState, finalizeRecording])

  // Open the browser's native screen/window/tab picker, then (if the user
  // enabled the microphone) request the chosen mic. Must be called
  // synchronously from a user gesture (button click) — browsers require it.
  const startScreenCapture = useCallback(async () => {
    // Duplicate-click guard: only one permission request at a time.
    if (permissionRequestRef.current) return
    if (screenStreamRef.current) return

    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      console.error('[Recorder] Screen capture unsupported: navigator.mediaDevices.getDisplayMedia unavailable')
      setError('Screen sharing is not supported by this browser.')
      return
    }

    console.debug('[Recorder] Share Screen clicked — opening native screen picker')
    setNotice('')
    setError('')
    setRecordingState('requesting_permission')
    permissionRequestRef.current = true

    // Fresh session — ensure no leftover mic/camera streams from before.
    stopMicTracks()
    stopCameraTracks()

    let screenStream = null
    let micStream = null

    try {
      // --- Step 1: screen picker (getDisplayMedia) ---------------------
      console.debug('[Recorder] Requesting screen capture (getDisplayMedia)')
      try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: systemAudioEnabled,
        })
      } catch (err) {
        if (systemAudioEnabled && (err?.name === 'TypeError' || err?.name === 'NotSupportedError')) {
          console.debug('[Recorder] System audio constraint rejected — retrying video-only')
          screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true })
        } else {
          throw err
        }
      }
      console.debug(
        '[Recorder] Display media granted. video tracks:',
        screenStream?.getVideoTracks()?.length ?? 0,
        'audio tracks:',
        screenStream?.getAudioTracks()?.length ?? 0,
      )

      // DIAGNOSTIC: Log initial display track state
      const diagnosticVideoTrack = screenStream?.getVideoTracks()[0]
      if (diagnosticVideoTrack) {
        const diagSettings = diagnosticVideoTrack.getSettings()
        console.debug('[Recorder][DISPLAY TRACK] INITIAL', {
          label: diagnosticVideoTrack.label,
          readyState: diagnosticVideoTrack.readyState,
          settings: { displaySurface: diagSettings.displaySurface, width: diagSettings.width, height: diagSettings.height },
        })
        diagnosticVideoTrack.addEventListener('mute', () => console.debug('[Recorder][DISPLAY TRACK] MUTE'))
        diagnosticVideoTrack.addEventListener('unmute', () => console.debug('[Recorder][DISPLAY TRACK] UNMUTE'))
        diagnosticVideoTrack.addEventListener('ended', () => console.debug('[Recorder][DISPLAY TRACK] ENDED'))

        // DIAGNOSTIC: Create video element to observe raw frames
        const diagnosticVideo = document.createElement('video')
        diagnosticVideo.srcObject = screenStream
        diagnosticVideo.muted = true
        diagnosticVideo.playsInline = true
        diagnosticVideo.autoplay = true
        diagnosticVideo.style.cssText = 'position:fixed;right:10px;bottom:60px;width:320px;height:180px;z-index:999999;background:black;border:3px solid red;'
        document.body.appendChild(diagnosticVideo)
        diagnosticVideo.play().then(() => {
          console.debug('[Recorder][DIAGNOSTIC] Video playing')
        }).catch(err => console.error('[Recorder][DIAGNOSTIC] Play failed:', err?.message))

        // DIAGNOSTIC: Count frames
        let frameCount = 0
        const observeFrame = (now, metadata) => {
          frameCount++
          console.debug('[Recorder][RAW FRAME]', { frameCount, mediaTime: metadata.mediaTime, presentedFrames: metadata.presentedFrames })
          if (diagnosticVideo.requestVideoFrameCallback) {
            diagnosticVideo.requestVideoFrameCallback(observeFrame)
          }
        }
        if (diagnosticVideo.requestVideoFrameCallback) {
          diagnosticVideo.requestVideoFrameCallback(observeFrame)
        }

        // DIAGNOSTIC: Periodic status
        const diagInterval = setInterval(() => {
          console.debug('[Recorder][DIAGNOSTIC] STATUS', {
            readyState: diagnosticVideoTrack.readyState,
            videoWidth: diagnosticVideo.videoWidth,
            videoHeight: diagnosticVideo.videoHeight,
            currentTime: diagnosticVideo.currentTime,
            frameCount,
          })
        }, 2000)

        window.__recorderDiag = { video: diagnosticVideo, interval: diagInterval }
      }

      if (!screenStream) throw new Error('getDisplayMedia resolved without a MediaStream')

      // Modal closed while the picker was open — teardown and reset state.
      if (!mountedRef.current) {
        stopScreenTracks() // also stops any mic tracks
        permissionRequestRef.current = false
        setRecordingState(INITIAL_STATE.recordingState)
        return
      }

      screenStreamRef.current = screenStream
      setScreenStream(screenStream)

      // --- Step 2: optional microphone (NEVER before screen selection) --
      if (micEnabled) {
        console.debug('[Recorder] Requesting microphone (getUserMedia)')
        try {
          const constraints = micDeviceId
            ? { audio: { deviceId: { exact: micDeviceId } }, video: false }
            : { audio: true, video: false }
          micStream = await navigator.mediaDevices.getUserMedia(constraints)
          console.debug('[Recorder] Microphone granted. audio tracks:', micStream?.getAudioTracks()?.length ?? 0)

          if (!mountedRef.current) {
            micStream.getTracks().forEach((track) => track.stop())
            stopScreenTracks()
            permissionRequestRef.current = false
            setRecordingState(INITIAL_STATE.recordingState)
            return
          }

          micStreamRef.current = micStream
          setMicStream(micStream)

          // Refresh enumeration so real mic labels appear now that permission
          // was granted. Best-effort — failure is harmless.
          try {
            const list = await navigator.mediaDevices.enumerateDevices()
            const microphones = list
              .filter((device) => device.kind === 'audioinput')
              .map((device, index) => ({
                deviceId: device.deviceId,
                label: device.label || `Microphone ${index + 1}`,
              }))
            setDevices((prev) => ({ ...prev, microphones }))
          } catch {
            // keep the existing device list
          }
        } catch (micErr) {
          // Never leave the UI at 'requesting_permission' on mic failure:
          // stop screen + mic tracks, return to idle with a friendly error.
          console.error('[Recorder] Microphone permission failed:', micErr?.name)
          stopScreenTracks()
          screenStreamRef.current = null
          setScreenStream(null)
          permissionRequestRef.current = false
          setRecordingState(INITIAL_STATE.recordingState)
          const message = resolveMicError(micErr)
          if (message) setError(message)
          return
        }
      }

      // --- Step 2b: optional camera (ONLY after screen selection) --------
      if (cameraEnabled) {
        console.debug('[Recorder] Requesting camera (getUserMedia)')
        try {
          const cameraConstraints = cameraDeviceId
            ? { video: { deviceId: { exact: cameraDeviceId } }, audio: false }
            : { video: true, audio: false }
          const camStream = await navigator.mediaDevices.getUserMedia(cameraConstraints)
          console.debug('[Recorder] Camera granted. video tracks:', camStream?.getVideoTracks()?.length ?? 0)

          if (!mountedRef.current) {
            camStream.getTracks().forEach((track) => track.stop())
            stopScreenTracks() // also stops mic + camera
            permissionRequestRef.current = false
            setRecordingState(INITIAL_STATE.recordingState)
            return
          }

          cameraStreamRef.current = camStream
          setCameraStream(camStream)

          // Camera disconnect mid-session: drop the overlay, keep recording.
          const cameraTrack = camStream.getVideoTracks()[0]
          if (cameraTrack) cameraTrack.onended = handleCameraTrackEnded

          // Refresh enumeration so real camera labels appear now that
          // permission was granted. Best-effort — failure is harmless.
          try {
            const list = await navigator.mediaDevices.enumerateDevices()
            const cameras = list
              .filter((device) => device.kind === 'videoinput')
              .map((device, index) => ({
                deviceId: device.deviceId,
                label: device.label || `Camera ${index + 1}`,
              }))
            setDevices((prev) => ({ ...prev, cameras }))
          } catch {
            // keep the existing device list
          }
        } catch (camErr) {
          // Never leave the UI at 'requesting_permission' on camera failure:
          // stop everything acquired so far, return to idle with a friendly
          // error. No recording starts, no onCommit is called.
          console.error('[Recorder] Camera permission failed:', camErr?.name)
          stopScreenTracks() // stops screen + mic + camera
          permissionRequestRef.current = false
          setRecordingState(INITIAL_STATE.recordingState)
          const message = resolveCameraError(camErr)
          if (message) setError(message)
          return
        }
      }

            // --- Step 3: ready -------------------------------------------------
      const videoTrack = screenStream.getVideoTracks()[0]
      if (videoTrack) {
        videoTrack.onended = handleTrackEnded

        // Surface switching (tab/window change) fires mute -> content change -> unmute.
        // The video element may freeze on the last frame before mute; re-play on
        // unmute so the canvas compositor picks up the new surface immediately.
        videoTrack.onmute = () => {
          console.debug('[Recorder] Display track muted — surface switch in progress')
        }
        videoTrack.onunmute = () => {
          console.debug('[Recorder] Display track unmuted — surface switch complete')
          const sv = screenVideoRef.current
          if (sv) {
            // Re-play to re-sync the video element with the new surface frames
            sv.play().catch(() => { /* ignore: play may reject during transition */ })
          }
        }
      }

      permissionRequestRef.current = false
      committedRef.current = false
      discardRef.current = false
      console.debug(
        '[Recorder] Ready — screen +',
        micStream ? `mic (${micStream.getAudioTracks().length})` : micEnabled ? 'mic MISSING' : 'no mic',
      )
      setRecordingState('ready')
    } catch (err) {
      // Guarantee: never stuck on 'requesting_permission'. Recover to idle.
      console.error('[Recorder] Screen capture failed:', err?.name, '—', err?.message)
      stopScreenTracks()
      screenStreamRef.current = null
      setScreenStream(null)
      permissionRequestRef.current = false
      setRecordingState(INITIAL_STATE.recordingState)
      const message = resolveCaptureError(err)
      if (message) setError(message)
    } finally {
      permissionRequestRef.current = false
    }
  }, [systemAudioEnabled, micEnabled, micDeviceId, cameraEnabled, cameraDeviceId, handleTrackEnded, handleCameraTrackEnded, stopScreenTracks, stopMicTracks, stopCameraTracks])

  // Re-enter the fresh setup state (used by Cancel).
  const reset = useCallback(() => {
    // Cancel path: mark the recording for discard (never onCommit), stop
    // the recorder, then stop the screen + mic tracks.
    discardRef.current = true
    const recorder = mediaRecorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop()
      } catch {
        // ignore
      }
    }
    stopScreenCapture()
    stopMicTracks()
    setNotice(INITIAL_STATE.notice)
  }, [stopScreenCapture, stopMicTracks])

  return {
    devices,

    cameraEnabled,
    setCameraEnabled,
    cameraDeviceId,
    setCameraDeviceId,
    cameraShape,
    setCameraShape,
    cameraSize,
    setCameraSize,
    cameraMirror,
    setCameraMirror,
    cameraPosition,
    setCameraPosition,

    micEnabled,
    setMicEnabled,
    micDeviceId,
    setMicDeviceId,

    micStream,
    cameraStream,
    systemAudioEnabled,
    setSystemAudioEnabled,

    recordingState,
    screenStream,
    error,
    notice,
    startScreenCapture,
    stopScreenCapture,
    startRecording,
    stopRecording,
    reset,
  }
}

export default useScreenRecorder