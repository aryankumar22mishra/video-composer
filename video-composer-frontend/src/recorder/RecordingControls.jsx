// RecordingControls — persistent App-level recording UI.
//
// Rendered by App.jsx (NOT RecordModal) so it survives the setup modal
// being closed. It shows:
//   - the OpenVid-style countdown (3 → 2 → 1 → recording) that appears
//     right after the user picks a screen/window/tab, and
//   - the compact recording bar (🔴 RECORDING 00:17 ■ STOP) that stays
//     visible for the whole active recording session — even if the user
//     switches browser tabs or closes the setup modal.
//
// This component is PURE UI: it never touches streams, MediaRecorder, or
// cleanup. It only calls recorder actions passed down from App.jsx and
// never owns the recording lifecycle.

import { useCallback, useEffect, useState } from 'react'

const formatTime = (seconds) => {
  const safeSeconds = Math.max(0, Math.floor(seconds || 0))
  return `${Math.floor(safeSeconds / 60)}:${String(safeSeconds % 60).padStart(2, '0')}`
}

// Animated recording dot with pulse effect
function RecordingDot() {
  return (
    <span className="recording-dot" aria-hidden>
      <span className="recording-dot-pulse" />
    </span>
  )
}

// Status indicator component
function StatusIndicator({ type, children }) {
  return (
    <span className={`recording-status-indicator recording-status-${type}`}>
      {children}
    </span>
  )
}

function RecordingControls({
  recordingState,
  elapsed,
  countdown,
  onStop,
  onStopSharing,
  onCancelCountdown,
  notice,
  error,
  micEnabled,
  cameraEnabled,
  systemAudioEnabled,
}) {
  const message = notice || error
  const [countdownAnimating, setCountdownAnimating] = useState(false)

  // Trigger countdown animation
  useEffect(() => {
    if (countdown) {
      setCountdownAnimating(true)
      const timer = setTimeout(() => setCountdownAnimating(false), 100)
      return () => clearTimeout(timer)
    }
  }, [countdown])

  const handleStop = useCallback(() => {
    onStop()
  }, [onStop])

  // OpenVid countdown — a centered overlay that never touches the streams.
  if (countdown) {
    return (
      <div className="recording-countdown-overlay">
        <div
          className={`recording-countdown ${countdownAnimating ? 'is-animating' : ''}`}
          role="status"
          aria-live="polite"
        >
          <div className="recording-countdown-content">
            <span className="recording-countdown-number">{countdown}</span>
            <span className="recording-countdown-label">Get ready…</span>
            <div className="recording-countdown-hints">
              {micEnabled && <StatusIndicator type="mic">🎙 Microphone ON</StatusIndicator>}
              {systemAudioEnabled && <StatusIndicator type="audio">🔊 System Audio ON</StatusIndicator>}
              {cameraEnabled && <StatusIndicator type="camera">📹 Camera ON</StatusIndicator>}
            </div>
            <button
              type="button"
              className="record-button-secondary"
              onClick={onCancelCountdown}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Screen captured but recording hasn't started yet (or auto-start failed
  // and left us here). Always give the user a way back to the composer /
  // to stop sharing — never a stranded state with no control.
  if (recordingState === 'ready') {
    return (
      <div className="recording-active-bar" role="status" aria-live="polite">
        <RecordingDot />
        <span className="recording-active-text">
          Screen sharing active — {message || 'ready to record'}
        </span>
        <div className="recording-active-controls">
          <button
            type="button"
            className="recording-active-stop"
            onClick={onStopSharing}
          >
            ■ Stop sharing
          </button>
        </div>
      </div>
    )
  }

  // Active recording — compact professional control bar.
  if (recordingState === 'recording') {
    return (
      <div className="recording-control-bar" role="status" aria-live="polite">
        <div className="recording-control-main">
          <span className="recording-control-rec-label" title="Recording" aria-label="Recording in progress">
            <RecordingDot />
            <span>REC</span>
          </span>
          <span className="recording-control-timer">{formatTime(elapsed)}</span>
        </div>
        <span className="recording-control-separator" aria-hidden>│</span>
        <div className="recording-control-status">
          {micEnabled && (
            <button type="button" className="recording-control-btn" title="Microphone ON" aria-label="Microphone ON">
              🎤
            </button>
          )}
          {systemAudioEnabled && (
            <button type="button" className="recording-control-btn" title="System Audio ON" aria-label="System Audio ON">
              🔊
            </button>
          )}
          {cameraEnabled && (
            <button type="button" className="recording-control-btn" title="Camera ON" aria-label="Camera ON">
              📷
            </button>
          )}
        </div>
        <button
          type="button"
          className="recording-control-stop"
          onClick={handleStop}
          title="Stop recording"
        >
          ■ Stop
        </button>
      </div>
    )
  }

  // Finalizing — the File is being assembled; no actions.
  if (recordingState === 'stopping' || recordingState === 'processing') {
    return (
      <div className="recording-active-bar" role="status" aria-live="polite">
        <span className="recording-active-text">Finalizing…</span>
        {message && (
          <span className="recording-active-notice">{message}</span>
        )}
      </div>
    )
  }

  return null
}

export default RecordingControls
