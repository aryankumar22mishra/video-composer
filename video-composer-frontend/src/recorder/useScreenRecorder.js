// Screen recording via the browser MediaRecorder API.
//
// Flow:
//
// Share Screen
//   -> getDisplayMedia()
//   -> optional microphone
//   -> optional webcam
//   -> (camera ON) second raw webcam MediaRecorder
//   -> MediaRecorder
//   -> chunks
//   -> Blob
//   -> File
//   -> recording review
//   -> onCommit(file)
//
// Important:
// - Screen/window/tab capture is controlled by the browser.
// - The application never programmatically changes the captured source.
// - Camera OFF: the raw display MediaStream goes straight into
//   MediaRecorder (no canvas, no frame callbacks, no hidden videos).
// - Camera ON: two raw recorders run in parallel (screen + webcam) and
//   the two files are saved independently for a later FFmpeg merge.
//   No main-thread canvas is used, so background-tab throttling cannot
//   freeze the recording.
// - Track mute/unmute/ended are diagnostic-only: they never pause or
//   resume MediaRecorder.

import { useCallback, useEffect, useRef, useState } from 'react'
import CompositorWorker from './compositor.worker.js?worker'

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

const MIME_TYPE_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4',
]

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

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
    return null
  }

  return 'Could not access your microphone.'
}

function resolveCaptureError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'AbortError':
      return null

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
    return null
  }

  return 'Could not access your camera.'
}

// ---------------------------------------------------------------------------
// Recording helpers
// ---------------------------------------------------------------------------

function pickSupportedMimeType() {
  if (typeof MediaRecorder === 'undefined') return ''

  for (const candidate of MIME_TYPE_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(candidate)) {
        return candidate
      }
    } catch {
      // Ignore unsupported MIME types.
    }
  }

  return ''
}

function extensionForMime(mimeType) {
  const type = String(mimeType || '').toLowerCase()

  if (type.startsWith('video/mp4')) {
    return 'mp4'
  }

  return 'webm'
}

function createRecordingFileName(mimeType, prefix = 'screen-recording') {
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')

  return `${prefix}-${stamp}.${extensionForMime(mimeType)}`
}

// Makes an empty MediaStream and adds the given tracks to it (Chrome's
// MediaStream constructor accepts no arguments in all supported versions).
function streamFromTracks(tracks) {
  const stream = new MediaStream()
  tracks.forEach((track) => stream.addTrack(track))
  return stream
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useScreenRecorder({ onCommit } = {}) {
  const [cameraEnabled, setCameraEnabled] = useState(
    INITIAL_STATE.cameraEnabled,
  )

  const [cameraDeviceId, setCameraDeviceId] = useState(
    INITIAL_STATE.cameraDeviceId,
  )

  const [cameraShape, setCameraShape] = useState(
    INITIAL_STATE.cameraShape,
  )

  const [cameraSize, setCameraSize] = useState(
    INITIAL_STATE.cameraSize,
  )

  const [cameraMirror, setCameraMirror] = useState(
    INITIAL_STATE.cameraMirror,
  )

  const [cameraPosition, setCameraPosition] = useState(
    INITIAL_STATE.cameraPosition,
  )

  const [micEnabled, setMicEnabled] = useState(
    INITIAL_STATE.micEnabled,
  )

  const [micDeviceId, setMicDeviceId] = useState(
    INITIAL_STATE.micDeviceId,
  )

  const [systemAudioEnabled, setSystemAudioEnabled] =
    useState(INITIAL_STATE.systemAudioEnabled)

  const [recordingState, setRecordingState] = useState(
    INITIAL_STATE.recordingState,
  )

  const [error, setError] = useState(
    INITIAL_STATE.error,
  )

  const [notice, setNotice] = useState(
    INITIAL_STATE.notice,
  )

  const [devices, setDevices] = useState({
    cameras: [],
    microphones: [],
  })

  // -------------------------------------------------------------------------
  // Streams
  // -------------------------------------------------------------------------

  const screenStreamRef = useRef(null)
  const [screenStream, setScreenStream] = useState(null)

  const micStreamRef = useRef(null)
  const [micStream, setMicStream] = useState(null)

  const cameraStreamRef = useRef(null)
  const [cameraStream, setCameraStream] = useState(null)

  const combinedStreamRef = useRef(null)

  // WebAudio mixer (screen + microphone -> ONE audio track). Held while a
  // recording is active so the AudioContext stays alive for the MediaRecorder.
  const audioMixRef = useRef(null) // { ctx, destination }

  // -------------------------------------------------------------------------
  // Composite recording internals
  // -------------------------------------------------------------------------

  const screenVideoRef = useRef(null)
  const cameraVideoRef = useRef(null)

  const recordingCanvasRef = useRef(null)
  const canvasStreamRef = useRef(null)

  // Legacy composite-loop handles. The compositor was removed (both camera
  // paths record raw tracks now), but teardown still clears them defensively.
  const compositeFrameRef = useRef(null)

  // Fallback requestAnimationFrame handle.
  const compositeAnimationFrameRef = useRef(null)

  // Indicates which compositor mechanism is currently active.
  const compositeModeRef = useRef(null)

  // OffscreenCanvas compositor worker (Option B) - renders screen + webcam
  // into the recording canvas from a Web Worker, so background-tab
  // throttling cannot freeze the composite.
  const compositorWorkerRef = useRef(null)

  const startingRef = useRef(false)

  const cameraSettingsRef = useRef({
    shape: INITIAL_STATE.cameraShape,
    size: INITIAL_STATE.cameraSize,
    mirror: INITIAL_STATE.cameraMirror,
    position: INITIAL_STATE.cameraPosition,
  })

  const permissionRequestRef = useRef(false)
  const mountedRef = useRef(true)

  // -------------------------------------------------------------------------
  // MediaRecorder internals
  // -------------------------------------------------------------------------

  const mediaRecorderRef = useRef(null)
  const chunksRef = useRef([])
  const mimeTypeRef = useRef('')

  const onCommitRef = useRef(onCommit)

  const committedRef = useRef(false)
  const discardRef = useRef(false)

  const recordingFileRef = useRef(null)
  const deliveredRef = useRef(false)

  const [recordingFile, setRecordingFile] = useState(null)

  // Second raw recorder (webcam). The camera track is recorded separately
  // from the screen track and both files are kept independently so a later
  // FFmpeg pass can merge/overlay them.
  const cameraRecorderRef = useRef(null)
  const cameraChunksRef = useRef([])
  const cameraMimeTypeRef = useRef('')

  const recordingCameraFileRef = useRef(null)
  const [recordingCameraFile, setRecordingCameraFile] = useState(null)

  // -------------------------------------------------------------------------
  // WebAudio audio mixing (screen + microphone -> ONE audio track)
  // -------------------------------------------------------------------------
  //
  // Chrome's MediaRecorder encodes a single audio track from the input
  // MediaStream. Adding system audio and the microphone as two separate raw
  // tracks silently drops one of them from the output. When both are present
  // we mix them through WebAudio into one destination track (the same proven
  // approach OpenVid uses). Degrades gracefully to raw tracks when WebAudio
  // /AudioContext is unavailable in the browser.

  const buildAudioMixedStream = useCallback((screen, mic) => {
    const screenAudioTracks = screen ? screen.getAudioTracks() : []
    const micAudioTracks = mic ? mic.getAudioTracks() : []
    if (micAudioTracks.length === 0 || screenAudioTracks.length === 0) return null

    const AudioCtx =
      typeof window === 'undefined'
        ? null
        : window.AudioContext || (window.webkitAudioContext ?? null)
    if (!AudioCtx) return null

    try {
      const ctx = new AudioCtx()
      const destination = ctx.createMediaStreamDestination()

      const screenSource = ctx.createMediaStreamSource(
        streamFromTracks(screenAudioTracks)
      )
      screenSource.connect(destination)

      const micSource = ctx.createMediaStreamSource(
        streamFromTracks(micAudioTracks)
      )
      const micGain = ctx.createGain()
      micGain.gain.value = 1
      micSource.connect(micGain)
      micGain.connect(destination)

      audioMixRef.current = { ctx, destination }
      return destination.stream
    } catch (err) {
      console.warn(
        '[Recorder] Audio mixing unavailable — recording raw audio tracks:',
        err?.message ?? err,
      )
      return null
    }
  }, [])

  const teardownAudioMix = useCallback(() => {
    const mix = audioMixRef.current
    audioMixRef.current = null
    if (!mix) return
    try {
      if (mix.ctx.state !== 'closed') mix.ctx.close()
    } catch {
      // Ignore: the context may already be closed.
    }
  }, [])

  // -------------------------------------------------------------------------
  // Keep latest parent callback
  // -------------------------------------------------------------------------

  useEffect(() => {
    onCommitRef.current = onCommit
  }, [onCommit])

  // -------------------------------------------------------------------------
  // Keep latest camera settings available to compositor
  // -------------------------------------------------------------------------

  useEffect(() => {
    cameraSettingsRef.current = {
      shape: cameraShape,
      size: cameraSize,
      mirror: cameraMirror,
      position: cameraPosition,
    }
  }, [
    cameraShape,
    cameraSize,
    cameraMirror,
    cameraPosition,
  ])

  // -------------------------------------------------------------------------
  // Enumerate devices
  // -------------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false

    async function enumerateCaptureDevices() {
      if (!navigator.mediaDevices?.enumerateDevices) {
        return
      }

      try {
        const list =
          await navigator.mediaDevices.enumerateDevices()

        if (cancelled) return

        const cameras = list
          .filter(
            (device) =>
              device.kind === 'videoinput',
          )
          .map((device, index) => ({
            deviceId: device.deviceId,
            label:
              device.label ||
              `Camera ${index + 1}`,
          }))

        const microphones = list
          .filter(
            (device) =>
              device.kind === 'audioinput',
          )
          .map((device, index) => ({
            deviceId: device.deviceId,
            label:
              device.label ||
              `Microphone ${index + 1}`,
          }))

        setDevices({
          cameras,
          microphones,
        })
      } catch {
        if (!cancelled) {
          setError(
            'Could not list your capture devices.',
          )
        }
      }
    }

    enumerateCaptureDevices()

    return () => {
      cancelled = true
    }
  }, [])

  // -------------------------------------------------------------------------
  // Camera recorder (second raw recorder for the webcam track)
  // -------------------------------------------------------------------------

  const stopCameraRecorder = useCallback(() => {
    const cameraRecorder =
      cameraRecorderRef.current

    if (
      cameraRecorder &&
      cameraRecorder.state !== 'inactive'
    ) {
      try {
        cameraRecorder.stop()
      } catch {
        // Ignore.
      }
    }

    cameraRecorderRef.current = null
  }, [])

  // -------------------------------------------------------------------------
  // Unmount cleanup
  // -------------------------------------------------------------------------

  useEffect(() => {
    mountedRef.current = true

    return () => {
      mountedRef.current = false

      const recorder =
        mediaRecorderRef.current

      if (recorder) {
        try {
          if (recorder.state !== 'inactive') {
            recorder.stop()
          }
        } catch {
          // Ignore.
        }
      }

      const screen =
        screenStreamRef.current

      if (screen) {
        screen.getTracks().forEach((track) => {
          track.onended = null

          try {
            track.stop()
          } catch {
            // Ignore.
          }
        })
      }

      screenStreamRef.current = null

      const mic =
        micStreamRef.current

      if (mic) {
        mic.getTracks().forEach((track) => {
          try {
            track.stop()
          } catch {
            // Ignore.
          }
        })
      }

      micStreamRef.current = null

      const camera =
        cameraStreamRef.current

      if (camera) {
        camera.getTracks().forEach((track) => {
          track.onended = null

          try {
            track.stop()
          } catch {
            // Ignore.
          }
        })
      }

      cameraStreamRef.current = null

      // Stop fallback animation frame.
      if (
        compositeAnimationFrameRef.current
      ) {
        cancelAnimationFrame(
          compositeAnimationFrameRef.current,
        )

        compositeAnimationFrameRef.current = null
      }

      // Legacy composite-loop handles (never set anymore) â€” cleared defensively.
      compositeFrameRef.current = null

      const screenVideo =
        screenVideoRef.current

      if (screenVideo) {
        try {
          screenVideo.pause()
          screenVideo.srcObject = null
          if (screenVideo.parentNode) {
            screenVideo.parentNode.removeChild(screenVideo)
          }
        } catch {
          // Ignore.
        }
      }

      screenVideoRef.current = null

      const cameraVideo =
        cameraVideoRef.current

      if (cameraVideo) {
        try {
          cameraVideo.pause()
          cameraVideo.srcObject = null
          if (cameraVideo.parentNode) {
            cameraVideo.parentNode.removeChild(cameraVideo)
          }
        } catch {
          // Ignore.
        }
      }

      cameraVideoRef.current = null

      const canvasStream =
        canvasStreamRef.current

      if (canvasStream) {
        canvasStream.getTracks().forEach(
          (track) => {
            try {
              track.stop()
            } catch {
              // Ignore.
            }
          },
        )
      }

      mediaRecorderRef.current = null
      chunksRef.current = []
      mimeTypeRef.current = ''
      combinedStreamRef.current = null
      canvasStreamRef.current = null
      recordingCanvasRef.current = null
      permissionRequestRef.current = false

      teardownAudioMix()

      stopCameraRecorder()
      recordingCameraFileRef.current = null
    }
  }, [teardownAudioMix, stopCameraRecorder])

  // -------------------------------------------------------------------------
  // Camera cleanup
  // -------------------------------------------------------------------------

  const stopCameraTracks = useCallback(() => {
    const camera =
      cameraStreamRef.current

    if (camera) {
      camera.getTracks().forEach((track) => {
        try {
          track.onended = null
          track.stop()
        } catch {
          // Ignore.
        }
      })
    }

    cameraStreamRef.current = null
    setCameraStream(null)

    console.debug(
      '[Recorder] Camera cleanup complete',
    )
  }, [])

  // -------------------------------------------------------------------------
  // Composite teardown
  // -------------------------------------------------------------------------

  const teardownComposite = useCallback(() => {
    if (
      compositeAnimationFrameRef.current
    ) {
      cancelAnimationFrame(
        compositeAnimationFrameRef.current,
      )

      compositeAnimationFrameRef.current = null
    }

    compositeFrameRef.current = null
    compositeModeRef.current = null

    const screenVideo =
      screenVideoRef.current

    if (screenVideo) {
      try {
        screenVideo.pause()
        screenVideo.srcObject = null
        if (screenVideo.parentNode) {
          screenVideo.parentNode.removeChild(screenVideo)
        }
      } catch {
        // Ignore.
      }

      screenVideoRef.current = null
    }

    const cameraVideo =
      cameraVideoRef.current

    if (cameraVideo) {
      try {
        cameraVideo.pause()
        cameraVideo.srcObject = null
        if (cameraVideo.parentNode) {
          cameraVideo.parentNode.removeChild(cameraVideo)
        }
      } catch {
        // Ignore.
      }

      cameraVideoRef.current = null
    }

    const canvasStream =
      canvasStreamRef.current

    if (canvasStream) {
      canvasStream.getTracks().forEach(
        (track) => {
          try {
            track.stop()
          } catch {
            // Ignore.
          }
        },
      )
    }

    const compositeCanvas =
      recordingCanvasRef.current

    if (compositeCanvas && compositeCanvas.parentNode) {
      try {
        compositeCanvas.parentNode.removeChild(compositeCanvas)
      } catch {
        // Ignore.
      }
    }

    canvasStreamRef.current = null
    recordingCanvasRef.current = null

    const compositeWorker =
      compositorWorkerRef.current

    compositorWorkerRef.current = null

    if (compositeWorker) {
      try {
        compositeWorker.terminate()
      } catch {
        // Ignore.
      }
    }

    teardownAudioMix()
  }, [teardownAudioMix])

  // -------------------------------------------------------------------------
  // Stop screen capture
  // -------------------------------------------------------------------------

  const stopScreenCapture = useCallback(() => {
    const recorder =
      mediaRecorderRef.current

    if (recorder) {
      try {
        if (recorder.state !== 'inactive') {
          recorder.stop()
        }
      } catch {
        // Ignore.
      }
    }

    mediaRecorderRef.current = null
    chunksRef.current = []
    mimeTypeRef.current = ''

    stopCameraRecorder()
    cameraChunksRef.current = []
    cameraMimeTypeRef.current = ''

    const screen =
      screenStreamRef.current

    if (screen) {
      screen.getTracks().forEach((track) => {
        track.onended = null

        try {
          track.stop()
        } catch {
          // Ignore.
        }
      })
    }

    screenStreamRef.current = null
    permissionRequestRef.current = false

    setScreenStream(null)

    stopCameraTracks()

    setRecordingState(
      INITIAL_STATE.recordingState,
    )

    setError(INITIAL_STATE.error)
  }, [stopCameraRecorder, stopCameraTracks])

  // -------------------------------------------------------------------------
  // Stop microphone
  // -------------------------------------------------------------------------

  const stopMicTracks = useCallback(() => {
    const mic =
      micStreamRef.current

    if (mic) {
      mic.getTracks().forEach((track) => {
        try {
          track.stop()
        } catch {
          // Ignore.
        }
      })
    }

    micStreamRef.current = null
    combinedStreamRef.current = null

    setMicStream(null)
  }, [])

  // -------------------------------------------------------------------------
  // Build raw recording stream
  // -------------------------------------------------------------------------

  const buildRecordingStream = useCallback(() => {
    const screen =
      screenStreamRef.current

    const mic =
      micStreamRef.current

    const stream =
      new MediaStream()

    if (screen) {
      screen
        .getVideoTracks()
        .forEach((track) => {
          stream.addTrack(track)
        })
    }

    // Audio: WebAudio mix (screen + mic) into ONE track when both are
    // present — MediaRecorder encodes a single audio track. Degrades to the
    // raw tracks when AudioContext is unavailable.
    const mixedAudio =
      buildAudioMixedStream(screen, mic)

    if (mixedAudio) {
      mixedAudio
        .getAudioTracks()
        .forEach((track) => {
          stream.addTrack(track)
        })
    } else {
      if (screen) {
        screen
          .getAudioTracks()
          .forEach((track) => {
            stream.addTrack(track)
          })
      }

      if (mic) {
        mic
          .getAudioTracks()
          .forEach((track) => {
            stream.addTrack(track)
          })
      }
    }

    return stream
  }, [buildAudioMixedStream])

  // -------------------------------------------------------------------------
  // Build raw camera recording stream
  // -------------------------------------------------------------------------
  //
  // The webcam is recorded as its own raw MediaStream (video only) by a
  // second MediaRecorder. No canvas: raw tracks keep flowing while the tab
  // is backgrounded, so nothing freezes on tab switch.

  const buildCameraRecordingStream = useCallback(() => {
    const camera =
      cameraStreamRef.current

    const stream =
      new MediaStream()

    if (camera) {
      camera
        .getVideoTracks()
        .forEach((track) => {
          stream.addTrack(track)
        })
    }

    return stream
  }, [])

  // -------------------------------------------------------------------------
  // OffscreenCanvas compositor (Option B - Web Worker)
  // -------------------------------------------------------------------------
  //
  // Single-file recording with the webcam overlay composited in, rendered
  // entirely inside a Web Worker: MediaStreamTrackProcessor readables for
  // the screen and camera tracks are transferred to the worker, which draws
  // every composed frame into an OffscreenCanvas. The main thread only
  // answers 'frame' messages with CanvasCaptureMediaStreamTrack
  // .requestFrame(), so nothing on the (throttled) main thread can stall
  // the composite when the browser tab is backgrounded.

  const buildCompositeStreamViaWorker = useCallback(async () => {
    const screen =
      screenStreamRef.current

    const camera =
      cameraStreamRef.current

    if (!screen || !camera) {
      return null
    }

    // Feature detection: fall back to dual raw recorders when the browser
    // cannot run the worker compositor.
    if (
      typeof MediaStreamTrackProcessor !== 'function' ||
      typeof Worker === 'undefined' ||
      typeof HTMLCanvasElement === 'undefined' ||
      !HTMLCanvasElement.prototype.transferControlToOffscreen
    ) {
      console.debug(
        '[Recorder] OffscreenCanvas compositor unavailable - falling back to dual raw recorders',
      )

      return null
    }

    const screenTrack =
      screen.getVideoTracks()[0]

    const cameraTrack =
      camera.getVideoTracks()[0]

    if (!screenTrack || !cameraTrack) {
      return null
    }

    let worker = null

    try {
      const canvas =
        document.createElement('canvas')

      canvas.width = 1280
      canvas.height = 720

      canvas.style.cssText =
        'position:fixed;left:-9999px;top:-9999px;width:320px;height:180px;opacity:0;pointer-events:none;'

      document.body.appendChild(canvas)

      recordingCanvasRef.current =
        canvas

      const offscreen =
        canvas.transferControlToOffscreen()

      const screenProcessor =
        new MediaStreamTrackProcessor({
          track: screenTrack,
        })

      const cameraProcessor =
        new MediaStreamTrackProcessor({
          track: cameraTrack,
        })

      worker =
        new CompositorWorker()

      const canvasStream =
        canvas.captureStream(30)

      canvasStreamRef.current =
        canvasStream

      const captureTrack =
        canvasStream.getVideoTracks()[0]

      worker.onmessage = (event) => {
        if (
          event.data &&
          event.data.type === 'frame' &&
          captureTrack &&
          captureTrack.requestFrame
        ) {
          captureTrack.requestFrame()
        }
      }

      worker.onerror = (event) => {
        console.warn(
          '[Recorder] Compositor worker error:',
          event?.message ?? event,
        )
      }

      worker.postMessage(
        {
          type: 'start',
          canvas: offscreen,
          screenReadable:
            screenProcessor.readable,
          cameraReadable:
            cameraProcessor.readable,
          settings:
            cameraSettingsRef.current,
        },
        [
          offscreen,
          screenProcessor.readable,
          cameraProcessor.readable,
        ],
      )

      compositorWorkerRef.current =
        worker

      // Audio: WebAudio mix (screen + mic) into ONE track when both are
      // present - MediaRecorder encodes a single audio track. Degrades to
      // the raw tracks when AudioContext is unavailable.
      const mixedAudio =
        buildAudioMixedStream(
          screen,
          micStreamRef.current,
        )

      const stream =
        new MediaStream()

      if (captureTrack) {
        stream.addTrack(captureTrack)
      }

      if (mixedAudio) {
        mixedAudio
          .getAudioTracks()
          .forEach((track) => {
            stream.addTrack(track)
          })
      } else {
        screen
          .getAudioTracks()
          .forEach((track) => {
            stream.addTrack(track)
          })

        const mic =
          micStreamRef.current

        if (mic) {
          mic
            .getAudioTracks()
            .forEach((track) => {
              stream.addTrack(track)
            })
        }
      }

      console.debug(
        '[Recorder] Composite stream (worker compositor):',
        {
          videoTracks:
            stream.getVideoTracks().length,
          audioTracks:
            stream.getAudioTracks().length,
        },
      )

      return stream
    } catch (err) {
      console.warn(
        '[Recorder] Worker composite failed - falling back to dual raw recorders:',
        err?.message ?? err,
      )

      teardownComposite()

      return null
    }
  }, [buildAudioMixedStream, teardownComposite])
  // -------------------------------------------------------------------------

  const stopScreenTracks = useCallback(() => {
    const screen =
      screenStreamRef.current

    if (screen) {
      screen.getTracks().forEach((track) => {
        track.onended = null

        try {
          track.stop()
        } catch {
          // Ignore.
        }
      })
    }

    screenStreamRef.current = null

    setScreenStream(null)

    teardownAudioMix()
    stopMicTracks()
    stopCameraTracks()
  }, [
    teardownAudioMix,
    stopMicTracks,
    stopCameraTracks,
  ])

  // -------------------------------------------------------------------------
  // Finalize recording
  // -------------------------------------------------------------------------

  const finalizeRecording =
    useCallback(
      (chunks, mimeType) => {
        if (committedRef.current) {
          return
        }

        setRecordingState('processing')

        try {
          const blob =
            new Blob(chunks, {
              type: mimeType,
            })

          if (!blob.size) {
            setError(
              'The recording was empty. Please try again.',
            )

            setRecordingState(
              INITIAL_STATE.recordingState,
            )

            stopScreenTracks()

            return
          }

          const file =
            new File(
              [blob],
              createRecordingFileName(
                mimeType,
              ),
              {
                type: mimeType,
              },
            )

          recordingFileRef.current =
            file

          setRecordingFile(file)

          setRecordingState('completed')

          committedRef.current = true

          stopScreenTracks()
          stopMicTracks()
        } catch (err) {
          console.error(
            '[Recorder] Finalization failed:',
            err,
          )

          setError(
            'Could not save the recording. Please try again.',
          )

          setRecordingState(
            INITIAL_STATE.recordingState,
          )

          stopScreenTracks()
        }
      },
      [
        stopScreenTracks,
        stopMicTracks,
      ],
    )

  // -------------------------------------------------------------------------
  // MediaRecorder onstop
  // -------------------------------------------------------------------------

  const handleRecorderStop =
    useCallback(() => {
      teardownComposite()

      const recorder =
        mediaRecorderRef.current

      mediaRecorderRef.current =
        null

      const chunks =
        chunksRef.current

      const mimeType =
        mimeTypeRef.current

      chunksRef.current = []
      mimeTypeRef.current = ''

      if (
        discardRef.current ||
        committedRef.current ||
        !recorder
      ) {
        discardRef.current = false

        stopMicTracks()
        stopCameraTracks()

        return
      }

      finalizeRecording(
        chunks,
        mimeType,
      )
    }, [
      finalizeRecording,
      stopMicTracks,
      stopCameraTracks,
      teardownComposite,
    ])

  // -------------------------------------------------------------------------
  // Camera recorder onstop
  // -------------------------------------------------------------------------

  const handleCameraRecorderStop =
    useCallback(() => {
      const chunks =
        cameraChunksRef.current

      cameraChunksRef.current = []

      if (
        discardRef.current ||
        chunks.length === 0
      ) {
        return
      }

      try {
        const blob =
          new Blob(chunks, {
            type: cameraMimeTypeRef.current || 'video/webm',
          })

        if (!blob.size) {
          return
        }

        const file =
          new File(
            [blob],
            createRecordingFileName(
              cameraMimeTypeRef.current,
              'camera-recording',
            ),
            {
              type: blob.type,
            },
          )

        recordingCameraFileRef.current =
          file

        if (mountedRef.current) {
          setRecordingCameraFile(file)
        }
      } catch (err) {
        console.warn(
          '[Recorder] Camera recording could not be saved:',
          err,
        )
      }
    }, [])

  // -------------------------------------------------------------------------
  // Browser "Stop Sharing"
  // -------------------------------------------------------------------------

  const handleTrackEnded =
    useCallback(() => {
      console.debug('[Recorder] display track ended')

      const recorder =
        mediaRecorderRef.current

      if (
        recorder &&
        (recorder.state === 'recording' || recorder.state === 'paused') &&
        !discardRef.current &&
        !committedRef.current
      ) {
        console.debug(
          '[Recorder] Browser stopped screen sharing — finalizing recording',
        )

        discardRef.current = false

        setRecordingState('stopping')

        try {
          recorder.stop()
        } catch {
          finalizeRecording(
            chunksRef.current,
            mimeTypeRef.current,
          )
        }

        return
      }

      if (
        recordingState === 'stopping' ||
        recordingState === 'processing' ||
        recordingState === 'completed'
      ) {
        return
      }

      stopScreenCapture()
      stopMicTracks()

      setNotice(
        'Screen sharing stopped.',
      )
    }, [
      finalizeRecording,
      stopScreenCapture,
      stopMicTracks,
      recordingState,
    ])

  // -------------------------------------------------------------------------
  // Camera disconnected
  // -------------------------------------------------------------------------

  const handleCameraTrackEnded =
    useCallback(() => {
      console.debug(
        '[Recorder] Camera track ended',
      )

      const wasRecording =
        recordingState === 'recording'

      stopCameraRecorder()
      stopCameraTracks()

      if (wasRecording) {
        setNotice(
          'Camera disconnected. Recording will continue without camera.',
        )
      } else {
        setNotice(
          'Camera disconnected.',
        )
      }
    }, [
      recordingState,
      stopCameraRecorder,
      stopCameraTracks,
    ])

  // -------------------------------------------------------------------------
  // Start MediaRecorder
  // -------------------------------------------------------------------------

  const startRecording =
    useCallback(async () => {
      const screen =
        screenStreamRef.current

      if (
        !screen ||
        mediaRecorderRef.current ||
        startingRef.current
      ) {
        return
      }

      if (
        recordingState !== 'ready' &&
        recordingState !== 'error'
      ) {
        return
      }

      if (
        typeof MediaRecorder === 'undefined'
      ) {
        setError(
          'Recording is not supported by this browser.',
        )

        return
      }

      const mimeType =
        pickSupportedMimeType()

      startingRef.current = true

        try {
          // Camera ON -> prefer the OffscreenCanvas compositor (Web Worker):
          // a single recording that already contains the webcam overlay,
          // rendered in a worker so background-tab throttling cannot freeze
          // it. When the compositor is unavailable, fall back to two raw
          // recorders (screen + webcam saved as separate files).
          // Camera OFF -> one raw recorder (screen only, no canvas).
          let usingCamera =
            Boolean(
              cameraStreamRef.current,
            )

          let screenRecordingStream = null
          let cameraRecordingStream = null
          let compositeActive = false

          if (usingCamera) {
            screenRecordingStream =
              await buildCompositeStreamViaWorker()

            if (screenRecordingStream) {
              compositeActive = true
            }
          }

          if (!screenRecordingStream) {
            screenRecordingStream =
              buildRecordingStream()
          }

          if (usingCamera && !compositeActive) {
            cameraRecordingStream =
              buildCameraRecordingStream()

            if (
              !cameraRecordingStream ||
              cameraRecordingStream.getVideoTracks().length === 0
            ) {
              usingCamera = false
              cameraRecordingStream = null
            }
          }

          const recordingMode =
            usingCamera ? 'COMPOSITE' : 'RAW_DISPLAY'

          console.debug(
            '[Recorder] mode: ' + recordingMode,
          )

          if (
            !screenRecordingStream ||
            screenRecordingStream.getVideoTracks().length === 0
          ) {
            throw new Error(
              'No video track available for recording',
            )
          }

          // MediaRecorder input diagnostics (development logging).
          const screenVideoTracks =
            screenRecordingStream.getVideoTracks()

          const screenAudioTracks =
            screenRecordingStream.getAudioTracks()

          const screenVideoTrack =
            screenVideoTracks[0]

          console.debug(
            '[Recorder] MediaRecorder input:',
            {
              mode: recordingMode,
              videoTracks: screenVideoTracks.length,
              audioTracks: screenAudioTracks.length,
              videoTrackState:
                screenVideoTrack?.readyState ?? null,
              videoTrackMuted:
                screenVideoTrack?.muted ?? null,
              videoTrackSettings:
                screenVideoTrack?.getSettings?.() ?? null,
            },
          )

          combinedStreamRef.current =
            screenRecordingStream

          const recorder = mimeType
            ? new MediaRecorder(
                screenRecordingStream,
                { mimeType },
              )
            : new MediaRecorder(
                screenRecordingStream,
              )

          mimeTypeRef.current =
            mimeType ||
            recorder.mimeType ||
            'video/webm'

          chunksRef.current = []
          discardRef.current = false

          recorder.ondataavailable =
            (event) => {
              if (
                event.data &&
                event.data.size > 0
              ) {
                chunksRef.current.push(
                  event.data,
                )
              }
            }

          recorder.onerror = () => {
            if (
              discardRef.current ||
              committedRef.current
            ) {
              return
            }

            discardRef.current = true

            setError(
              'Recording failed. Please try again.',
            )

            try {
              if (
                recorder.state !==
                'inactive'
              ) {
                recorder.stop()
              }
            } catch {
              // Ignore.
            }

            teardownComposite()
            stopScreenTracks()

            setRecordingState(
              INITIAL_STATE.recordingState,
            )
          }

          recorder.onstop =
            handleRecorderStop

          mediaRecorderRef.current =
            recorder

          recorder.start(1000)

          // Webcam: a SECOND raw recorder records the raw camera video track
          // separately (no main-thread canvas). Both files are saved
          // independently for a later FFmpeg merge.
          if (usingCamera && !compositeActive && cameraRecordingStream) {
            try {
              const cameraRecorder = mimeType
                ? new MediaRecorder(
                    cameraRecordingStream,
                    { mimeType },
                  )
                : new MediaRecorder(
                    cameraRecordingStream,
                  )

              cameraRecorderRef.current =
                cameraRecorder

              cameraMimeTypeRef.current =
                mimeType ||
                cameraRecorder.mimeType ||
                'video/webm'

              cameraChunksRef.current = []

              cameraRecorder.ondataavailable =
                (event) => {
                  if (
                    event.data &&
                    event.data.size > 0
                  ) {
                    cameraChunksRef.current.push(
                      event.data,
                    )
                  }
                }

              cameraRecorder.onstop =
                handleCameraRecorderStop

              cameraRecorder.start(1000)

              console.debug(
                '[Recorder] Camera recorder started:',
                {
                  mimeType:
                    cameraRecorder.mimeType,
                  state:
                    cameraRecorder.state,
                },
              )
            } catch (cameraErr) {
              console.warn(
                '[Recorder] Camera recorder failed to start - screen recording continues:',
                cameraErr?.message ?? cameraErr,
              )

              cameraRecorderRef.current = null
              cameraChunksRef.current = []
            }
          }

          console.debug(
            '[Recorder] MediaRecorder started:',
            {
              mimeType:
                recorder.mimeType,
              state:
                recorder.state,
              mode:
                recordingMode,
            },
          )

          setRecordingState(
            'recording',
          )
        } catch (err) {
          console.error(
            '[Recorder] Failed to start recording:',
            err?.name,
            err?.message,
          )

          teardownComposite()

          mediaRecorderRef.current =
            null

          setError(
            'Could not start recording. Please try again.',
          )

          setRecordingState(
            INITIAL_STATE.recordingState,
          )
        } finally {
          startingRef.current = false
        }
      }, [
        recordingState,
        handleRecorderStop,
        stopScreenTracks,
        buildRecordingStream,
        buildCameraRecordingStream,
        buildCompositeStreamViaWorker,
        handleCameraRecorderStop,
        teardownComposite,
      ])

    // -------------------------------------------------------------------------
    // User Stop Recording
    // -------------------------------------------------------------------------

    const stopRecording =
      useCallback(() => {
        if (
          recordingState !== 'recording'
        ) {
          return
        }

      const recorder =
        mediaRecorderRef.current

      if (
        !recorder ||
        (recorder.state !== 'recording' && recorder.state !== 'paused')
      ) {
        return
      }

      discardRef.current = false

      setRecordingState('stopping')

      stopCameraRecorder()

      try {
        recorder.stop()
      } catch {
        mediaRecorderRef.current =
          null

        finalizeRecording(
          chunksRef.current,
          mimeTypeRef.current,
        )
      }
    }, [
      recordingState,
      finalizeRecording,
      stopCameraRecorder,
    ])

  // -------------------------------------------------------------------------
  // Start screen capture
  // -------------------------------------------------------------------------

  const startScreenCapture =
    useCallback(async () => {
      if (
        permissionRequestRef.current
      ) {
        return
      }

      if (screenStreamRef.current) {
        return
      }

      if (
        !navigator.mediaDevices?.getDisplayMedia
      ) {
        setError(
          'Screen sharing is not supported by this browser.',
        )

        return
      }

      console.debug(
        '[Recorder] Opening native screen picker',
      )

      setNotice('')
      setError('')

      setRecordingState(
        'requesting_permission',
      )

      permissionRequestRef.current =
        true

      stopMicTracks()
      stopCameraTracks()

      let screenStream = null
      let micStream = null

      try {
        // -------------------------------------------------------------------
        // IMPORTANT:
        //
        // Do NOT set displaySurface:'browser'.
        //
        // monitorTypeSurfaces:'include' allows Chrome to expose Entire Screen.
        // surfaceSwitching:'include' asks the browser to provide native
        // switching controls when supported.
        //
        // The browser ultimately decides what appears in the native picker.
        // -------------------------------------------------------------------

        const displayMediaOptions = {
          video: {
            // Hint: preselect the Entire Screen pane in the picker. The
            // user can still pick a tab or window.
            displaySurface: 'monitor',

            selfBrowserSurface: 'include',
            surfaceSwitching: 'include',
            monitorTypeSurfaces: 'include',
          },

          audio: systemAudioEnabled,

          systemAudio:
            systemAudioEnabled
              ? 'include'
              : 'exclude',
        }

        console.debug(
          '[Recorder] getDisplayMedia options:',
          displayMediaOptions,
        )

        try {
          screenStream =
            await navigator.mediaDevices.getDisplayMedia(
              displayMediaOptions,
            )
        } catch (err) {
          // Some browsers reject the systemAudio
          // option. Retry without system audio.
          if (
            systemAudioEnabled &&
            (
              err?.name ===
                'TypeError' ||
              err?.name ===
                'NotSupportedError'
            )
          ) {
            console.debug(
              '[Recorder] Retrying without system audio',
            )

            screenStream =
              await navigator.mediaDevices.getDisplayMedia(
                {
                  video: {
                    displaySurface:
                      'monitor',

                    selfBrowserSurface:
                      'include',
                    surfaceSwitching:
                      'include',
                    monitorTypeSurfaces:
                      'include',
                  },

                  audio: false,

                  systemAudio:
                    'exclude',
                },
              )
          } else {
            throw err
          }
        }

        if (!screenStream) {
          throw new Error(
            'getDisplayMedia returned no stream',
          )
        }

        console.debug(
          '[Recorder] Display media granted',
        )

        // -------------------------------------------------------------------
        // Store screen stream
        // -------------------------------------------------------------------

        screenStreamRef.current =
          screenStream

        setScreenStream(
          screenStream,
        )

        // -------------------------------------------------------------------
        // Diagnostic: actual selected source
        // -------------------------------------------------------------------

        const videoTrack =
          screenStream.getVideoTracks()[0]

        if (videoTrack) {
          videoTrack.onended =
            handleTrackEnded

          // Surface switching (tab/window change) fires mute -> content change
          // -> unmute. These events are DIAGNOSTIC ONLY: MediaRecorder is never
          // paused or resumed from them. A muted display track simply produces
          // no new frames; encoding continues with the new surface on unmute.
          videoTrack.onmute = () => {
            console.debug('[Recorder] display track mute')
          }

          videoTrack.onunmute = () => {
            console.debug('[Recorder] display track unmute')
          }

          const settings =
            videoTrack.getSettings()

          console.debug(
            '[Recorder] Actual captured surface:',
            {
              label:
                videoTrack.label,

              displaySurface:
                settings.displaySurface,

              width:
                settings.width,

              height:
                settings.height,

              readyState:
                videoTrack.readyState,
            },
          )

          console.debug(
            '[Recorder] Track capabilities:',
            videoTrack.getCapabilities?.(),
          )
        }

        // -------------------------------------------------------------------
        // Microphone
        // -------------------------------------------------------------------

        if (micEnabled) {
          console.debug(
            '[Recorder] Requesting microphone',
          )

          try {
            const constraints =
              micDeviceId
                ? {
                    audio: {
                      deviceId: {
                        exact:
                          micDeviceId,
                      },
                    },
                    video: false,
                  }
                : {
                    audio: true,
                    video: false,
                  }

            micStream =
              await navigator.mediaDevices.getUserMedia(
                constraints,
              )

            micStreamRef.current =
              micStream

            setMicStream(
              micStream,
            )

            // Refresh device labels.
            try {
              const list =
                await navigator.mediaDevices.enumerateDevices()

              const microphones =
                list
                  .filter(
                    (device) =>
                      device.kind ===
                      'audioinput',
                  )
                  .map(
                    (
                      device,
                      index,
                    ) => ({
                      deviceId:
                        device.deviceId,

                      label:
                        device.label ||
                        `Microphone ${
                          index + 1
                        }`,
                    }),
                  )

              setDevices(
                (prev) => ({
                  ...prev,
                  microphones,
                }),
              )
            } catch {
              // Ignore.
            }
          } catch (micErr) {
            console.error(
              '[Recorder] Microphone failed:',
              micErr?.name,
            )

            stopScreenTracks()

            permissionRequestRef.current =
              false

            setRecordingState(
              INITIAL_STATE.recordingState,
            )

            const message =
              resolveMicError(
                micErr,
              )

            if (message) {
              setError(message)
            }

            return
          }
        }

        // -------------------------------------------------------------------
        // Camera
        // -------------------------------------------------------------------

        if (cameraEnabled) {
          console.debug(
            '[Recorder] Requesting camera',
          )

          try {
            const cameraConstraints =
              cameraDeviceId
                ? {
                    video: {
                      deviceId: {
                        exact:
                          cameraDeviceId,
                      },
                    },
                    audio: false,
                  }
                : {
                    video: true,
                    audio: false,
                  }

            const camStream =
              await navigator.mediaDevices.getUserMedia(
                cameraConstraints,
              )

            cameraStreamRef.current =
              camStream

            setCameraStream(
              camStream,
            )

            const cameraTrack =
              camStream.getVideoTracks()[0]

            if (cameraTrack) {
              cameraTrack.onended =
                handleCameraTrackEnded
            }

            // Refresh camera labels.
            try {
              const list =
                await navigator.mediaDevices.enumerateDevices()

              const cameras =
                list
                  .filter(
                    (device) =>
                      device.kind ===
                      'videoinput',
                  )
                  .map(
                    (
                      device,
                      index,
                    ) => ({
                      deviceId:
                        device.deviceId,

                      label:
                        device.label ||
                        `Camera ${
                          index + 1
                        }`,
                    }),
                  )

              setDevices(
                (prev) => ({
                  ...prev,
                  cameras,
                }),
              )
            } catch {
              // Ignore.
            }
          } catch (cameraErr) {
            console.error(
              '[Recorder] Camera failed:',
              cameraErr?.name,
            )

            stopScreenTracks()

            permissionRequestRef.current =
              false

            setRecordingState(
              INITIAL_STATE.recordingState,
            )

            const message =
              resolveCameraError(
                cameraErr,
              )

            if (message) {
              setError(message)
            }

            return
          }
        }

        // -------------------------------------------------------------------
        // Ready
        // -------------------------------------------------------------------

        committedRef.current =
          false

        discardRef.current =
          false

        deliveredRef.current =
          false

        recordingFileRef.current =
          null

        setRecordingFile(null)

        recordingCameraFileRef.current =
          null

        setRecordingCameraFile(null)

        permissionRequestRef.current =
          false

        setRecordingState('ready')

        console.debug(
          '[Recorder] Ready for recording',
        )
      } catch (err) {
        console.error(
          '[Recorder] Screen capture failed:',
          err?.name,
          err?.message,
        )

        stopScreenTracks()

        permissionRequestRef.current =
          false

        setRecordingState(
          INITIAL_STATE.recordingState,
        )

        const message =
          resolveCaptureError(err)

        if (message) {
          setError(message)
        }
      } finally {
        permissionRequestRef.current =
          false
      }
    }, [
      systemAudioEnabled,
      micEnabled,
      micDeviceId,
      cameraEnabled,
      cameraDeviceId,
      handleTrackEnded,
      handleCameraTrackEnded,
      stopScreenTracks,
      stopMicTracks,
      stopCameraTracks,
    ])

  // -------------------------------------------------------------------------
  // Reset / Cancel
  // -------------------------------------------------------------------------

  const reset = useCallback(() => {
    discardRef.current = true

    const recorder =
      mediaRecorderRef.current

    if (
      recorder &&
      recorder.state !== 'inactive'
    ) {
      try {
        recorder.stop()
      } catch {
        // Ignore.
      }
    }

    stopScreenCapture()
    stopMicTracks()

    teardownComposite()

    setNotice(
      INITIAL_STATE.notice,
    )

    setError(
      INITIAL_STATE.error,
    )

    recordingFileRef.current =
      null

    setRecordingFile(null)

    recordingCameraFileRef.current =
      null

    setRecordingCameraFile(null)
  }, [
    stopScreenCapture,
    stopMicTracks,
    teardownComposite,
  ])

  // -------------------------------------------------------------------------
  // Use Recording
  // -------------------------------------------------------------------------

  const confirmRecording =
    useCallback(() => {
      const file =
        recordingFileRef.current

      if (
        !file ||
        deliveredRef.current
      ) {
        return
      }

      deliveredRef.current = true

      recordingFileRef.current =
        null

      setRecordingFile(null)

      setRecordingState(
        INITIAL_STATE.recordingState,
      )

      onCommitRef.current?.(file)
    }, [])

  // -------------------------------------------------------------------------
  // Discard Recording
  // -------------------------------------------------------------------------

  const discardRecording =
    useCallback(() => {
      if (!recordingFileRef.current) {
        return
      }

      recordingCameraFileRef.current =
        null

      setRecordingCameraFile(null)

      recordingFileRef.current =
        null

      setRecordingFile(null)

      setRecordingState(
        INITIAL_STATE.recordingState,
      )

      setError(
        INITIAL_STATE.error,
      )

      setNotice(
        INITIAL_STATE.notice,
      )
    }, [])

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

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

    recordingFile,
    recordingCameraFile,

    startScreenCapture,
    stopScreenCapture,

    startRecording,
    stopRecording,

    reset,

    confirmRecording,
    discardRecording,
  }
}

export default useScreenRecorder
