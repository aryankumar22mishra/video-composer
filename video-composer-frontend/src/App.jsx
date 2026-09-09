import { useEffect, useRef, useState } from 'react'
import './App.css'
import { createComposition, createCompositionClip, COMPOSITION_DEFAULTS } from './state/composition'
import { loadAssetMetadata, resolveVideoDuration, revokeObjectUrlAsset } from './assets/AssetManager'
import { findActiveClip, drawFrame, seekAndDrawVideo } from './renderer/CompositionRenderer'
import RecordModal from './recorder/RecordModal'
import useScreenRecorder from './recorder/useScreenRecorder'
import RecordingControls from './recorder/RecordingControls'
import RecordingReview from './recorder/RecordingReview'
import DimensionsPopover from './components/DimensionsPopover'
import Sidebar from './components/Sidebar'
import { toEvenDimension } from './dimensions/DimensionPresets'

const API_BASE = '/api'

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
  const [audioFile, setAudioFile] = useState(null)
  const [imageDuration, setImageDuration] = useState(3)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [job, setJob] = useState(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [zoom, setZoom] = useState(80)
  const [duration, setDuration] = useState(0)
  const [clipPreviews, setClipPreviews] = useState([])
  const [selectedClipId, setSelectedClipId] = useState(null)
  const [activeTab, setActiveTab] = useState('videos')
  const [timelineItems, setTimelineItems] = useState([])
  const [composition, setComposition] = useState(createComposition())
  const [clipDurations, setClipDurations] = useState([])
  const [previewImages, setPreviewImages] = useState({})
  const [previewVideos, setPreviewVideos] = useState({})
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
  const PREVIEW_MAX_HEIGHT = 260
  const PREVIEW_MAX_WIDTH = 640
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

  // Active section for the OpenVid-style left sidebar navigation.
  // "composer" → existing editor view, "record" → RecordModal is opened.
  const [activeSection, setActiveSection] = useState('composer')

  const compositionVideoDuration = composition.tracks[0].clips.reduce(
    (sum, clip) => sum + clip.duration,
    0
  )
  const estimatedDuration = Math.max(compositionVideoDuration, audioFile ? 12 : 0)
  const totalDuration = duration || estimatedDuration
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
      applyDimensions(preset.id, preset.width, preset.height)
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

  // Build hidden <video> elements for video clips so the canvas can draw frames from them
  useEffect(() => {
    const createdUrls = []

    clips.forEach((file, index) => {
      if (!file.type.startsWith('video/')) return
      if (hiddenVideoRefs.current[index]) return // already created

      const url = URL.createObjectURL(file)
      createdUrls.push(url)

      const video = document.createElement('video')
      video.src = url
      video.muted = true
      video.preload = 'auto'
      video.playsInline = true
      // MediaRecorder WebM files report duration === Infinity, which leaves
      // this element unseekable and the canvas preview stuck. The documented
      // resolveVideoDuration seek workaround computes the real duration so
      // the preview can play the full recording.
      resolveVideoDuration(video).catch(() => {})
      hiddenVideoRefs.current[index] = video
      setPreviewVideos((prev) => ({ ...prev, [index]: video }))
    })

    return () => {
      createdUrls.forEach((url) => URL.revokeObjectURL(url))
    }
  }, [clips])

  // Draw the active clip (image or video frame) onto the canvas whenever
  // the playhead time or composition changes
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')

    const activeClip = findActiveClip(composition, currentTime)
    if (!activeClip) {
      drawFrame(ctx, canvas, null)
      return
    }

    const file = clips[activeClip.fileIndex]
    const timeWithinClip = currentTime - activeClip.startTime

    if (file?.type.startsWith('image/')) {
      const image = previewImages[activeClip.fileIndex]
      drawFrame(ctx, canvas, image, activeClip.transform)
    } else if (file?.type.startsWith('video/')) {
      const video = previewVideos[activeClip.fileIndex]
      if (video) {
        const speed = activeClip.speed || 1
        const sourceTime = timeWithinClip * speed
        seekAndDrawVideo(video, ctx, canvas, sourceTime, activeClip.transform)
      }
    }
  }, [currentTime, composition, previewImages, previewVideos, clips, previewWidth, previewHeight])

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

  const startComposition = async () => {
    if (!timelineItems.length) {
      setError('Please add at least one clip to the timeline.')
      return
    }

    setLoading(true)
    setError('')
    const formData = new FormData()
    timelineItems.forEach((item) => {
      const file = clips[item.clipIndex]
      if (file) formData.append('clips', file)
    })
    if (audioFile) formData.append('audio', audioFile)
    formData.append('image_duration', String(imageDuration))

    // Per-clip durations (timeline order) so the backend renders every clip
    // at its real length. Without this the backend falls back to the 3s
    // image_duration default and squeezes long recordings down. Durations
    // come from the composition itself, so speed changes are honored too.
    const durationByUid = new Map(
      composition.tracks[0].clips.map((clip) => [clip.id, clip.duration])
    )
    const durationsPayload = timelineItems.map((item) => {
      const duration = durationByUid.get(item.uid) ?? imageDuration
      return Number(Math.max(duration, 0.1).toFixed(3))
    })
    formData.append('clip_durations', JSON.stringify(durationsPayload))
    console.debug('[Submit] clip_durations=', durationsPayload)

    // Output dimensions come straight from the composition (single source
    // of truth) so the exported file matches the live preview exactly.
    // Custom/preset dims are already even (H.264 requirement); "auto"
    // omits width/height so the backend uses its 1280x720 base box, which
    // equals the composition's default size.
    if (aspectRatioMode !== 'auto') {
      formData.append('width', String(composition.width))
      formData.append('height', String(composition.height))
    }
    formData.append('aspect_ratio', aspectRatioMode)
    formData.append('fit_mode', 'pad')
    console.debug('[Submit] dimensions=', {
      width: aspectRatioMode === 'auto' ? null : composition.width,
      height: aspectRatioMode === 'auto' ? null : composition.height,
      aspect_ratio: aspectRatioMode,
      fit_mode: 'pad',
    })

    try {
      const response = await fetch(`${API_BASE}/jobs/`, {
        method: 'POST',
        body: formData,
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.detail || 'The compose request could not be started.')
      setJob(data)
    } catch (submitError) {
      setError(submitError.message)
    } finally {
      setLoading(false)
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
  }

  const handleTimelineClick = (event) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    const time = ((event.clientX - bounds.left) / bounds.width) * totalDuration
    seekTo(time)
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
    seekTo(time)
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
    setIsPlaying((prev) => !prev)
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
    console.warn('[Duration] Could not determine video length, using image duration:', file.name)
    return imageDuration
  }

  const addToTimeline = async (clipIndex) => {
    const file = clips[clipIndex]
    const clipDuration = await resolveClipDuration(file, clipIndex)
    console.debug('[Timeline] added clip duration =', clipDuration, file?.name)
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
    if (isRecorderSetupOpen) {
      setIsRecorderSetupOpen(false)
    }
    // Trigger the compose action directly. The upload form is only mounted
    // while the Upload tab is active, so submitting the DOM form would
    // silently no-op from every other tab - call the handler instead.
    if (!loading && timelineItems.length) {
      startComposition()
      return
    }
    if (!timelineItems.length) {
      setError('Add at least one clip to the timeline before composing.')
    }
  }

  const handleSelectRecord = () => {
    setActiveSection('record')
    setIsRecorderSetupOpen(true)
  }

  const handleSelectUpload = () => {
    setActiveSection('composer')
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

  const handleDeleteJob = async () => {
    if (!job) return
    try {
      await fetch(`${API_BASE}/jobs/${job.id}/`, { method: 'DELETE' })
      setJob(null)
      setCurrentTime(0)
    } catch {
      setError('Could not delete the job.')
    }
  }

  const outputVideoUrl = job?.output_video
  const statusClass = job ? `status status-${job.status}` : 'status status-idle'
  const selectedClip = composition.tracks[0].clips.find((c) => c.id === selectedClipId)
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

  return (
    <div className="app-layout">
      <Sidebar
        activeSection={activeSection}
        onSelectComposer={handleSelectComposer}
        onSelectRecord={handleSelectRecord}
        onSelectUpload={handleSelectUpload}
      />
      <main className="simple-app">
      <section className="simple-card sidebar-card">
        <div className="sidebar-header">
          <span className="sidebar-title">🎬 Compose</span>
          <span className="sidebar-meta">{clips.length} clips · {audioFile ? 1 : 0} audio</span>
        </div>

        <div className="sidebar-tabs">
          <button
            type="button"
            className={activeTab === 'videos' ? 'sidebar-tab active' : 'sidebar-tab'}
            onClick={() => setActiveTab('videos')}
          >
            🎞 My Videos
          </button>
          <button
            type="button"
            className={activeTab === 'audio' ? 'sidebar-tab active' : 'sidebar-tab'}
            onClick={() => setActiveTab('audio')}
          >
            🎵 My Audio
          </button>
          <button
            type="button"
            className={activeTab === 'upload' ? 'sidebar-tab active' : 'sidebar-tab'}
            onClick={() => setActiveTab('upload')}
          >
            ⬆ Upload
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
                    <p className="thumb-name">{file.name}</p>
                    <p className="thumb-duration">{thumbDurationLabel(file, index)}</p>
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
                  type="file"
                  accept="audio/*"
                  onChange={(event) => setAudioFile(event.target.files?.[0] || null)}
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
      </section>

      <section className="simple-card result-card">
        <div className="result-heading compact">
          <p><strong>Job ID:</strong> {job?.id ? `${job.id.slice(0, 8)}...` : '—'}</p>
          <div className="result-heading-actions">
            <span className={statusClass}>{job?.status || 'idle'}</span>
            {job && (
              <button type="button" className="delete-job" onClick={handleDeleteJob}>
                Delete
              </button>
            )}
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
        </div>

        {job?.error_message && <p className="message error">{job.error_message}</p>}

        {job?.status === 'completed' && outputVideoUrl && (
          <a
            className="primary-button download-link"
            href={outputVideoUrl}
            download
            target="_blank"
            rel="noreferrer"
          >
            ⬇ Download video
          </a>
        )}

        {job?.status === 'completed' && !outputVideoUrl && (
          <p className="message warning">The job completed without an output video URL.</p>
        )}

        {(timelineItems.length > 0 || audioFile) && (
          <div className="timeline-section compact">
            {selectedClipId && selectedClip && (
              <div className="clip-inspector">
                <span>Opacity</span>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={selectedClip.transform?.opacity ?? 1}
                  onChange={(e) => updateSelectedClipOpacity(Number(e.target.value))}
                />
                <span>Speed</span>
                <input
                  type="range"
                  min="0.25"
                  max="3"
                  step="0.25"
                  value={selectedClip.speed ?? 1}
                  onChange={(e) => updateSelectedClipSpeed(Number(e.target.value))}
                />
                <span className="speed-label">{selectedClip.speed ?? 1}x</span>
              </div>
            )}

            <div className="timeline-controls">
              <div className="timeline-controls-top">
                <div
                  className="dimension-control timeline-dimension-control"
                  onMouseEnter={() => setIsDimensionsOpen(true)}
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
                <div className="timeline-track">
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
                            <b>{file.name}</b>
                            <small>{formatTime(itemDuration)}</small>
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
                <div className="timeline-track"><strong>AUDIO</strong><div className="track-content">{audioFile ? <div className="timeline-block audio-block" style={{ width: `${Math.max(12 * zoom - 4, 150)}px` }}><b>{audioFile.name}</b><small>Audio track</small></div> : <em>Optional audio track</em>}</div></div>
                <div className="timeline-playhead" style={{ left: `${76 + currentTime * zoom}px` }}>
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