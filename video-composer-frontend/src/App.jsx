import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import './App.css'
import { createComposition, createCompositionClip, COMPOSITION_DEFAULTS } from './state/composition'
import { loadAssetMetadata, resolveVideoDuration, revokeObjectUrlAsset } from './assets/AssetManager'
import { findActiveClip, drawFrame, seekAndDrawVideo, drawCompositionFrame, sourceTimeForClip } from './renderer/CompositionRenderer'
import { zoomEffectsForTime } from './renderer/zoomEffect'
import RecordModal from './recorder/RecordModal'
import useScreenRecorder from './recorder/useScreenRecorder'
import RecordingControls from './recorder/RecordingControls'
import RecordingReview from './recorder/RecordingReview'
import DimensionsPopover from './components/DimensionsPopover'
import Sidebar from './components/Sidebar'
import AIChatPanel from './components/AIChatPanel'
import ZoomPanel from './components/ZoomPanel'
import { useClientExport, EXPORT_FORMATS } from './renderer/useClientExport'
import { createCompositionText } from './state/composition'
import { syncTimelineItems } from './state/editingCommands'
import { toEvenDimension } from './dimensions/DimensionPresets'

import { createBrowserAgent, describeAssets, assetId } from './agent/browserAgent'
import { createHistory, recordHistory, restoreHistory } from './state/compositionHistory'
import { beginGoalTurn, receiveGoalPlan } from './agent/goalBrief'

const API_BASE = '/api'

// Default settings for the Zoom Fragment editor (see components/ZoomPanel).
// focus is the draggable focus point as fractions of the frame (0..1).
// Each fragment occupies an independent timeline range. clipId is retained
// only for compatibility with older saved fragment data.
const DEFAULT_ZOOM_FRAGMENT = {
  id: null,
  startTime: 0,
  endTime: 2,
  clipId: null,
  clipFileName: '',
  focus: { x: 0.5, y: 0.45 },
  cameraMovement: false,
  threeDEffect: false,
  zoomLevel: 1.5,
  transitionSpeed: 5,
}

const formatTime = (seconds) => {
  const safeSeconds = Math.max(0, Math.floor(seconds || 0))
  return `${Math.floor(safeSeconds / 60)}:${String(safeSeconds % 60).padStart(2, '0')}`
}

// Centisecond-precise variant used for the playhead time bubble during drag.
const formatTimePrecise = (seconds) => {
  const safeSeconds = Math.max(0, seconds || 0)
  const totalSeconds = Math.floor(safeSeconds)
  const centiseconds = Math.floor((safeSeconds - totalSeconds) * 100)
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`
}

// Ruler label for a possibly-fractional mark time. Whole seconds use the
// compact m:ss form; sub-second marks (high zoom) add one decimal digit.
const formatRulerTime = (time) => {
  const whole = Math.floor(time)
  const fraction = time - whole
  if (fraction > 0.001) {
    return `${formatTime(whole)}.${Math.round(fraction * 10)}`
  }
  return formatTime(whole)
}

// Dynamically generated ruler marks based on totalDuration and zoom so labels
// are never overcrowded (short timelines -> ~1s major ticks) nor too sparse
// (long timelines -> 2s/5s/10s/15s/30s/60s/120s major ticks with minor
// subdivisions in between). High zoom levels reveal sub-second majors.
// Returns major + minor arrays of { time, position } where position is already
// in timeline pixels (time * zoom). 0-duration -> empty.
const generateRulerMarks = (duration, zoom) => {
  if (!duration || duration <= 0 || !zoom || zoom <= 0) return { major: [], minor: [] }

  // Sub-second candidates only become eligible when the zoom is high enough
  // that a 0.1s step still leaves ~14px between labels.
  const minStep = zoom >= 160 ? 0.1 : (zoom >= 100 ? 0.25 : (zoom >= 60 ? 0.5 : 1))
  const candidateSteps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]
  const usable = candidateSteps.filter((step) => step >= minStep)

  const targetLabelCount = 8
  const rawStep = duration / targetLabelCount
  let step = usable[usable.length - 1]
  for (const candidate of usable) {
    if (candidate >= rawStep) { step = candidate; break }
  }

  const major = []
  const minor = []

  // Sub-divide each major step only when whole seconds are involved AND the
  // minor ticks keep at least ~12px of spacing. divisions = number of equal
  // slices (produces divisions - 1 in-between minor marks).
  let divisions = 1
  if (step >= 2) {
    divisions = Math.max(2, Math.min(6, Math.round((step * zoom) / 12)))
  }

  for (let time = 0; time <= duration + 0.001; time += step) {
    const rounded = Math.round(time * 100) / 100
    major.push({ time: rounded, position: Math.round(rounded * zoom) })

    if (divisions > 1) {
      const minorStep = step / divisions
      for (let m = 1; m < divisions; m++) {
        const minorTime = Math.round((time + m * minorStep) * 100) / 100
        if (minorTime < duration) {
          minor.push({ time: minorTime, position: Math.round(minorTime * zoom) })
        }
      }
    }
  }

  return { major, minor }
}

function App() {
  const [clips, setClips] = useState([])
  const [uploadedAudioFile, setUploadedAudioFile] = useState(null)
  const [agentAudioAssets, setAgentAudioAssets] = useState({})
  const [imageDuration, setImageDuration] = useState(3)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // Client-side export replaces the server job queue: running the render
  // directly in the browser via useClientExport (WebCodecs MP4 fast path
  // with automatic WebM fallback). Kept names so surrounding UI compiles.
  const clientExport = useClientExport()
  const job = null
  const setJob = () => {}
  const [currentTime, setCurrentTime] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [zoom, setZoom] = useState(80)
  const [duration, setDuration] = useState(0)
  const [clipPreviews, setClipPreviews] = useState([])
  const [selectedClipId, setSelectedClipId] = useState(null)
  const [activeTab, setActiveTab] = useState('videos')
  const [isMediaPanelCollapsed, setIsMediaPanelCollapsed] = useState(false)
  const [zoomFragments, setZoomFragments] = useState([])
  const [selectedZoomFragmentId, setSelectedZoomFragmentId] = useState(null)
  const [openZoomDetail, setOpenZoomDetail] = useState(false)
  const [isExportPanelOpen, setIsExportPanelOpen] = useState(false)
  const [timelineItems, setTimelineItems] = useState([])
  const [selectedTextId, setSelectedTextId] = useState(null)
  const [composition, setComposition] = useState(createComposition())
  const audioFile = composition.backgroundAudioAssetId ? agentAudioAssets[composition.backgroundAudioAssetId] || null : uploadedAudioFile
  const setAudioFile = (file) => {
    setUploadedAudioFile(file)
    setComposition((previous) => {
      const next = { ...previous }
      delete next.backgroundAudioAssetId
      return next
    })
  }
  const compositionHistoryRef = useRef(createHistory(composition))
  const [clipDurations, setClipDurations] = useState([])
  const [previewImages, setPreviewImages] = useState({})
  const [previewVideos, setPreviewVideos] = useState({})
  const [isClipSettingsOpen, setIsClipSettingsOpen] = useState(false)
  const [isRecorderSetupOpen, setIsRecorderSetupOpen] = useState(false)
  const [recordingElapsed, setRecordingElapsed] = useState(0)
  const [countdown, setCountdown] = useState(null) // OpenVid countdown: null | 3 | 2 | 1
  const [reviewDuration, setReviewDuration] = useState(0) // duration shown in the review panel
  const recordingStartedAtRef = useRef(null)
  // Wall-clock stop time of the last recording session + per-file measured
  // durations. WebM blobs recorded by MediaRecorder often lack duration
  // headers (video.duration === Infinity); when metadata probing cannot
  // recover the length, the composer falls back to these measured values
  // instead of wrongly applying the 3s image duration.
  const recordingStoppedAtRef = useRef(null)
  const recordedDurationsRef = useRef(new Map())
  const previewResizeRef = useRef(null)

  useLayoutEffect(() => {
    recordHistory(compositionHistoryRef.current, composition)
  }, [composition])

  const undoComposition = () => {
    const previous = restoreHistory(compositionHistoryRef.current, 'undo')
    if (!previous) return
    setComposition(previous)
    setTimelineItems(syncTimelineItems(timelineItems, previous))
    return previous
  }

  const redoComposition = () => {
    const next = restoreHistory(compositionHistoryRef.current, 'redo')
    if (!next) return
    setComposition(next)
    setTimelineItems(syncTimelineItems(timelineItems, next))
  }

  // Stable identity key for a clip file (name + size + last modified).
  const clipFileKey = (file) => `${file.name}:${file.size}:${file.lastModified}`

  // Measured length (seconds) of the most recent recording session:
  // (stop wall-clock - start wall-clock). Used when the WebM blob's
  // duration header is missing and metadata probing fails.
  const measuredRecordingSeconds = () => {
    if (!recordingStartedAtRef.current || !recordingStoppedAtRef.current) return null
    const seconds = (recordingStoppedAtRef.current - recordingStartedAtRef.current) / 1000
    return Number.isFinite(seconds) && seconds > 0.1 ? seconds : null
  }

  // onCommit: a recording was confirmed. Register it as a new clip, switch to
  // the Videos tab so it shows up in the library, and load it into the
  // live preview.
  // NOTE: this must be defined BEFORE useScreenRecorder() below, since it's
  // passed in as the onCommit callback — const declarations are not hoisted.
  const commitRecording = (file) => {
    setClips((prev) => [...prev, file])
    // Remember this recording's wall-clock length: MediaRecorder WebM blobs
    // frequently miss duration headers, so this measured value is the
    // composer's fallback when metadata probing cannot determine the length.
    const measured = measuredRecordingSeconds()
    if (measured) {
      recordedDurationsRef.current.set(clipFileKey(file), measured)
    }
    setActiveTab('videos')
    setCurrentTime(0)
    setError('')
  }

  // Recorder lifecycle lives at the App level so it survives the Setup UI
  // being closed. Closing the modal during an active recording must NOT
  // stop or discard that recording.
  const recorder = useScreenRecorder({ onCommit: commitRecording })

  // Output dimensions — ONE SOURCE OF TRUTH: composition.width/height.
  // aspectRatioMode only tracks WHICH preset is active for the picker UI
  // and the backend aspect_ratio field:
  //   'auto' | '16:9' | '9:16' | '1:1' | '4:3' | '3:4' | 'custom'
  // Auto resolves to the project base size (1280x720) so the live preview
  // and the exported video always share the same aspect ratio.
  const [aspectRatioMode, setAspectRatioMode] = useState('auto')
  const [isDimensionsOpen, setIsDimensionsOpen] = useState(false)
  const dimensionTriggerRef = useRef(null)

  // Timeline drag state: used to distinguish a drag from a click and to keep
  // the playhead-grabber visible only while the user is actively scrubbing.
  const timelineCanvasRef = useRef(null)
  const isDraggingPlayheadRef = useRef(false)
  const wasDraggingRef = useRef(false)
  const [isDraggingPlayhead, setIsDraggingPlayhead] = useState(false)

  // Preview sizing: buffers are always <= 1280px on the longest side so the
  // composition renderer (which is resolution-aware) draws at the exact
  // composition aspect ratio while keeping the bitmap lightweight. The
  // canvas buffer aspect ALWAYS matches composition.width/height, so what
  // the user sees is exactly the shape the exported video will have.
  const previewAspectRatio = composition.width / composition.height
  let previewWidth = 1280
  let previewHeight = Math.round(previewWidth / previewAspectRatio)
  if (previewHeight > 1280) {
    previewHeight = 1280
    previewWidth = Math.round(previewHeight * previewAspectRatio)
  }
  previewWidth = toEvenDimension(previewWidth) || 1280
  previewHeight = toEvenDimension(previewHeight) || 720

  // The wrapper gets explicit pixel dimensions: CSS aspect-ratio alone does
  // not shrink a width:100% box when max-height clamps, so the bounding box
  // would never visibly change shape without an explicit width/height.
  const PREVIEW_MAX_HEIGHT = 420
  const PREVIEW_MAX_WIDTH = 900
  let previewBoxHeight = PREVIEW_MAX_HEIGHT
  let previewBoxWidth = Math.round(previewBoxHeight * (previewWidth / previewHeight))
  if (previewBoxWidth > PREVIEW_MAX_WIDTH) {
    previewBoxWidth = PREVIEW_MAX_WIDTH
    previewBoxHeight = Math.round(previewBoxWidth / (previewWidth / previewHeight))
  }
  const previewBoxStyle = {
    width: `${previewBoxWidth}px`,
    height: `${previewBoxHeight}px`,
  }

  const videoRef = useRef(null)
  const dragIndexRef = useRef(null)
  const hiddenVideoRefs = useRef({})
  const canvasRef = useRef(null)
  const uploadInputRef = useRef(null)
  const audioInputRef = useRef(null)

  // Active section for the OpenVid-style left sidebar navigation.
  // "composer" → existing editor view, "record" → RecordModal is opened.
  const [activeSection, setActiveSection] = useState('media')
  const [aiMessages, setAiMessages] = useState([])
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState('')
  const [aiGoal, setAiGoal] = useState(null)
  const [aiLastEditedTarget, setAiLastEditedTarget] = useState(null)
  const [aiLastResult, setAiLastResult] = useState(null)
  const [aiFailedPrompt, setAiFailedPrompt] = useState('')
  const aiInFlightKeyRef = useRef(null)
  const aiUndoRef = useRef(null)
  const compositionRef = useRef(composition)
  const aiControllerRef = useRef(null)
  const aiReviewResolverRef = useRef(null)
  const [aiReview, setAiReview] = useState(null)
  const [aiProgress, setAiProgress] = useState(null)
  const aiEditorRef = useRef({ version: 0 })
  const editorKey = JSON.stringify([composition, clips.map(assetId), audioFile ? assetId(audioFile) : null, selectedClipId, selectedTextId])

  const respondToAIReview = (accepted) => {
    const resolve = aiReviewResolverRef.current
    aiReviewResolverRef.current = null
    setAiReview(null)
    resolve?.(accepted)
  }

  const cancelAI = () => {
    aiControllerRef.current?.abort()
    respondToAIReview(false)
  }

  useLayoutEffect(() => {
    if (aiEditorRef.current.key !== editorKey) {
      aiEditorRef.current = { ...aiEditorRef.current, key: editorKey, version: aiEditorRef.current.version + 1 }
    }
    compositionRef.current = composition
    aiEditorRef.current.recordingState = recorder.recordingState
    if (aiControllerRef.current && aiEditorRef.current.runVersion !== aiEditorRef.current.version) {
      aiControllerRef.current.abort()
      const resolve = aiReviewResolverRef.current
      aiReviewResolverRef.current = null
      resolve?.(false)
    }
  }, [editorKey, composition, recorder.recordingState])

  useEffect(() => () => {
    aiControllerRef.current?.abort()
    aiReviewResolverRef.current?.(false)
  }, [])

  const compositionVideoDuration = composition.tracks[0].clips.reduce(
    (sum, clip) => sum + clip.duration,
    0
  )
  const [audioUrl, setAudioUrl] = useState(null)
  const [audioDuration, setAudioDuration] = useState(0)
  const audioRef = useRef(null)

  // Object URL for the uploaded audio so the preview can play it; revoked
  // (and the measured duration reset) whenever the audio file changes.
  useEffect(() => {
    if (!audioFile) {
      setAudioUrl(null)
      setAudioDuration(0)
      return undefined
    }
    const url = URL.createObjectURL(audioFile)
    setAudioUrl(url)

    // Measure the audio's real duration once the metadata loads so the
    // timeline AUDIO block (and the shared-clock estimated duration) use
    // the actual length instead of the 12s fallback.
    const audio = new Audio()
    audio.preload = 'metadata'
    audio.onloadedmetadata = () => {
      if (Number.isFinite(audio.duration)) {
        setAudioDuration(audio.duration)
      }
    }
    audio.src = url

    return () => {
      audio.pause()
      audio.removeAttribute('src')
      URL.revokeObjectURL(url)
      setAudioUrl(null)
    }
  }, [audioFile])

  const estimatedDuration = Math.max(
    compositionVideoDuration,
    audioFile ? (audioDuration || 12) : 0
  )
  const totalDuration = duration || estimatedDuration

  // Play/pause the preview audio with the timeline transport. The .play()
  // promise is guarded: browsers refuse autoplay until user interaction,
  // and the preview audio element may not exist yet (audio not uploaded).
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    if (isPlaying) {
      audio.play().catch(() => {})
    } else {
      audio.pause()
    }
  }, [isPlaying])

  // Keep the audio aligned with the shared timeline clock while playing:
  // correct only on real drift (> 0.3s) and only while the audio still has
  // content left — after it ends the video preview keeps playing silently.
  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !isPlaying || audio.ended) return
    if (audioDuration && currentTime > audioDuration) return
    if (Math.abs(audio.currentTime - currentTime) > 0.3) {
      audio.currentTime = currentTime
    }
  }, [currentTime, isPlaying, audioDuration])

  const progress = totalDuration ? (currentTime / totalDuration) * 100 : 0
  const timelineWidth = Math.max(560, totalDuration * zoom + 30)
  const rulerMarks = generateRulerMarks(totalDuration, zoom)

  // OpenVid flow: once the screen (and any mic/camera) is ready, close
  // the setup UI and show the 3-2-1 countdown. The App-level recorder
  // keeps the streams alive — closing the setup modal NEVER stops them.
  useEffect(() => {
    if (recorder.recordingState === 'ready') {
      setIsRecorderSetupOpen(false)
      setCountdown(3)
    }
  }, [recorder.recordingState])

  // Countdown ticker: 3 → 2 → 1, then auto-start the recording.
  // UI-only — it never touches the streams; startRecording() is guarded
  // by the recorder state so it can only fire after 'ready'.
  useEffect(() => {
    if (!countdown) return undefined
    const timer = setTimeout(() => {
      if (countdown > 1) {
        setCountdown(countdown - 1)
      } else {
        setCountdown(null)
        if (recorder.recordingState === 'ready') {
          recorder.startRecording()
        }
      }
    }, 1000)
    return () => clearTimeout(timer)
  }, [countdown, recorder.recordingState, recorder.startRecording])

  // Track elapsed recording time while actively recording, and capture the
  // exact stop wall-clock time so a committed recording can fall back to a
  // measured duration when its WebM header lacks one.
  useEffect(() => {
    if (recorder.recordingState === 'recording') {
      recordingStartedAtRef.current = Date.now()
      recordingStoppedAtRef.current = null
      const timer = setInterval(() => {
        setRecordingElapsed(Math.floor((Date.now() - recordingStartedAtRef.current) / 1000))
      }, 1000)
      return () => clearInterval(timer)
    }
    if (recordingStartedAtRef.current && !recordingStoppedAtRef.current) {
      recordingStoppedAtRef.current = Date.now()
    }
    return undefined
  }, [recorder.recordingState])

  // ---------------- Output dimensions (single source of truth) ----------------

  // The ONLY place composition dimensions change. Updates composition.width
  // and composition.height and nothing else: clip start times, durations,
  // ordering, and audio timing are untouched, so the timeline keeps working
  // exactly as before. Preview + export payload both derive from these.
  const applyDimensions = (mode, width, height) => {
    const evenWidth = toEvenDimension(width)
    const evenHeight = toEvenDimension(height)
    if (!evenWidth || !evenHeight) return
    setAspectRatioMode(mode)
    setComposition((prev) => ({
      ...prev,
      width: evenWidth,
      height: evenHeight,
    }))
    setError('')
  }

  // Preset card clicked in the dimensions popover. "auto" resolves to the
  // project's base composition size so preview and export stay in sync
  // (the backend pads every clip onto this same box in auto mode).
  const handleDimensionPresetSelect = (preset) => {
    if (preset.id === 'auto') {
      applyDimensions('auto', COMPOSITION_DEFAULTS.width, COMPOSITION_DEFAULTS.height)
    } else {
      // `aspect` carries the backend-valid ratio; presets Django doesn't
      // support natively (4:5, 21:9, 2:3) are sent as 'custom' with their
      // explicit width/height still defining the output resolution.
      applyDimensions(preset.aspect ?? preset.id, preset.width, preset.height)
    }
    setIsDimensionsOpen(false)
  }

  // "Apply dimensions" with custom W/H. The popover has already validated
  // the values (whole numbers, 2..MAX_DIMENSION) and even-rounded them;
  // toEvenDimension here is a defensive double-check.
  const handleApplyCustomDimensions = (width, height) => {
    const evenWidth = toEvenDimension(width)
    const evenHeight = toEvenDimension(height)
    if (!evenWidth || !evenHeight) {
      setError('Enter a valid custom width and height first.')
      return
    }
    applyDimensions('custom', evenWidth, evenHeight)
    setIsDimensionsOpen(false)
  }

  const handleCloseDimensions = () => {
    setIsDimensionsOpen(false)
  }

  useEffect(() => {
    if (!job || !['pending', 'processing'].includes(job.status)) {
      return undefined
    }

    const timer = setInterval(async () => {
      try {
        const response = await fetch(`${API_BASE}/jobs/${job.id}/`)
        if (!response.ok) throw new Error('Could not refresh the job status.')
        setJob(await response.json())
      } catch (refreshError) {
        console.error(refreshError)
      }
    }, 2000)

    return () => clearInterval(timer)
  }, [job])

  // Generate thumbnail previews whenever the selected clips change
  useEffect(() => {
    const urls = clips.map((file) =>
      file.type.startsWith('image/') ? URL.createObjectURL(file) : null
    )
    setClipPreviews(urls)
    return () => {
      urls.forEach((url) => url && URL.revokeObjectURL(url))
    }
  }, [clips])

  // Probe the REAL media duration (seconds) for every clip, indexed by clip
  // order. MediaRecorder-produced WebM recordings report Infinity until the
  // resolveVideoDuration seek workaround runs, so this probe is what makes a
  // 50-second recording know it is 50 seconds long. Images resolve to null
  // (they use the configured image duration instead).
  useEffect(() => {
    let cancelled = false

    Promise.all(
      clips.map((file) =>
        loadAssetMetadata(file)
          .then((meta) => {
            revokeObjectUrlAsset(meta.url) // only the duration is needed here
            return Number.isFinite(meta.duration) && meta.duration > 0 ? meta.duration : null
          })
          .catch(() => null)
      )
    ).then((durations) => {
      if (!cancelled) setClipDurations(durations)
    })

    return () => {
      cancelled = true
    }
  }, [clips])

  // Build <img> elements for image clips so the canvas can draw them
  useEffect(() => {
    const newImages = {}
    let pending = 0

    clips.forEach((file, index) => {
      if (!file.type.startsWith('image/')) return
      pending += 1
      const img = new window.Image()
      img.onload = () => {
        newImages[index] = img
        pending -= 1
        if (pending === 0) setPreviewImages({ ...newImages })
      }
      img.src = clipPreviews[index]
    })

    if (pending === 0) setPreviewImages({ ...newImages })
  }, [clips, clipPreviews])

  // Rebuild video sources when the media library changes, including generated
  // assets. Never retain refs to object URLs revoked by the previous effect.
  useEffect(() => {
    const urls = []
    const videos = {}
    let cancelled = false
    clips.forEach((file, index) => {
      if (!file.type.startsWith('video/')) return
      const url = URL.createObjectURL(file)
      urls.push(url)
      const video = document.createElement('video')
      video.muted = true
      video.preload = 'auto'
      video.playsInline = true
      video.onloadeddata = () => {
        if (!cancelled) setPreviewVideos({ ...videos })
      }
      video.onloadedmetadata = () => { resolveVideoDuration(video).catch(() => {}) }
      video.src = url
      videos[index] = video
    })
    hiddenVideoRefs.current = videos
    setPreviewVideos(videos)
    return () => {
      cancelled = true
      Object.values(videos).forEach((video) => {
        video.onloadeddata = null
        video.onloadedmetadata = null
        video.pause()
        video.removeAttribute('src')
        video.load()
      })
      urls.forEach((url) => URL.revokeObjectURL(url))
    }
  }, [clips])

  // Draw the active clip (image or video frame) + any text overlays onto the
  // canvas whenever the playhead time or composition changes. Uses the SHARED
  // drawCompositionFrame path so the live preview and the client-side exporter
  // produce pixel-identical output. During scrubbing (paused) video clips are
  // seeked to the exact frame first; during playback the clip-audio effect
  // advances the active video so we draw its current frame without seeking.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')

    // Scrubbing: seek video clips to the exact frame for a sharp static
    // preview. During playback the clip-audio sync effect drives the video.
    if (!isPlaying) {
      const scrubClip = findActiveClip(composition, currentTime)
      if (scrubClip?.fileType?.startsWith('video/')) {
        const video = previewVideos[scrubClip.fileIndex]
        if (video) {
          const sourceTime = sourceTimeForClip(scrubClip, currentTime)
          if (Math.abs(video.currentTime - sourceTime) > 0.05) {
            video.currentTime = sourceTime
          }
        }
      }
    }

    drawCompositionFrame(ctx, canvas, { ...composition, zoomFragments }, currentTime, {
      images: previewImages,
      videos: previewVideos,
    })
  }, [currentTime, composition, zoomFragments, previewImages, previewVideos, clips, previewWidth, previewHeight, isPlaying])

  // Drive the active clip hidden video element so its audio plays in sync
  // with the shared timeline clock. During playback only the active clip is
  // unmuted and playing (all others are muted+paused); scrubbing mutes
  // everything. This is the preview soundtrack - recorded system audio and
  // mic from screen recordings, or the audio track of any video clip.
  useEffect(() => {
    const activeClip = findActiveClip(composition, currentTime)
    Object.keys(hiddenVideoRefs.current).forEach((index) => {
      const video = hiddenVideoRefs.current[index]
      if (!video) return
      const isActive = activeClip && Number(activeClip.fileIndex) === Number(index)
      if (isActive && isPlaying) {
        const sourceTime = sourceTimeForClip(activeClip, currentTime)
        video.muted = false
        if (Math.abs(video.currentTime - sourceTime) > 0.3) { video.currentTime = sourceTime }
        video.play().catch(() => {})
      } else { video.muted = true; video.pause() }
    })
  }, [currentTime, isPlaying, composition])

  // Playback loop: advances currentTime in real time while isPlaying is true
  useEffect(() => {
    if (!isPlaying) return undefined
    let rafId
    let lastTimestamp = performance.now()

    const tick = (now) => {
      const delta = (now - lastTimestamp) / 1000
      lastTimestamp = now

      setCurrentTime((prevTime) => {
        const nextTime = prevTime + delta
        if (nextTime >= totalDuration) {
          setIsPlaying(false)
          return totalDuration
        }
        return nextTime
      })
      rafId = requestAnimationFrame(tick)
    }

    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [isPlaying, totalDuration])

  // Reset the "known" video duration whenever the timeline sequence changes,
  // so the timeline width recalculates from the new sequence instead of
  // staying locked to a previously rendered video's duration.
  useEffect(() => {
    setDuration(0)
  }, [timelineItems])

  // Client-side export (replaces the server compose queue): render the
  // composition timeline directly in the browser. MP4 is the primary fast
  // path (WebCodecs + mp4-muxer); the hook falls back to WebM automatically.
  const startClientExport = async (format = EXPORT_FORMATS.MP4) => {
    if (!timelineItems.length) {
      setError('Please add at least one clip to the timeline.')
      return null
    }
    setError('')
    return await clientExport.start({
      // zoomFragments rides inside the composition so the exporter's shared
      // render path applies the exact same zoom the user saw in preview.
      composition: { ...composition, zoomFragments },
      clips,
      audioFile,
      mediaImages: { ...previewImages },
      format,
    })
  }

  const startComposition = async () => startClientExport(EXPORT_FORMATS.MP4)

  // Force-download a client-rendered result with a given filename.
  const triggerFileDownload = (url, filename) => {
    if (!url) return
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.style.display = 'none'
    document.body.appendChild(link)
    link.click()
    link.remove()
  }

  // "Download WebM" / "Download MP4": if the last export is already that
  // format, download it immediately; otherwise render the other format
  // first, then download THAT result.
  const handleDownloadFormat = async (format) => {
    if (clientExport.exporting) return
    const wantMp4 = format === EXPORT_FORMATS.MP4
    const currentIsMp4 = outputMimeType.includes('mp4')
    const filename = wantMp4 ? 'composition.mp4' : 'composition.webm'
    if (currentIsMp4 === wantMp4 && clientExport.result?.url) {
      triggerFileDownload(clientExport.result.url, filename)
      return
    }
    const result = await startClientExport(format)
    if (result?.url) {
      triggerFileDownload(result.url, filename)
    }
  }

  // The form keeps working on the Upload tab; the sidebar Composer button
  // calls startComposition() directly (works from any tab).
  const handleSubmit = (event) => {
    event.preventDefault()
    startComposition()
  }

  const seekTo = (nextTime) => {
    const boundedTime = Math.max(0, Math.min(nextTime, totalDuration || nextTime))
    setCurrentTime(boundedTime)
    if (videoRef.current && Number.isFinite(videoRef.current.duration)) {
      videoRef.current.currentTime = boundedTime
    }
    // Seek the preview audio too so scrubbing the playhead keeps the
    // audio aligned; clamped to the audio's length (scrubbing past the
    // audio's end leaves it at its end — the video keeps playing).
    const audio = audioRef.current
    if (audio && Number.isFinite(audio.duration)) {
      audio.currentTime = Math.min(boundedTime, audio.duration)
    }
  }

  const handleTimelineClick = (event) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    const time = ((event.clientX - bounds.left) / bounds.width) * totalDuration
    // Snap to the nearest whole second so a click on a tick lands exactly on it.
    // The geometry math yields a float (e.g. 8.5) which should round to 8.
    seekTo(Math.round(time))
    // If this click is the pointerup that ended a drag, suppress the click seek
    // (the drag already moved the playhead). Reset the flag so the next click
    // seeks normally.
    if (wasDraggingRef.current) {
      wasDraggingRef.current = false
      return
    }
  }

  // Seek from an arbitrary pointer event — reuses the same X→time geometry as
  // handleTimelineClick so the playhead, preview, and timeline stay perfectly
  // synchronized. Also sets the drag flag so the subsequent click does not
  // trigger a second seek.
  const seekFromEvent = (event, target) => {
    const bounds = target.getBoundingClientRect()
    const time = ((event.clientX - bounds.left) / bounds.width) * totalDuration
    // Snap to the nearest whole second so a click/drag lands on a tick.
    seekTo(Math.round(time))
    if (!isDraggingPlayheadRef.current) {
      // First pointer move during a potential drag — mark that a drag started
      // so the following pointerup/click does not seek again.
      isDraggingPlayheadRef.current = true
      wasDraggingRef.current = true
      setIsDraggingPlayhead(true)
    }
  }

  const handlePlayheadPointerDown = (event) => {
    // Prevent text selection / browser drag while we are grabbing the playhead.
    event.preventDefault()
    const canvas = timelineCanvasRef.current
    if (!canvas) return
    seekFromEvent(event, canvas)
    canvas.setPointerCapture(event.pointerId)
  }

  const handlePlayheadPointerMove = (event) => {
    if (!isDraggingPlayheadRef.current) return
    const canvas = timelineCanvasRef.current
    if (!canvas) return
    seekFromEvent(event, canvas)
  }

  const handlePlayheadPointerUp = () => {
    if (!isDraggingPlayheadRef.current) return
    isDraggingPlayheadRef.current = false
    setIsDraggingPlayhead(false)
  }

  const handleVideoMetadata = (event) => {
    setDuration(event.currentTarget.duration)
    setCurrentTime(event.currentTarget.currentTime)
  }

  // While the user is dragging the playhead, attach document-level pointermove
  // and pointerup/cancel listeners so scrubbing still works when the pointer
  // leaves the timeline canvas. Clean up on unmount and when dragging ends.
  useEffect(() => {
    if (!isDraggingPlayhead) return undefined
    const onPointerMove = (event) => {
      if (isDraggingPlayheadRef.current) {
        const canvas = timelineCanvasRef.current
        if (canvas) seekFromEvent(event, canvas)
      }
    }
    const onPointerUp = () => {
      if (isDraggingPlayheadRef.current) {
        isDraggingPlayheadRef.current = false
        setIsDraggingPlayhead(false)
      }
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
    }
  }, [isDraggingPlayhead])

  const handleVideoTimeUpdate = (event) => {
    setCurrentTime(event.currentTarget.currentTime)
  }

  const handleVideoSeeked = (event) => {
    setCurrentTime(event.currentTarget.currentTime)
  }

  const handleTogglePlayback = () => {
    const willPlay = !isPlaying
    // At the end of the timeline the loop had already stopped with
    // currentTime === totalDuration; starting from there would stop again
    // on the very first tick. Replay from the beginning instead.
    if (willPlay && totalDuration > 0 && currentTime >= totalDuration) {
      seekTo(0)
    }
    setIsPlaying(willPlay)
  }

  const skipBackward = () => {
    seekTo(Math.max(0, currentTime - 5))
  }

  const skipForward = () => {
    seekTo(Math.min(totalDuration, currentTime + 5))
  }

  const removeClip = (index) => {
    setClips((prev) => prev.filter((_, i) => i !== index))
    setTimelineItems((prev) =>
      prev
        .filter((item) => item.clipIndex !== index)
        .map((item) => (item.clipIndex > index ? { ...item, clipIndex: item.clipIndex - 1 } : item))
    )
  }

  // Resolve a video clip's true length BEFORE it touches the timeline.
  // Priority: background-probed duration -> measured recording wall-clock
  // length (stop - start) -> an on-demand fresh probe -> image duration as
  // the absolute last resort (videos only). The on-demand probe removes the
  // race where the user clicks a thumbnail before the background metadata
  // pass finishes, and covers WebM blobs whose duration header
  // MediaRecorder omitted.
  const resolveClipDuration = async (file, clipIndex) => {
    if (!file?.type.startsWith('video/')) return imageDuration

    const cached = clipDurations[clipIndex]
    if (cached) return cached

    const measured = file ? recordedDurationsRef.current.get(clipFileKey(file)) : undefined
    if (measured) return measured

    try {
      const meta = await loadAssetMetadata(file)
      revokeObjectUrlAsset(meta.url) // only the duration is needed here
      if (Number.isFinite(meta.duration) && meta.duration > 0) {
        setClipDurations((prev) => {
          const next = [...prev]
          next[clipIndex] = meta.duration
          return next
        })
        return meta.duration
      }
    } catch {
      // Fall through to the last resort below.
    }
    console.log('[Duration] Could not determine video length, using image duration:', file.name)
    return imageDuration
  }

  const addToTimeline = async (clipIndex) => {
    const file = clips[clipIndex]
    const clipDuration = await resolveClipDuration(file, clipIndex)
    console.log('[Timeline] added clip duration =', clipDuration, file?.name)
    const uid = `${clipIndex}-${Date.now()}-${Math.random()}`
    setTimelineItems((prev) => [...prev, { clipIndex, uid }])
    setComposition((prev) => {
      const videoTrack = prev.tracks[0]
      const startTime = videoTrack.clips.reduce((sum, clip) => sum + clip.duration, 0)
      const newClip = { ...createCompositionClip(file, clipIndex, startTime, clipDuration), id: uid, baseDuration: clipDuration }

      // Jump the live preview to the start of the newly added clip
      // and select it, so the user immediately sees what they just added.
      setCurrentTime(startTime)
      setSelectedClipId(uid)

      return {
        ...prev,
        duration: startTime + clipDuration,
        tracks: [
          { ...videoTrack, clips: [...videoTrack.clips, newClip] },
          prev.tracks[1],
        ],
      }
    })
  }

  // ---------------- Recorder handlers ----------------

  // "Use Recording" in the review panel: the recorder delivers the File to
  // onCommit exactly once (deliveredRef guard inside the hook) — the clip is
  // appended to the library and the review panel closes via the completed ->
  // idle state transition.
  const handleConfirmRecording = () => {
    setReviewDuration(0)
    setActiveSection('composer')
    recorder.confirmRecording()
  }

  // "Discard Recording" in the review panel: the File was never committed, so
  // the hook just clears its reference and returns to idle.
  const handleDiscardRecording = () => {
    setReviewDuration(0)
    setActiveSection('composer')
    recorder.discardRecording()
  }

  const closeRecorderSetup = () => {
    setIsRecorderSetupOpen(false)
    setActiveSection('composer')
  }

  // --- OpenVid-style sidebar navigation ---

  const handleSelectComposer = () => {
    setActiveSection('composer')
    setIsExportPanelOpen(true)
    setIsMediaPanelCollapsed(false)
    if (isRecorderSetupOpen) {
      setIsRecorderSetupOpen(false)
    }
    // The left-sidebar "Export" button triggers the client-side export
    // directly (works from any tab). With an empty timeline it just warns.
    if (!loading && timelineItems.length) {
      startComposition()
      return
    }
    if (!timelineItems.length) {
      setError('Add at least one clip to the timeline before exporting.')
    }
  }

  const handleSelectRecord = () => {
    setActiveSection('record')
    setIsExportPanelOpen(false)
    setIsRecorderSetupOpen(true)
  }

  const handleSelectMedia = () => {
    setActiveSection('media')
    setIsExportPanelOpen(false)
    setIsRecorderSetupOpen(false)
    setIsMediaPanelCollapsed(false)
  }

  const handleSelectBackground = () => {
    setActiveSection('background')
    setIsExportPanelOpen(false)
    setIsRecorderSetupOpen(false)
    setIsMediaPanelCollapsed(false)
    setActiveTab('upload')
    requestAnimationFrame(() => {
      audioInputRef.current?.click()
    })
  }

  const handleSelectAgent = () => {
    setActiveSection('agent')
    setIsExportPanelOpen(false)
    setIsRecorderSetupOpen(false)
    setIsMediaPanelCollapsed(false)
  }

  const handleSelectZoom = () => {
    setActiveSection('zoom')
    setOpenZoomDetail(false)
    setIsExportPanelOpen(false)
    setIsRecorderSetupOpen(false)
    setIsMediaPanelCollapsed(false)
  }

  const handleAddZoom = () => {
    const fragmentDuration = 2
    const startTime = Math.max(0, Math.min(currentTime, Math.max(0, totalDuration - fragmentDuration)))
    const endTime = Math.min(totalDuration, startTime + fragmentDuration)
    if (endTime - startTime < 0.1) return false
    const overlaps = zoomFragments.some((fragment) => startTime < fragment.endTime && endTime > fragment.startTime)
    if (overlaps) return false
    const newFragment = {
      ...DEFAULT_ZOOM_FRAGMENT,
      id: `zoom-${Date.now()}-${Math.random()}`,
      startTime,
      endTime,
    }
    setZoomFragments((prev) => [...prev, newFragment].sort((a, b) => a.startTime - b.startTime))
    setSelectedZoomFragmentId(newFragment.id)
    return true
  }

  // ZoomPanel calls onChange with either a patch object or an updater
  // function, so functional updates never hit stale captured state while
  // the focus point is being dragged.
  const updateZoomFragment = (patch) => {
    setZoomFragments((prev) => prev.map((fragment) => {
      if (fragment.id !== selectedZoomFragmentId) return fragment
      const updates = typeof patch === 'function' ? patch(fragment) : patch
      return { ...fragment, ...updates }
    }))
  }

  const handleZoomBack = () => {
    handleSelectMedia()
  }

  const handleZoomPanelBack = () => {
    setOpenZoomDetail(false)
  }

  const handleDeleteZoomFragment = () => {
    if (!selectedZoomFragmentId) return
    setZoomFragments((prev) => prev.filter((fragment) => fragment.id !== selectedZoomFragmentId))
    setSelectedZoomFragmentId(null)
  }

  const undoLatestAIEdit = () => {
    const undo = aiUndoRef.current
    if (!undo || JSON.stringify(compositionRef.current) !== undo.after) {
      setAiError('The latest AI edit is no longer the current edit, so it cannot be undone here.')
      return false
    }
    const previous = undoComposition()
    if (!previous) {
      setAiError('There is no AI edit available to undo.')
      return false
    }
    compositionRef.current = previous
    aiUndoRef.current = null
    setAiLastResult(null)
    setAiMessages((messages) => [...messages, { id: `${Date.now()}-undo`, role: 'assistant', content: 'Undid the last AI edit.' }])
    return true
  }

  const handleSendAI = async (prompt) => {
    const cleanPrompt = prompt.trim()
    if (!cleanPrompt || aiInFlightKeyRef.current) return
    if (/^undo(?: the)? last edit[.!]?$/i.test(cleanPrompt)) {
      undoLatestAIEdit()
      return
    }
    let goalContext = beginGoalTurn(aiGoal, cleanPrompt, compositionRef.current)
    setAiGoal(goalContext)
    const snapshot = JSON.stringify(compositionRef.current)
    const version = aiEditorRef.current.version
    const controller = new AbortController()
    aiControllerRef.current = controller
    aiEditorRef.current.runVersion = version
    aiInFlightKeyRef.current = cleanPrompt
    const userMessage = { id: crypto.randomUUID(), role: 'user', content: cleanPrompt }
    const history = [...aiMessages, userMessage].slice(-12).map(({ role, content }) => ({ role, content }))
    setAiMessages((previous) => [...previous, userMessage])
    setAiLoading(true)
    setAiError('')
    setAiFailedPrompt('')
    setAiProgress(null)
    const assertFresh = () => {
      if (controller.signal.aborted || aiEditorRef.current.version !== version) throw new Error('Request cancelled or editor changed. Staged edits were discarded. Submitted media jobs may still complete; check the service account before retrying.')
    }
    const review = async (details) => {
      assertFresh()
      setAiProgress((previous) => ({ ...previous, phase: 'review', message: 'Waiting for your review' }))
      const accepted = await new Promise((resolve) => {
        aiReviewResolverRef.current = resolve
        setAiReview(details)
      })
      assertFresh()
      return accepted
    }
    const context = () => ({
      selectedClipId, selectedTextId, lastEditedTarget: aiLastEditedTarget,
      recordingState: aiEditorRef.current.recordingState,
    })
    const agent = createBrowserAgent({
      signal: controller.signal, getVersion: () => aiEditorRef.current.version, assertFresh,
      context, review, progress: setAiProgress,
      onPlan: (plan) => {
        goalContext = receiveGoalPlan(goalContext, plan)
        setAiGoal(goalContext)
        return goalContext
      },
      commit: (stage) => {
        assertFresh()
        aiControllerRef.current = null
        // Keep asset identities available through undo/redo, while one composition commit
        // records the complete agent edit in the existing history.
        if (stage.files.length !== clips.length || stage.files.some((file, index) => file !== clips[index])) setClips(stage.files)
        setAgentAudioAssets((previous) => ({ ...previous, ...Object.fromEntries(stage.assets.filter((a) => a.type.startsWith('audio/')).map((a) => [a.id, a.file])) }))
        if (JSON.stringify(stage.composition) !== snapshot) {
          setComposition(stage.composition)
          compositionRef.current = stage.composition
          setTimelineItems(syncTimelineItems(timelineItems, stage.composition))
          aiUndoRef.current = { before: snapshot, after: JSON.stringify(stage.composition) }
          setAiLastEditedTarget(stage.lastEditedTarget)
        }
      },
      executeUI: async (call) => {
        if (call.name === 'open_recording_setup') {
          handleSelectRecord()
          return 'Opened recording setup. Choose your capture sources to start recording.'
        }
        if (call.name === 'stop_recording') {
          if (aiEditorRef.current.recordingState !== 'recording') throw new Error('Recording already ended.')
          recorder.stopRecording()
          return 'Requested recording stop. Review the recording before adding it.'
        }
        handleSelectUpload()
        return 'Opened Upload. Choose your media files there.'
      },
    })
    try {
      const result = await agent.run({
        prompt: cleanPrompt, composition: compositionRef.current, files: clips,
        selected_clip: compositionRef.current.tracks[0].clips.find((clip) => clip.id === selectedClipId) || null,
        selected_text_id: selectedTextId,
        assets: describeAssets(clips, clipDurations, [...Object.values(agentAudioAssets), uploadedAudioFile]),
        history, ...goalContext,
        last_edited_target: aiLastEditedTarget,
      })
      setAiLastResult(result.committed ? result.message : null)
      setAiMessages((previous) => [...previous, { id: crypto.randomUUID(), role: 'assistant', content: result.message + (result.status !== 'done' && result.results.length ? ' Staged timeline edits were discarded.' : '') }])
      setAiProgress({ phase: result.committed ? 'committed' : result.status, message: result.committed ? 'Edits applied together. Undo is available.' : 'No timeline changes applied.', results: result.results })
    } catch (requestError) {
      const receipts = requestError.receipts || []
      const serviceRan = receipts.some((r) => ['generate_image', 'generate_video', 'text_to_speech', 'transcribe'].includes(r.name))
      setAiError(`${requestError.message} No staged timeline edits were applied.${serviceRan ? ' Media service jobs are separate from timeline undo and may have been billed.' : ''}`)
      // Retrying a paid operation is a new job; require a new user request and confirmation.
      setAiFailedPrompt(serviceRan || controller.signal.aborted ? '' : cleanPrompt)
      setAiProgress({ phase: 'failed', message: 'Staged edits discarded.', results: receipts })
    } finally {
      aiControllerRef.current = null
      aiInFlightKeyRef.current = null
      respondToAIReview(false)
      setAiLoading(false)
    }
  }

  const handleSelectUpload = () => {
    setActiveSection('media')
    setIsExportPanelOpen(false)
    // The file input lives inside the Upload tab and is only mounted while
    // that tab is active, so switching the tab alone is not enough — from
    // every other tab uploadInputRef is null and the click silently no-ops.
    // Switch to the Upload tab first, then trigger the picker on the next
    // frame once React has committed the input.
    setActiveTab('upload')
    requestAnimationFrame(() => {
      uploadInputRef.current?.click()
    })
  }

  // Cancel the OpenVid countdown before recording starts: stop all
  // temporary streams and return to idle. No File can be committed
  // because recording never started.
  const handleCancelCountdown = () => {
    setCountdown(null)
    recorder.reset()
  }

  const removeFromTimeline = (uid) => {
    setTimelineItems((prev) => {
      const removeIndex = prev.findIndex((item) => item.uid === uid)
      if (removeIndex === -1) return prev
      return prev.filter((item) => item.uid !== uid)
    })

    setComposition((prev) => {
      // Rebuild clip list from scratch to keep startTime values correct after removal
      const videoTrack = prev.tracks[0]
      const remaining = videoTrack.clips.filter((clip) => clip.id !== uid)
      let runningTime = 0
      const relaid = remaining.map((clip) => {
        const updated = { ...clip, startTime: runningTime }
        runningTime += clip.duration
        return updated
      })
      return {
        ...prev,
        duration: runningTime,
        tracks: [{ ...videoTrack, clips: relaid }, prev.tracks[1]],
      }
    })
  }

  const updateSelectedClipOpacity = (opacity) => {
    if (!selectedClipId) return
    setComposition((prev) => ({
      ...prev,
      tracks: [
        {
          ...prev.tracks[0],
          clips: prev.tracks[0].clips.map((clip) =>
            clip.id === selectedClipId ? { ...clip, transform: { ...clip.transform, opacity } } : clip
          ),
        },
        prev.tracks[1],
      ],
    }))
  }

  const updateSelectedClipScale = (scale) => {
    if (!selectedClipId) return
    setComposition((prev) => ({
      ...prev,
      tracks: [
        {
          ...prev.tracks[0],
          clips: prev.tracks[0].clips.map((clip) =>
            clip.id === selectedClipId
              ? { ...clip, transform: { ...clip.transform, scale: Math.max(0.25, Math.min(3, scale)) } }
              : clip
          ),
        },
        prev.tracks[1],
      ],
    }))
  }

  const handlePreviewResizeStart = (event) => {
    if (!selectedClip) return
    event.preventDefault()
    previewResizeRef.current = {
      startX: event.clientX,
      startScale: selectedClip.transform?.scale ?? 1,
    }
    const handleMove = (moveEvent) => {
      const resize = previewResizeRef.current
      if (!resize) return
      updateSelectedClipScale(resize.startScale + (moveEvent.clientX - resize.startX) / 180)
    }
    const handleUp = () => {
      previewResizeRef.current = null
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
  }

  const trimSelectedClip = (amount) => {
    if (!selectedClipId) return
    setComposition((prev) => {
      let runningTime = 0
      const clips = prev.tracks[0].clips.map((clip) => {
        const duration = clip.id === selectedClipId
          ? Math.max(0.25, clip.duration + amount)
          : clip.duration
        const next = { ...clip, duration, startTime: runningTime }
        runningTime += duration
        return next
      })
      return { ...prev, duration: runningTime, tracks: [{ ...prev.tracks[0], clips }, prev.tracks[1]] }
    })
  }

  const updateSelectedClipSpeed = (speed) => {
    if (!selectedClipId) return
    setComposition((prev) => {
      const videoTrack = prev.tracks[0]

      // Recompute duration for the changed clip based on its original
      // source length, then re-lay-out every clip's startTime in order
      // so later clips shift correctly when an earlier one gets shorter/longer.
      let runningTime = 0
      const updatedClips = videoTrack.clips.map((clip) => {
        const isTarget = clip.id === selectedClipId
        const newSpeed = isTarget ? speed : clip.speed || 1
        const baseDuration = clip.baseDuration || clip.duration * (clip.speed || 1)
        const newDuration = baseDuration / newSpeed

        const updated = {
          ...clip,
          speed: newSpeed,
          baseDuration, // remember the original, speed-1 duration for future recalculation
          duration: newDuration,
          startTime: runningTime,
        }
        runningTime += newDuration
        return updated
      })

      return {
        ...prev,
        duration: runningTime,
        tracks: [{ ...videoTrack, clips: updatedClips }, prev.tracks[1]],
      }
    })
  }

  const handleDragStart = (index) => {
    dragIndexRef.current = index
  }

  const handleDragOver = (event) => {
    event.preventDefault()
  }

  const handleDrop = (index) => {
    const fromIndex = dragIndexRef.current
    if (fromIndex === null || fromIndex === index) return
    setClips((prev) => {
      const updated = [...prev]
      const [moved] = updated.splice(fromIndex, 1)
      updated.splice(index, 0, moved)
      return updated
    })
    dragIndexRef.current = null
  }

  // Text overlay controls: add a caption bound to the current playhead
  // position (3s, centered) and remove the selected one. Both flow through
  // the composition model so preview, timeline, and export stay in sync.
  const handleAddText = () => {
    const text = createCompositionText({ startTime: currentTime, duration: 3 })
    setComposition((prev) => ({ ...prev, texts: [...(prev.texts || []), text] }))
    setSelectedTextId(text.id)
    setError('')
  }

  const handleRemoveText = (id) => {
    setComposition((prev) => ({ ...prev, texts: (prev.texts || []).filter((t) => t.id !== id) }))
    if (selectedTextId === id) setSelectedTextId(null)
  }

  const handleDeleteJob = async () => {
    // Client-side exports live in browser memory (object URLs), not on a
    // server job queue — "delete" just discards the current result.
    clientExport.reset()
    setCurrentTime(0)
  }

  const outputVideoUrl = clientExport.result?.url || null
  const outputMimeType = clientExport.result?.mimeType || ''
  const statusClass = clientExport.status === 'done'
    ? 'status status-completed'
    : clientExport.status === 'working'
      ? 'status status-processing'
      : clientExport.status === 'error'
        ? 'status status-failed'
        : 'status status-idle'
  const statusLabel = clientExport.status === 'done'
    ? 'ready'
    : clientExport.status === 'working'
      ? 'rendering'
      : clientExport.status === 'error'
        ? 'failed'
        : clientExport.status === 'cancelled' ? 'cancelled' : 'idle'
  const selectedClip = composition.tracks[0].clips.find((c) => c.id === selectedClipId)
  // The selected video supplies the focus preview; Zoom Fragment timing is
  // independent and comes from the selected fragment's timeline range.
  const selectedZoomFragment = zoomFragments.find((fragment) => fragment.id === selectedZoomFragmentId) || null
  const zoomPanelClip = selectedClip
  const zoomPanelPreview = zoomPanelClip ? clipPreviews[zoomPanelClip.fileIndex] : null
  // Live zoom state at the playhead — drives the preview badge so it is
  // obvious the fragment is being applied frame-by-frame.
  const activeZoomClip = findActiveClip(composition, currentTime)
  const activeZoomFragment = zoomFragments.find((fragment) => currentTime >= fragment.startTime && currentTime <= fragment.endTime)
  const activeZoom = activeZoomFragment
    ? zoomEffectsForTime(activeZoomFragment, activeZoomClip?.startTime, activeZoomClip?.duration, currentTime)
    : null
  const durationByUid = new Map(
    composition.tracks[0].clips.map((clip) => [clip.id, clip.duration])
  )

  // Library thumbnail duration label: videos show their real (probed or
  // measured) length, images show the configured image duration. A video
  // whose probe is still in flight briefly shows "…" and updates when the
  // duration lands.
  const thumbDurationLabel = (file, index) => {
    if (!file?.type.startsWith('video/')) return `${imageDuration}s`
    const duration =
      clipDurations[index] ??
      (file ? recordedDurationsRef.current.get(clipFileKey(file)) : undefined)
    return duration ? formatTime(duration) : '…'
  }

  const mediaProgress = (file, index) => {
    if (!file?.type.startsWith('video/')) return 100
    return clipDurations[index] || recordedDurationsRef.current.has(clipFileKey(file)) ? 100 : 65
  }

  return (
    <div className="app-layout">
      <Sidebar
        activeSection={activeSection}
        onSelectComposer={handleSelectComposer}
        onSelectRecord={handleSelectRecord}
        onSelectMedia={handleSelectMedia}
        onSelectBackground={handleSelectBackground}
        onSelectZoom={handleSelectZoom}
        onSelectAgent={handleSelectAgent}
      />
      <main className="simple-app">
      <section className={isMediaPanelCollapsed ? 'simple-card sidebar-card is-collapsed' : 'simple-card sidebar-card'}>
        <div className="sidebar-header">
          <div>
            <p className="sidebar-kicker">Media library</p>
            <h2 className="sidebar-title">My media</h2>
          </div>
          <button
            type="button"
            className="sidebar-collapse"
            onClick={() => setIsMediaPanelCollapsed((collapsed) => !collapsed)}
            aria-label={isMediaPanelCollapsed ? 'Expand media panel' : 'Collapse media panel'}
            aria-expanded={!isMediaPanelCollapsed}
            title={isMediaPanelCollapsed ? 'Expand media panel' : 'Collapse media panel'}
          >
            {isMediaPanelCollapsed ? '›' : '‹'}
          </button>
        </div>

        {activeSection === 'zoom' ? (
          !isMediaPanelCollapsed && (
            <ZoomPanel
              fragment={selectedZoomFragment || { ...DEFAULT_ZOOM_FRAGMENT, id: null }}
              onChange={updateZoomFragment}
              onAdd={handleAddZoom}
              openDetail={openZoomDetail}
              onDetailBack={handleZoomPanelBack}
              onDelete={handleDeleteZoomFragment}
              selectedClip={zoomPanelClip}
              previewUrl={zoomPanelPreview}
            />
          )
        ) : activeSection === 'agent' ? (
          <AIChatPanel
            messages={aiMessages}
            onSend={handleSendAI}
            loading={aiLoading}
            error={aiError}
            selectedClip={selectedClip}
            assets={clips}
            lastResult={aiLastResult}
            onUndo={undoLatestAIEdit}
            failedPrompt={aiFailedPrompt}
            onRetry={handleSendAI}
            progress={aiProgress}
            review={aiReview}
            onReview={respondToAIReview}
            onCancel={cancelAI}
          />
        ) : !isMediaPanelCollapsed && !isExportPanelOpen && (
          <>
            <div className="sidebar-tabs" role="tablist" aria-label="Media types">
              <button
                type="button"
                className={activeTab === 'videos' ? 'sidebar-tab active' : 'sidebar-tab'}
                onClick={() => setActiveTab('videos')}
              >
                ▦&nbsp; My Videos
              </button>
              <button
                type="button"
                className={activeTab === 'audio' ? 'sidebar-tab active' : 'sidebar-tab'}
                onClick={() => setActiveTab('audio')}
              >
                ♫&nbsp; My Audio
              </button>
              <button
                type="button"
                className={activeTab === 'upload' ? 'sidebar-tab active' : 'sidebar-tab'}
                onClick={() => setActiveTab('upload')}
              >
                ⇧&nbsp; Upload
              </button>
            </div>

        <div className="sidebar-body">
          {activeTab === 'videos' && (
            clips.length > 0 ? (
              <div className="thumb-grid">
                {clips.map((file, index) => (
                  <div key={`${file.name}-${file.lastModified}-${index}`} className="thumb-card">
                    <button
                      type="button"
                      className="thumb-image-button"
                      onClick={() => addToTimeline(index)}
                      aria-label={`Add ${file.name} to timeline`}
                    >
                      {clipPreviews[index] ? (
                        <img src={clipPreviews[index]} alt={file.name} className="thumb-image" />
                      ) : (
                        <div className="thumb-image thumb-placeholder">🎬</div>
                      )}
                      <span className="thumb-add-badge">+</span>
                    </button>
                    <div className="thumb-details">
                      <p className="thumb-name">{file.name}</p>
                      <p className="thumb-duration">{thumbDurationLabel(file, index)}</p>
                      <div className="thumb-progress" role="progressbar" aria-valuenow={mediaProgress(file, index)} aria-valuemin="0" aria-valuemax="100">
                        <span style={{ width: `${mediaProgress(file, index)}%` }} />
                      </div>
                    </div>
                    <button
                      type="button"
                      className="thumb-remove"
                      onClick={() => removeClip(index)}
                      aria-label={`Remove ${file.name}`}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="sidebar-empty">No videos yet. Go to Upload or Record to add some.</p>
            )
          )}

          {activeTab === 'audio' && (
            audioFile ? (
              <div className="thumb-grid">
                <div className="thumb-card">
                  <div className="thumb-image thumb-placeholder">🎵</div>
                  <p className="thumb-name">{audioFile.name}</p>
                  <button
                    type="button"
                    className="thumb-remove"
                    onClick={() => setAudioFile(null)}
                    aria-label="Remove audio"
                  >
                    ×
                  </button>
                </div>
              </div>
            ) : (
              <p className="sidebar-empty">No audio yet. Go to Upload to add one.</p>
            )
          )}

          {activeTab === 'upload' && (
            <form id="compose-form" onSubmit={handleSubmit} className="upload-form">
              <label className="field">
                <span>Video or image clips</span>
                <input
                  ref={uploadInputRef}
                  type="file"
                  accept="image/*,video/*"
                  multiple
                  onChange={(event) => {
                    const newFiles = Array.from(event.target.files || [])
                    setClips((prev) => [...prev, ...newFiles])
                    setCurrentTime(0)
                    setError('')
                    setActiveTab('videos')
                    event.target.value = '' // allow re-selecting the same file(s) again later
                  }}
                />
              </label>

              <label className="field">
                <span>Optional audio</span>
                <input
                    ref={audioInputRef}
                  type="file"
                  accept="audio/*"
                    onChange={(event) => {
                      setAudioFile(event.target.files?.[0] || null)
                      setActiveTab('audio')
                      event.target.value = ''
                    }}
                />
              </label>

              <label className="field">
                <span>Image duration in seconds</span>
                <input
                  type="number"
                  min="1"
                  max="20"
                  value={imageDuration}
                  onChange={(event) => setImageDuration(Number(event.target.value || 3))}
                />
              </label>

              {error && <p className="message error">{error}</p>}
            </form>
          )}
        </div>
          </>
        )}

        {!isMediaPanelCollapsed && isExportPanelOpen && (
          <div className="export-panel" aria-label="Export options">
            <div className="export-panel-heading">
              <span>Export</span>
              <span className={statusClass}>{statusLabel}</span>
            </div>

            {clientExport.exporting && (
              <div className="export-panel-progress" role="status" aria-live="polite">
                <div className="export-progress-bar">
                  <div className="export-progress-fill" style={{ width: `${Math.round((clientExport.progress || 0) * 100)}%` }} />
                </div>
                <p>{clientExport.message}</p>
                <button type="button" className="delete-job" onClick={clientExport.cancel}>Cancel export</button>
              </div>
            )}

            {clientExport.error && <p className="message error">{clientExport.error}</p>}

            {clientExport.status === 'done' && outputVideoUrl && (
              <>
                <p className="message success">Export ready. Choose a format.</p>
                <div className="export-format-options">
                  <button type="button" className="export-format-button" onClick={() => handleDownloadFormat(EXPORT_FORMATS.WEBM)} disabled={clientExport.exporting}>
                    <strong>WebM</strong><span>Download</span>
                  </button>
                  <button type="button" className="export-format-button" onClick={() => handleDownloadFormat(EXPORT_FORMATS.MP4)} disabled={clientExport.exporting}>
                    <strong>MP4</strong><span>Download</span>
                  </button>
                </div>
                <button type="button" className="delete-job export-clear-button" onClick={handleDeleteJob}>Clear export</button>
              </>
            )}

            {!clientExport.exporting && clientExport.status !== 'done' && !clientExport.error && (
              <p className="export-panel-empty">Click Export to render your timeline.</p>
            )}
          </div>
        )}
      </section>

      <section className="simple-card result-card">
        <div className="result-heading compact">
          <div className="editor-history-actions" aria-label="Edit history">
            <button type="button" className="editor-icon-button" onClick={undoComposition} title="Undo" aria-label="Undo">↶</button>
            <button type="button" className="editor-icon-button" onClick={redoComposition} title="Redo" aria-label="Redo">↷</button>
          </div>
        </div>

        <div
          className="canvas-preview-wrapper"
          style={previewBoxStyle}
        >
          <canvas
            ref={canvasRef}
            width={previewWidth}
            height={previewHeight}
            className="canvas-preview"
          />
          {activeZoom && (
            <span className="zoom-preview-badge" role="status">
              ZOOM {activeZoom.scale.toFixed(1)}&#215;
            </span>
          )}
          {selectedClip && (
            <>
              <button
                type="button"
                className="preview-resize-handle"
                onPointerDown={handlePreviewResizeStart}
                aria-label="Resize selected clip"
                title="Drag to resize selected clip"
              />
            </>
          )}
        </div>

        {/* Synced preview audio: plays the uploaded audio with the shared
            timeline clock. Effects below keep it aligned with currentTime
            (play/pause, drift-correct, seek). After the audio ends the
            video preview keeps playing in silence. */}
        {audioUrl && (
          <audio
            ref={audioRef}
            src={audioUrl}
            preload="auto"
            hidden
          />
        )}

        {(timelineItems.length > 0 || audioFile || zoomFragments.length > 0) && (
          <div className="timeline-section compact">
            <div className="timeline-controls">
              <div className="timeline-controls-top">
                <div
                  className="dimension-control timeline-dimension-control"
                >
                  <button
                    type="button"
                    ref={dimensionTriggerRef}
                    className="dimension-trigger"
                    onClick={() => setIsDimensionsOpen((open) => !open)}
                    aria-haspopup="dialog"
                    aria-expanded={isDimensionsOpen}
                    title={`Composition dimensions: ${composition.width}\u00D7${composition.height}`}
                  >
                    <svg
                      className="dimension-trigger-icon"
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      aria-hidden="true"
                    >
                      <rect x="3" y="3" width="18" height="18" rx="3" />
                      <path d="M8 3v4M16 3v4M3 8h4M3 16h4M16 21v-4M8 21v-4M21 8h-4M21 16h-4" />
                    </svg>
                    <span>{`${composition.width}\u00D7${composition.height}`}</span>
                    <span className="dimension-trigger-caret" aria-hidden="true">&#9662;</span>
                  </button>

                  {isDimensionsOpen && (
                    <DimensionsPopover
                      value={aspectRatioMode}
                      width={composition.width}
                      height={composition.height}
                      anchorRef={dimensionTriggerRef}
                      onSelect={handleDimensionPresetSelect}
                      onApplyCustom={handleApplyCustomDimensions}
                      onClose={handleCloseDimensions}
                    />
                  )}
                </div>

                <div className="playback-bar">
                  <span className="playback-time">{formatTime(currentTime)}</span>

                  <button
                    type="button"
                    className="playback-skip"
                    onClick={skipBackward}
                    aria-label="Back 5 seconds"
                  >
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      aria-hidden="true"
                    >
                      <path d="M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6" />
                    </svg>
                  </button>

                  <button
                    type="button"
                    className="playback-play"
                    onClick={handleTogglePlayback}
                    disabled={!timelineItems.length}
                    aria-label={isPlaying ? 'Pause' : 'Play'}
                  >
                    {isPlaying ? (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <rect x="6" y="5" width="4" height="14" />
                        <rect x="14" y="5" width="4" height="14" />
                      </svg>
                    ) : (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    )}
                  </button>

                  <button
                    type="button"
                    className="playback-skip"
                    onClick={skipForward}
                    aria-label="Forward 5 seconds"
                  >
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      aria-hidden="true"
                    >
                      <path d="M12 5V1l5 5-5 5V7a6 6 0 1 0 6 6" />
                    </svg>
                  </button>

                  <span className="playback-time">{formatTime(totalDuration)}</span>
                </div>
              </div>
              <div className="timeline-scroll">
              <div
                className="timeline-canvas"
                style={{ width: `${timelineWidth}px` }}
                ref={timelineCanvasRef}
                onClick={handleTimelineClick}
              >
            <div className="timeline-ruler">
                  {rulerMarks.major.map((mark) => (
                    <span
                      key={`major-${mark.time}`}
                      className="timeline-ruler-mark major"
                      style={{ left: `${mark.position}px` }}
                    >
                      <i aria-hidden="true" />
                      <b>{formatRulerTime(mark.time)}</b>
                    </span>
                  ))}
                  {rulerMarks.minor.map((mark) => (
                    <span
                      key={`minor-${mark.time}`}
                      className="timeline-ruler-mark minor"
                      style={{ left: `${mark.position}px` }}
                    >
                      <i aria-hidden="true" />
                    </span>
                  ))}
                  <div
                    className="timeline-current-chip"
                    style={{ left: `${currentTime * zoom}px` }}
                  >
                    {formatTimePrecise(currentTime)}
                  </div>
                </div>
                <div className="timeline-track text-track">
                  <strong>VIDEO</strong>
                  <div className="track-content">
                    {timelineItems.length ? (
                      timelineItems.map((item) => {
                        const file = clips[item.clipIndex]
                        if (!file) return null
                        const isSelected = selectedClipId === item.uid
                        const itemDuration = durationByUid.get(item.uid) ?? imageDuration
                        return (
                          <div
                            key={item.uid}
                            className={isSelected ? 'timeline-block video-block selected' : 'timeline-block video-block'}
                            style={{ width: `${Math.max(itemDuration * zoom - 4, 86)}px` }}
                            onClick={() => setSelectedClipId(item.uid)}
                            title="Click to select"
                          >
                            <button type="button" className="timeline-trim-handle timeline-trim-start" onClick={(event) => { event.stopPropagation(); trimSelectedClip(-0.25) }} aria-label="Trim clip start">‹</button>
                            {clipPreviews[item.clipIndex] && <img src={clipPreviews[item.clipIndex]} className="timeline-thumb" alt="" aria-hidden="true" />}
                            <b>{file.name}</b>
                            <small>{formatTime(itemDuration)}</small>
                            <button type="button" className="timeline-trim-handle timeline-trim-end" onClick={(event) => { event.stopPropagation(); trimSelectedClip(0.25) }} aria-label="Trim clip end">›</button>
                            <button
                              type="button"
                              className="timeline-block-remove"
                              onClick={(e) => {
                                e.stopPropagation()
                                removeFromTimeline(item.uid)
                                if (selectedClipId === item.uid) setSelectedClipId(null)
                              }}
                              aria-label="Remove from timeline"
                            >
                              ×
                            </button>
                          </div>
                        )
                      })
                    ) : (
                      <em>Click a video in "My Videos" to add it here</em>
                    )}
                  </div>
                </div>
                <div className="timeline-track zoom-track">
                  <strong>ZOOM</strong>
                  <div className="track-content zoom-track-content">
                    {zoomFragments.map((fragment, index) => (
                      <button
                        type="button"
                        key={fragment.id}
                        className={fragment.id === selectedZoomFragmentId ? 'timeline-block zoom-block selected' : 'timeline-block zoom-block'}
                        style={{
                          marginLeft: `${fragment.startTime * zoom}px`,
                          width: `${Math.max((fragment.endTime - fragment.startTime) * zoom - 4, 86)}px`,
                        }}
                        onClick={() => {
                          setSelectedZoomFragmentId(fragment.id)
                          setOpenZoomDetail(true)
                          setActiveSection('zoom')
                        }}
                        title="Click to select Zoom Fragment"
                      >
                        <b>Zoom Fragment {index + 1}</b>
                        <small>{formatTime(fragment.endTime - fragment.startTime)}</small>
                      </button>
                    ))}
                    {!zoomFragments.length && <em>Click Add Zoom to create a fragment at the playhead</em>}
                  </div>
                </div>
                <div className="timeline-track"><strong>TEXT</strong><div className="track-content"><button type="button" className="timeline-add-track" onClick={handleAddText}>T&nbsp; + Add text</button>{composition.texts?.map((text) => <div key={text.id} className="timeline-block text-block" style={{ width: `${Math.max(text.duration * zoom - 4, 86)}px` }}><b>{text.content}</b><small>Text overlay</small></div>)}</div></div>
                <div className="timeline-track"><strong>AUDIO</strong><div className="track-content"><button type="button" className="timeline-add-track" onClick={handleSelectUpload}>♫&nbsp; + Add audio</button>{audioFile && <div className="timeline-block audio-block" style={{ width: `${Math.max(12 * zoom - 4, 150)}px` }}><b>{audioFile.name}</b><small>Audio track</small></div>}</div></div>
                <div className="timeline-playhead" style={{ left: `${76 + currentTime * zoom}px` }} onPointerDown={handlePlayheadPointerDown} onPointerMove={handlePlayheadPointerMove} onPointerUp={handlePlayheadPointerUp}>
                  <div className="timeline-playhead-handle" />
                </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </section>

      {recorder.recordingState === 'completed' && recorder.recordingFile && (
        <RecordingReview
          file={recorder.recordingFile}
          elapsed={reviewDuration}
          onUse={handleConfirmRecording}
          onDiscard={handleDiscardRecording}
        />
      )}

      {isRecorderSetupOpen && (
        <RecordModal
          recorder={recorder}
          onClose={closeRecorderSetup}
        />
      )}

      {['requesting_permission', 'ready', 'recording', 'stopping', 'processing'].includes(recorder.recordingState) && (
        <RecordingControls
          recordingState={recorder.recordingState}
          elapsed={recordingElapsed}
          countdown={countdown}
          onStop={recorder.stopRecording}
          onStopSharing={recorder.stopScreenCapture}
          onCancelCountdown={handleCancelCountdown}
          notice={recorder.notice}
          error={recorder.error}
          micEnabled={recorder.micEnabled}
          cameraEnabled={recorder.cameraEnabled}
          systemAudioEnabled={recorder.systemAudioEnabled}
        />
      )}
      </main>
    </div>
  )
}

export default App