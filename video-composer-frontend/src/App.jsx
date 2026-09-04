import { useEffect, useRef, useState } from 'react'
import './App.css'

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
  const videoRef = useRef(null)
  const dragIndexRef = useRef(null)

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
  }

  const removeFromTimeline = (uid) => {
    setTimelineItems((prev) => prev.filter((item) => item.uid !== uid))
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
                    setClips(Array.from(event.target.files || []))
                    setTimelineItems([])
                    setCurrentTime(0)
                    setError('')
                    setActiveTab('videos')
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

        {job ? (
          <div className="result-content compact">
            {job.error_message && <p className="message error">{job.error_message}</p>}
            {outputVideoUrl && (
              <video
                ref={videoRef}
                className="output-video compact"
                src={outputVideoUrl}
                onLoadedMetadata={handleVideoMetadata}
                onTimeUpdate={handleVideoTimeUpdate}
                onSeeked={handleVideoSeeked}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onEnded={() => setCurrentTime(duration)}
              />
            )}
            {!outputVideoUrl && job.status === 'completed' && (
              <p className="message warning">The job completed without an output video URL.</p>
            )}
          </div>
        ) : (
          <p className="empty-state">Your generated video will appear here.</p>
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