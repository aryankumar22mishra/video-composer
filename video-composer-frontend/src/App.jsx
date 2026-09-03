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
  const videoRef = useRef(null)

  const estimatedDuration = Math.max(clips.length * imageDuration, audioFile ? 12 : 0)
  const totalDuration = duration || estimatedDuration
  const progress = totalDuration ? (currentTime / totalDuration) * 100 : 0
  const timelineWidth = Math.max(560, totalDuration * zoom + 30)

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

  const handleSubmit = async (event) => {
    event.preventDefault()

    if (!clips.length) {
      setError('Please add at least one image or video clip.')
      return
    }

    setLoading(true)
    setError('')
    const formData = new FormData()
    clips.forEach((file) => formData.append('clips', file))
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

  const outputVideoUrl = job?.output_video
  const statusClass = job ? `status status-${job.status}` : 'status status-idle'

  return (
    <main className="simple-app">
      <section className="simple-card">
        <p className="eyebrow">Video Composer</p>
        <h1>Create a video</h1>
        <p className="intro">Upload your clips and let the background worker create one video.</p>

        <form onSubmit={handleSubmit} className="upload-form">
          <label className="field">
            <span>Video or image clips</span>
            <input
              type="file"
              accept="image/*,video/*"
              multiple
              onChange={(event) => {
                setClips(Array.from(event.target.files || []))
                setCurrentTime(0)
                setError('')
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

          {clips.length > 0 && (
            <div className="file-summary">
              <strong>{clips.length} clip(s) selected</strong>
              <ul>
                {clips.map((file) => <li key={`${file.name}-${file.lastModified}`}>{file.name}</li>)}
              </ul>
            </div>
          )}

          {audioFile && <p className="audio-summary">Audio: {audioFile.name}</p>}
          {error && <p className="message error">{error}</p>}

          <button type="submit" className="primary-button" disabled={loading}>
            {loading ? 'Submitting job...' : 'Compose video'}
          </button>
        </form>
      </section>

      <section className="simple-card result-card">
        <div className="result-heading">
          <div>
            <h2>Render result</h2>
          </div>
          <span className={statusClass}>{job?.status || 'idle'}</span>
        </div>

        {job ? (
          <div className="result-content">
            <p><strong>Job ID:</strong> {job.id}</p>
            {job.error_message && <p className="message error">{job.error_message}</p>}
            {outputVideoUrl && <video ref={videoRef} className="output-video" controls src={outputVideoUrl} onLoadedMetadata={handleVideoMetadata} onTimeUpdate={handleVideoTimeUpdate} onSeeked={handleVideoSeeked} onPlay={() => setIsPlaying(true)} onPause={() => setIsPlaying(false)} onEnded={() => setCurrentTime(duration)} />}
            {!outputVideoUrl && job.status === 'completed' && <p className="message warning">The job completed without an output video URL.</p>}
          </div>
        ) : (
          <p className="empty-state">Your generated video will appear here.</p>
        )}

        {(clips.length > 0 || audioFile) && (
          <div className="timeline-section">
            <div className="timeline-heading">
              <div>
                <p className="eyebrow">Timeline</p>
                <h2>Render timeline</h2>
              </div>
              <span>{formatTime(currentTime)} / {formatTime(totalDuration)}</span>
            </div>
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
                <div className="timeline-track"><strong>VIDEO</strong><div className="track-content">{clips.length ? clips.map((file) => <div key={`${file.name}-${file.lastModified}`} className="timeline-block video-block" style={{ width: `${Math.max(imageDuration * zoom - 4, 86)}px` }}><b>{file.name}</b><small>{formatTime(imageDuration)}</small></div>) : <em>Add clips to build your video</em>}</div></div>
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
