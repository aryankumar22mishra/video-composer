import { useEffect, useRef, useState } from 'react'
import './App.css'
import { createComposition, createCompositionClip } from './state/composition'
import { loadAssetMetadata } from './assets/AssetManager'
import { findActiveClip, drawFrame, seekAndDrawVideo } from './renderer/CompositionRenderer'

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
  const [activeTab, setActiveTab] = useState('videos')
  const [timelineItems, setTimelineItems] = useState([]) // sequence of { clipIndex, uid }
  const [composition, setComposition] = useState(createComposition())
  const [assetMetadata, setAssetMetadata] = useState([])
  const [previewImages, setPreviewImages] = useState({}) // { clipIndex: HTMLImageElement }
  const [previewVideos, setPreviewVideos] = useState({}) // { clipIndex: HTMLVideoElement }
  const videoRef = useRef(null)
  const dragIndexRef = useRef(null)
  const hiddenVideoRefs = useRef({})
  const canvasRef = useRef(null)

  const estimatedDuration = Math.max(timelineItems.length * imageDuration, audioFile ? 12 : 0)
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
      drawFrame(ctx, canvas, image)
    } else if (file?.type.startsWith('video/')) {
      const video = previewVideos[activeClip.fileIndex]
      if (video) {
        seekAndDrawVideo(video, ctx, canvas, timeWithinClip)
      }
    }
  }, [currentTime, composition, previewImages, previewVideos, clips])

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
    timelineItems.forEach((item) => {
      const file = clips[item.clipIndex]
      if (file) formData.append('clips', file)
    })
    if (audioFile) formData.append('audio', audioFile)
    formData.append('image_duration', String(imageDuration))

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
    if (!videoRef.current) return
    if (videoRef.current.paused) {
      videoRef.current.play()
    } else {
      videoRef.current.pause()
    }
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
    setTimelineItems((prev) => [
      ...prev,
      { clipIndex, uid: `${clipIndex}-${Date.now()}-${Math.random()}` },
    ])
    setComposition((prev) => {
      const videoTrack = prev.tracks[0]
      const startTime = videoTrack.clips.reduce((sum, clip) => sum + clip.duration, 0)
      const file = clips[clipIndex]
      const newClip = createCompositionClip(file, clipIndex, startTime, imageDuration)
      return {
        ...prev,
        duration: startTime + imageDuration,
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

  return (
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
                    <p className="thumb-duration">{imageDuration}s</p>
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
            <div className="timeline-controls">
              <button type="button" className="timeline-play" onClick={handleTogglePlayback} disabled={!outputVideoUrl}>{isPlaying ? 'Pause' : 'Play'}</button>
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
                        return (
                          <div
                            key={item.uid}
                            className="timeline-block video-block"
                            style={{ width: `${Math.max(imageDuration * zoom - 4, 86)}px` }}
                            onClick={() => removeFromTimeline(item.uid)}
                            title="Click to remove from timeline"
                          >
                            <b>{file.name}</b>
                            <small>{formatTime(imageDuration)}</small>
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
    </main>
  )
}

export default App