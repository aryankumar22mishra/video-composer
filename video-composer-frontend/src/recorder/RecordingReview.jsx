// RecordingReview — post-recording review panel.
//
// Rendered by App.jsx when a recording finishes (recorder state
// 'completed'). Shows the recorded File in a <video> preview (via a
// temporary object URL) and lets the user either commit it to the
// existing composer pipeline ("Use Recording") or discard it.
//
// PURE UI: it never touches streams, MediaRecorder, or the recorder
// lifecycle. The exact File object is preserved and handed back up via
// onUse. The object URL is created and revoked here and here only.

import { useEffect, useRef } from 'react'

const formatTime = (seconds) => {
  const safeSeconds = Math.max(0, Math.floor(seconds || 0))
  return `${Math.floor(safeSeconds / 60)}:${String(safeSeconds % 60).padStart(2, '0')}`
}

function RecordingReview({ file, elapsed, onUse, onDiscard }) {
  const videoRef = useRef(null)

  // Create a temporary object URL for review playback only. It is revoked
  // when the file changes, the panel closes (unmount), or a discard happens.
  useEffect(() => {
    if (!file) return undefined
    const url = URL.createObjectURL(file)
    const video = videoRef.current
    if (video) video.src = url
    return () => {
      URL.revokeObjectURL(url)
      if (video) video.removeAttribute('src')
    }
  }, [file])

  return (
    <div
      className="recording-review"
      onClick={(event) => {
        if (event.target === event.currentTarget) onDiscard()
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="recording-review-title"
    >
      <div className="recording-review-modal">
        <header className="recording-review-header">
          <h2 id="recording-review-title" className="recording-review-title">
            Recording complete
          </h2>
          <button
            type="button"
            className="record-modal-close"
            onClick={onDiscard}
            aria-label="Close and discard recording"
          >
            ✕
          </button>
        </header>

        <div className="recording-review-body">
          <div className="recording-review-video-frame">
            <video
              ref={videoRef}
              className="recording-review-video"
              controls
              playsInline
            />
          </div>

          <div className="recording-review-meta">
            <span className="recording-review-meta-label">Recording</span>
            <span className="recording-review-duration">Duration {formatTime(elapsed)}</span>
          </div>
        </div>

        <footer className="recording-review-actions">
          <button
            type="button"
            className="record-button-secondary"
            onClick={onDiscard}
          >
            Discard
          </button>
          <button
            type="button"
            className="record-button-primary"
            onClick={onUse}
          >
            Use Recording
          </button>
        </footer>
      </div>
    </div>
  )
}

export default RecordingReview