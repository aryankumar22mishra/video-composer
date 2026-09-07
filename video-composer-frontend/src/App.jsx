import { useEffect, useRef, useState } from 'react'
import './App.css'
import { createComposition, createCompositionClip } from './state/composition'
import { loadAssetMetadata, resolveVideoDuration } from './assets/AssetManager'
import { findActiveClip, drawFrame, seekAndDrawVideo } from './renderer/CompositionRenderer'
import RecordModal from './recorder/RecordModal'
import useScreenRecorder from './recorder/useScreenRecorder'
import RecordingControls from './recorder/RecordingControls'
import RecordingReview from './recorder/RecordingReview'

const API_BASE = '/api'

const formatTime = (seconds) => {
  const safeSeconds = Math.max(0, Math.floor(seconds || 0))
  return `${Math.floor(safeSeconds / 60)}:${String(safeSeconds % 60).padStart(2, '0')}`
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
  const [zoom, setZoom] = useState(48)
  const [duration, setDuration] = useState(0)
  const [clipPreviews, setClipPreviews] = useState([])
  const [selectedClipId, setSelectedClipId] = useState(null)
  const [activeTab, setActiveTab] = useState('videos')
  const [timelineItems, setTimelineItems] = useState([]) // sequence of { clipIndex, uid }
  const [composition, setComposition] = useState(createComposition())
  const [assetMetadata, setAssetMetadata] = useState([])
  const [previewImages, setPreviewImages] = useState({}) // { clipIndex: HTMLImageElement }
  const [previewVideos, setPreviewVideos] = useState({}) // { clipIndex: HTMLVideoElement }
  const [isRecorderSetupOpen, setIsRecorderSetupOpen] = useState(false)
  const [recordingElapsed, setRecordingElapsed] = useState(0)
  const [countdown, setCountdown] = useState(null) // OpenVid countdown: null | 3 | 2 | 1
  const [reviewDuration, setReviewDuration] = useState(0) // duration shown in the review panel
  const recordingStartedAtRef = useRef(null)

  // Recorder lifecycle lives at the App level so it survives the Setup UI
  // being closed. Closing the modal during an active recording must NOT
  // stop or discard that recording.
  const recorder = useScreenRecorder({ onCommit: commitRecording })

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

  // Safety: if the recorder leaves 'ready' without starting (e.g. the
  // user cancels during the countdown), drop the countdown UI at once.
  useEffect(() => {
    if (countdown && recorder.recordingState !== 'ready') {
      setCountdown(null)
    }
  }, [countdown, recorder.recordingState])

  // If a recording/auto-start fails AFTER the setup UI was auto-closed,
  // bring the setup back so the friendly error is visible and the user
  // can retry. (Cancelling is silent — no error text — so it never reopens.)
  useEffect(() => {
    if (
      !countdown &&
      recorder.recordingState === 'idle' &&
      recorder.error
    ) {
      setIsRecorderSetupOpen(true)
    }
  }, [countdown, recorder.recordingState, recorder.error])

  // Visible timer for the recording bar. Timestamp-based (not tick-based)
  // so the elapsed time stays accurate even if background tabs throttle
  // intervals or the user returns mid-recording. The final length is
  // captured for the post-recording review panel.
  useEffect(() => {
    if (recorder.recordingState === 'recording') {
      recordingStartedAtRef.current = Date.now()
      const tick = () => {
        setRecordingElapsed(
          Math.max(0, Math.floor((Date.now() - recordingStartedAtRef.current) / 1000)),
        )
      }
      const interval = setInterval(tick, 250)
      return () => clearInterval(interval)
    }
    if (recordingStartedAtRef.current) {
      setReviewDuration(
        Math.max(0, Math.floor((Date.now() - recordingStartedAtRef.current) / 1000)),
      )
    }
    recordingStartedAtRef.current = null
    setRecordingElapsed(0)
    return undefined
  }, [recorder.recordingState])

  const videoRef = useRef(null)
  const dragIndexRef = useRef(null)
  const hiddenVideoRefs = useRef({}) // index -> HTMLVideoElement (canvas preview)
  const hiddenVideoUrlRefs = useRef({}) // index -> object URL (lives as long as the video)
  const canvasRef = useRef(null)

  const estimatedDuration = Math.max(
    composition.duration || 0,
    timelineItems.length * imageDuration,
    audioFile ? 12 : 0
  )
  const totalDuration = duration || estimatedDuration
  const progress = totalDuration ? (currentTime / totalDuration) * 100 : 0
  const timelineWidth = Math.max(560, totalDuration * zoom + 30)

  // Poll job status while pending/processing
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

  // Load real browser-side metadata (dimensions/duration) for each clip
  useEffect(() => {
    let cancelled = false

    Promise.all(clips.map((file) => loadAssetMetadata(file).catch((err) => {
      console.error(err)
      return null
    }))).then((results) => {
      if (!cancelled) setAssetMetadata(results)
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

  // Build hidden <video> elements for video clips so the canvas can draw frames
  // from them. MediaRecorder-produced WebM files report duration === Infinity,
  // which makes the element unseekable — seeks are ignored and the canvas
  // preview freezes (the file itself plays fine after FFmpeg renders it).
  // resolveVideoDuration() applies the seek-to-end probe so every preview
  // element becomes seekable and playback works for recordings too.
  useEffect(() => {
    const urls = hiddenVideoUrlRefs.current

    clips.forEach((file, index) => {
      if (!file.type.startsWith('video/')) return
      if (hiddenVideoRefs.current[index]) return // already created

      const url = URL.createObjectURL(file)
      urls[index] = url

      const video = document.createElement('video')
      video.src = url
      video.muted = true
      video.preload = 'auto'
      video.playsInline = true
      hiddenVideoRefs.current[index] = video
      setPreviewVideos((prev) => ({ ...prev, [index]: video }))

      // Fix the Infinity duration so the element can seek (and therefore
      // play) in the canvas preview. IMPORTANT: the probe seek must happen
      // AFTER loadedmetadata — a currentTime set before metadata loads is
      // treated by Chrome as a start-position hint, not a real seek, and
      // the duration fix would never engage. Fire-and-forget; failures are
      // non-fatal.
      const runDurationProbe = () => {
        resolveVideoDuration(video).catch(() => {})
      }
      if (video.readyState >= 1) {
        runDurationProbe()
      } else {
        video.addEventListener('loadedmetadata', runDurationProbe, { once: true })
      }
    })

    // Release the video element + object URL only for clips that were
    // removed. Revoking URLs that are still in use would break playback.
    Object.keys(hiddenVideoRefs.current).forEach((key) => {
      const index = Number(key)
      if (clips[index]) return
      hiddenVideoRefs.current[index]?.pause?.()
      delete hiddenVideoRefs.current[index]
      const staleUrl = urls[index]
      if (staleUrl) URL.revokeObjectURL(staleUrl)
      delete urls[index]
    })
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
  }, [currentTime, composition, previewImages, previewVideos, clips])

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

  const handleSubmit = async (event) => {
    event.preventDefault()

    if (!timelineItems.length) {
      setError('Please add at least one clip to the timeline.')
      return
    }

    setLoading(true)
    setError('')
    const formData = new FormData()
    // Per-clip durations (Phase: duration fix), built in the SAME order the
    // files are appended below (timelineItems order). Videos carry their
    // real composition duration (matched by uid — never a blind index);
    // images carry the image duration setting. The backend renders each
    // clip for exactly this many seconds.
    const clipDurations = []
    timelineItems.forEach((item) => {
      const file = clips[item.clipIndex]
      if (!file) return
      formData.append('clips', file)

      const isVideo = file.type?.startsWith('video/')
      const compositionClip = composition.tracks[0]?.clips.find(
        (clip) => clip.id === item.uid
      )
      const compositionDuration = compositionClip?.duration
      const clipDuration = isVideo && Number.isFinite(compositionDuration) && compositionDuration > 0
        ? compositionDuration
        : imageDuration
      clipDurations.push(clipDuration)
    })
    if (audioFile) formData.append('audio', audioFile)
    formData.append('image_duration', String(imageDuration))
    formData.append('clip_durations', JSON.stringify(clipDurations))
    console.debug('[Submit] clip_durations=', clipDurations)

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

  const seekTo = (nextTime) => {
    const boundedTime = Math.max(0, Math.min(nextTime, totalDuration || nextTime))
    setCurrentTime(boundedTime)
    if (videoRef.current && Number.isFinite(videoRef.current.duration)) {
      videoRef.current.currentTime = boundedTime
    }
  }

  const handleTimelineClick = (event) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    seekTo(((event.clientX - bounds.left) / bounds.width) * totalDuration)
  }

  const handleVideoMetadata = (event) => {
    setDuration(event.currentTarget.duration)
    setCurrentTime(event.currentTarget.currentTime)
  }

  const handleVideoTimeUpdate = (event) => {
    setCurrentTime(event.currentTarget.currentTime)
  }

  const handleVideoSeeked = (event) => {
    setCurrentTime(event.currentTarget.currentTime)
  }

  const handleTogglePlayback = () => {
    setIsPlaying((prev) => !prev)
  }

  const removeClip = (index) => {
    setClips((prev) => prev.filter((_, i) => i !== index))
    setTimelineItems((prev) =>
      prev
        .filter((item) => item.clipIndex !== index)
        .map((item) => (item.clipIndex > index ? { ...item, clipIndex: item.clipIndex - 1 } : item))
    )
  }

  const addToTimeline = (clipIndex) => {
    const uid = `${clipIndex}-${Date.now()}-${Math.random()}`
    setTimelineItems((prev) => [...prev, { clipIndex, uid }])
    setComposition((prev) => {
      const videoTrack = prev.tracks[0]
      const startTime = videoTrack.clips.reduce((sum, clip) => sum + clip.duration, 0)
      const file = clips[clipIndex]

      // Duration policy (Phase 4):
      //   - images keep the existing image-duration behavior
      //   - videos use their REAL duration from the browser-loaded metadata,
      //     falling back to imageDuration only if metadata isn't ready yet
      const isVideo = file?.type?.startsWith('video/')
      const metaDuration = assetMetadata[clipIndex]?.duration
      const clipDuration = isVideo && typeof metaDuration === 'number' && Number.isFinite(metaDuration) && metaDuration > 0
        ? metaDuration
        : imageDuration

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

  // Adds a freshly recorded file to the media library. Everything after
  // this (thumbnails, hidden <video>, metadata, timeline, upload) reuses
  // the existing `clips` pipeline unchanged.
  // Note: this MUST stay a function declaration, not `const` arrow — it is
  // referenced by the useScreenRecorder() hook at the top of App() (line 41),
  // and a `const` would be in the Temporal Dead Zone there (blank page).
  function commitRecording(file) {
    setClips((prev) => [...prev, file])
    setActiveTab('videos')
    setCurrentTime(0)
    setError('')
  }

  const closeRecorderSetup = () => {
    setIsRecorderSetupOpen(false)
  }

  // Cancel the OpenVid countdown before recording starts: stop all
  // temporary streams and return to idle. No File can be committed
  // because recording never started.
  const handleCancelCountdown = () => {
    setCountdown(null)
    recorder.reset()
  }

  const outputVideoUrl = job?.output_video
  const statusClass = job ? `status status-${job.status}` : 'status status-idle'
  const selectedClip = composition.tracks[0].clips.find((c) => c.id === selectedClipId)

  return (
    <main className="simple-app">
      <section className="simple-card sidebar-card">
        <div className="sidebar-header">
          <span className="sidebar-title">🎬 Compose</span>
          <span className="sidebar-header-actions">
            <button
              type="button"
              className={
                recorder.recordingState === 'recording'
                  ? 'record-button is-active'
                  : 'record-button'
              }
              onClick={() => setIsRecorderSetupOpen(true)}
            >
              {recorder.recordingState === 'recording' ? '⏺ Recording' : '🎥 Record'}
            </button>
            <span className="sidebar-meta">{clips.length} clips · {audioFile ? 1 : 0} audio</span>
          </span>
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
                    <p className="thumb-duration">
                      {file.type.startsWith('video/') && assetMetadata[index] && typeof assetMetadata[index].duration === 'number' && Number.isFinite(assetMetadata[index].duration)
                        ? `${Math.round(assetMetadata[index].duration)}s`
                        : `${imageDuration}s`}
                    </p>
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
              <p className="sidebar-empty">No videos yet. Go to Upload to add some.</p>
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
            <form onSubmit={handleSubmit} className="upload-form">
              <label className="field">
                <span>Video or image clips</span>
                <input
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

              <button type="submit" className="primary-button" disabled={loading}>
                {loading ? 'Submitting job...' : 'Compose video'}
              </button>
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

        <div className="canvas-preview-wrapper">
          <canvas ref={canvasRef} width="1280" height="720" className="canvas-preview" />
          <p className="canvas-preview-label">Live preview</p>
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
              <button type="button" className="timeline-play" onClick={handleTogglePlayback} disabled={!timelineItems.length}>{isPlaying ? 'Pause' : 'Play'}</button>
              <button type="button" onClick={() => seekTo(0)}>Start</button>
              <input type="range" min="0" max={totalDuration || 1} step="0.1" value={currentTime} onChange={(event) => seekTo(Number(event.target.value))} aria-label="Timeline position" />
              <button type="button" onClick={() => setZoom((value) => Math.max(24, value - 8))}>−</button>
              <button type="button" onClick={() => setZoom((value) => Math.min(96, value + 8))}>+</button>
            </div>

            <div className="timeline-scroll">
              <div className="timeline-canvas" style={{ width: `${timelineWidth}px` }} onClick={handleTimelineClick}>
                <div className="timeline-ruler"><span />{Array.from({ length: Math.max(2, Math.ceil(totalDuration) + 1) }, (_, index) => <span key={index} style={{ left: `${index * zoom}px` }}>{formatTime(index)}</span>)}</div>
                <div className="timeline-track">
                  <strong>VIDEO</strong>
                  <div className="track-content">
                    {timelineItems.length ? (
                      timelineItems.map((item) => {
                        const file = clips[item.clipIndex]
                        if (!file) return null
                        const isSelected = selectedClipId === item.uid
                        const blockClip = composition.tracks[0]?.clips.find((clip) => clip.id === item.uid)
                        const blockDuration = blockClip?.duration || imageDuration
                        return (
                          <div
                            key={item.uid}
                            className={isSelected ? 'timeline-block video-block selected' : 'timeline-block video-block'}
                            style={{ width: `${Math.max(blockDuration * zoom - 4, 86)}px` }}
                            onClick={() => setSelectedClipId(item.uid)}
                            title="Click to select"
                          >
                            <b>{file.name}</b>
                            <small>{formatTime(blockDuration)}</small>
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
                <div className="timeline-playhead" style={{ left: `${progress}%` }} />
              </div>
            </div>
          </div>
        )}
      </section>

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

      {recorder.recordingState === 'completed' && recorder.recordingFile && (
        <RecordingReview
          file={recorder.recordingFile}
          elapsed={reviewDuration}
          onUse={recorder.confirmRecording}
          onDiscard={recorder.discardRecording}
        />
      )}

      {isRecorderSetupOpen && (
        <RecordModal
          recorder={recorder}
          onClose={closeRecorderSetup}
        />
      )}
    </main>
  )
}

export default App