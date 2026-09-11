// Recording Setup — OpenVid-style two-column UI for the existing recorder.
//
//   LEFT:  large live preview (shared screen + webcam bubble overlay)
//          with the initial-position selector below it.
//   RIGHT: Camera / Microphone / System Audio settings cards.
//   FOOTER: Cancel + the state-driven primary action (Share screen →
//          Start recording → Stop recording → Processing…).
//
// The recorder lifecycle (hook) lives in App.jsx so it survives this modal
// being closed. This component receives the recorder via props. Closing the
// modal while a recording is active must NOT stop or discard that recording.

import { useCallback, useEffect, useRef } from 'react'

const SIZE_ORDER = ['small', 'medium', 'large']
const SIZE_PERCENT = { small: 18, medium: 25, large: 32 }

const SHAPE_OPTIONS = [
  { value: 'squircle', label: 'Squircle' },
  { value: 'circle', label: 'Circle' },
  { value: 'square', label: 'Square' },
]

const SHAPE_RADIUS = { squircle: '24%', circle: '50%', square: '6px' }

const POSITION_OPTIONS = [
  { value: 'top-left', label: 'Top Left' },
  { value: 'top-right', label: 'Top Right' },
  { value: 'bottom-left', label: 'Bottom Left' },
  { value: 'bottom-right', label: 'Bottom Right' },
]

const BUBBLE_POSITION_STYLE = {
  'top-left': { top: 14, left: 14 },
  'top-right': { top: 14, right: 14 },
  'bottom-left': { bottom: 14, left: 14 },
  'bottom-right': { bottom: 14, right: 14 },
}

function ShapeIcon({ shape }) {
  const common = { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true }
  if (shape === 'circle') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.8" />
      </svg>
    )
  }
  if (shape === 'square') {
    return (
      <svg {...common}>
        <rect x="5" y="5" width="14" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <rect x="4" y="4" width="16" height="16" rx="6" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  )
}

function RecordModal({ recorder, onClose }) {
  const {
    devices,
    cameraEnabled, setCameraEnabled,
    cameraDeviceId, setCameraDeviceId,
    cameraShape, setCameraShape,
    cameraSize, setCameraSize,
    cameraZoom, setCameraZoom,
    cameraMirror, setCameraMirror,
    cameraPosition, setCameraPosition,
    micEnabled, setMicEnabled,
    micDeviceId, setMicDeviceId,
    micStream,
    cameraStream,
    systemAudioEnabled, setSystemAudioEnabled,
    recordingState, screenStream, error, notice,
    startScreenCapture, startRecording,
    reset,
  } = recorder

  const previewVideoRef = useRef(null)
  const cameraPreviewRef = useRef(null)

  // Attach the captured stream to the <video> preview via srcObject.
  // A null stream clears the preview (no object URLs for MediaStreams).
  useEffect(() => {
    const video = previewVideoRef.current
    if (video) video.srcObject = screenStream
  }, [screenStream])

  // Attach the webcam stream to the live camera preview via srcObject.
  // Cleared automatically when the camera stops or disconnects.
  useEffect(() => {
    const video = cameraPreviewRef.current
    if (video) video.srcObject = cameraStream
  }, [cameraStream])

  // After the hook delivers onCommit(file) exactly once, close the modal
  // through the existing App contract (onClose).
  useEffect(() => {
    if (recordingState === 'completed') onClose()
  }, [recordingState, onClose])

  const handleCancel = useCallback(() => {
    // If a recording is active (or finalizing), closing the setup UI must
    // NOT stop or discard it. Just hide the modal; the recorder keeps
    // running and the user can stop it via the persistent control.
    if (
      recordingState === 'recording' ||
      recordingState === 'stopping' ||
      recordingState === 'processing'
    ) {
      onClose()
    } else {
      reset()
      onClose()
    }
  }, [recordingState, reset, onClose])

  const handleBackdropClick = (event) => {
    if (event.target === event.currentTarget) handleCancel()
  }

  // Close the modal on Escape, matching typical dialog behavior. Cancel is
  // routed through handleCancel so any active recording is safely discarded.
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') handleCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleCancel])

  // Browsers require getDisplayMedia() to run synchronously inside this
  // user gesture, so "Share Screen" calls startScreenCapture() directly.
  const handleShareScreen = () => {
    console.debug('[Recorder][UI] Share Screen button clicked — calling startScreenCapture()')
    startScreenCapture()
  }

  const handleStartRecording = () => {
    startRecording()
  }

  // NOTE: no local Stop handler — while recording, the persistent
  // App-level RecordingControls bar owns the Stop action.

  // --- Derived UI state -------------------------------------------------
  // Pure CSS preview: the bubble mirrors shape/size/mirror/position via
  // inline styles. The recording canvas in the hook stays authoritative.
  const sizeIndex = Math.max(0, SIZE_ORDER.indexOf(cameraSize))
  const sizePercent = SIZE_PERCENT[cameraSize] ?? 25
  const bubbleStyle = {
    width: `${sizePercent}%`,
    aspectRatio: '1 / 1',
    borderRadius: SHAPE_RADIUS[cameraShape] ?? '50%',
    ...(BUBBLE_POSITION_STYLE[cameraPosition] ?? BUBBLE_POSITION_STYLE['bottom-right']),
    transformOrigin: 'center center',
    transform: `scale(${cameraZoom}) ${cameraMirror ? 'scaleX(-1)' : ''}`.trim(),
  }

  // State-driven primary footer action (single button that morphs).
  let primaryAction = { label: '🖥 Share screen', action: handleShareScreen, disabled: false, tone: '' }
  if (recordingState === 'requesting_permission') {
    primaryAction = { label: 'Requesting…', action: null, disabled: true, tone: '' }
  } else if (recordingState === 'ready') {
    primaryAction = { label: '● Start recording', action: handleStartRecording, disabled: !screenStream, tone: '' }
  } else if (recordingState === 'recording') {
    // The persistent App-level RecordingControls bar owns Stop while
    // recording — this setup modal must not show a competing Stop button.
    primaryAction = { label: '⏺ Recording in progress…', action: null, disabled: true, tone: '' }
  } else if (recordingState === 'stopping' || recordingState === 'processing') {
    primaryAction = { label: 'Processing…', action: null, disabled: true, tone: '' }
  } else if (recordingState === 'completed') {
    primaryAction = { label: '✓ Saved', action: null, disabled: true, tone: '' }
  } else if (recordingState === 'error' && screenStream) {
    primaryAction = { label: '● Start recording', action: handleStartRecording, disabled: false, tone: '' }
  }

  const statusPill =
    recordingState === 'recording' ? '⏺ Recording'
      : recordingState === 'ready' ? 'Screen sharing active'
        : recordingState === 'requesting_permission' ? 'Requesting permission…'
          : recordingState === 'stopping' || recordingState === 'processing' ? 'Finalizing…'
            : null

  return (
    <div
      className="recorder-overlay"
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-label="Recording setup"
    >
      <div className="record-modal">
        <header className="record-modal-header">
          <div className="record-modal-heading">
            <h2 className="record-modal-title">Recording Setup</h2>
            <p className="record-modal-subtitle">
              Choose your camera, microphone, and how you want your bubble to look.
            </p>
          </div>
          <button
            type="button"
            className="record-modal-close"
            onClick={handleCancel}
            aria-label="Close recording setup"
          >
            ✕
          </button>
        </header>

        <div className="record-modal-body">
          <div className="record-preview-column">
            <div className="record-preview-stage">
              {screenStream ? (
                <video
                  ref={previewVideoRef}
                  autoPlay
                  muted
                  playsInline
                  className="record-preview-screen"
                />
              ) : (
                <div className="record-preview-placeholder">
                  <span className="record-preview-placeholder-icon" aria-hidden>🖥</span>
                  <p>Your shared screen will appear here.</p>
                  <p className="record-preview-placeholder-hint">
                    Click “Share screen” to pick a screen, window, or tab.
                  </p>
                </div>
              )}

              {cameraStream && (
                <video
                  ref={cameraPreviewRef}
                  autoPlay
                  muted
                  playsInline
                  className="record-preview-bubble"
                  style={bubbleStyle}
                />
              )}

              {statusPill && (
                <span
                  className={
                    recordingState === 'recording'
                      ? 'record-status-pill is-recording'
                      : 'record-status-pill'
                  }
                >
                  {statusPill}
                </span>
              )}
            </div>

            <div className="record-position-block">
              <span className="record-field-label" id="initial-position-label">
                Initial position
              </span>
              <div
                className="record-position-grid"
                role="radiogroup"
                aria-labelledby="initial-position-label"
              >
                {POSITION_OPTIONS.map((option) => {
                  const isSelected = cameraPosition === option.value
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={isSelected}
                      className={isSelected ? 'record-position-card is-selected' : 'record-position-card'}
                      onClick={() => setCameraPosition(option.value)}
                    >
                      <span className="record-position-cell" aria-hidden>
                        <span
                          className="record-position-dot"
                          style={BUBBLE_POSITION_STYLE[option.value]}
                        />
                      </span>
                      <span className="record-position-label">
                        {isSelected ? '✓ ' : ''}{option.label}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="record-messages">
              <p className="record-hint">
                🎥 Start from the Video Composer tab (select it in Chrome's picker).
                During recording, Chrome's sharing controls let you switch the
                captured tab — the recording keeps running across switches.
              </p>
              {notice && <p className="message recorder-notice">{notice}</p>}
              {error && <p className="message error">{error}</p>}
            </div>
          </div>

          <div className="record-settings-column">
            <div className="record-settings-card">
              <div className="record-settings-head">
                <span className="record-settings-icon" aria-hidden>📹</span>
                <div className="record-settings-text">
                  <h3 className="record-settings-title">Camera</h3>
                  <p className="record-settings-desc">Add a bubble with your webcam.</p>
                </div>
                <label className="record-toggle">
                  <input
                    type="checkbox"
                    checked={cameraEnabled}
                    onChange={(event) => setCameraEnabled(event.target.checked)}
                    disabled={!devices.cameras.length}
                  />
                  <span className="record-toggle-track">
                    <span className="record-toggle-thumb" />
                  </span>
                </label>
              </div>

              <div className={cameraEnabled ? 'record-settings-controls' : 'record-settings-controls is-disabled'}>
                <span className="record-field-label">Camera device</span>
                <select
                  className="record-select"
                  value={cameraDeviceId}
                  onChange={(event) => {
                    console.debug('[Recorder] Camera device selected:', event.target.value || '(default)')
                    setCameraDeviceId(event.target.value)
                  }}
                  disabled={!cameraEnabled || !devices.cameras.length}
                >
                  <option value="">
                    {devices.cameras.length ? 'Select a camera' : 'No camera found'}
                  </option>
                  {devices.cameras.map((camera) => (
                    <option key={camera.deviceId} value={camera.deviceId}>
                      {camera.label}
                    </option>
                  ))}
                </select>

                <span className="record-field-label">Shape</span>
                <div className="record-shape-grid" role="radiogroup" aria-label="Webcam shape">
                  {SHAPE_OPTIONS.map((option) => {
                    const isSelected = cameraShape === option.value
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={isSelected}
                        className={isSelected ? 'record-shape-option is-selected' : 'record-shape-option'}
                        onClick={() => setCameraShape(option.value)}
                        disabled={!cameraEnabled}
                      >
                        <ShapeIcon shape={option.value} />
                        <span>{option.label}</span>
                      </button>
                    )
                  })}
                </div>

                <span className="record-field-label">Size</span>
                <div className="record-size-row">
                  <input
                    type="range"
                    min="0"
                    max={SIZE_ORDER.length - 1}
                    step="1"
                    value={sizeIndex}
                    onChange={(event) => setCameraSize(SIZE_ORDER[Number(event.target.value)])}
                    disabled={!cameraEnabled}
                    aria-label="Webcam size"
                  />
                  <output className="record-size-value">{sizePercent}%</output>
                </div>

                <div className="record-slider-group">
                  <div className="record-field-header">
                    <span className="record-field-label">Zoom</span>
                    <output className="record-size-value">{cameraZoom.toFixed(1)}x</output>
                  </div>
                  <input
                    type="range"
                    min="1"
                    max="2.5"
                    step="0.1"
                    value={cameraZoom}
                    onChange={(event) => setCameraZoom(Number(event.target.value))}
                    disabled={!cameraEnabled}
                    aria-label="Webcam zoom"
                  />
                </div>

                <div className="record-toggle-row">
                  <span className="record-toggle-label">Mirror horizontally</span>
                  <label className="record-toggle">
                    <input
                      type="checkbox"
                      checked={cameraMirror}
                      onChange={(event) => setCameraMirror(event.target.checked)}
                    />
                    <span className="record-toggle-track">
                      <span className="record-toggle-thumb" />
                    </span>
                  </label>
                </div>
              </div>
            </div>

            <div className="record-settings-card">
              <div className="record-settings-head">
                <span className="record-settings-icon" aria-hidden>🎙</span>
                <div className="record-settings-text">
                  <h3 className="record-settings-title">Microphone</h3>
                  <p className="record-settings-desc">Record your voice on the same track.</p>
                </div>
                <label className="record-toggle">
                  <input
                    type="checkbox"
                    checked={micEnabled}
                    onChange={(event) => setMicEnabled(event.target.checked)}
                    disabled={!devices.microphones.length}
                  />
                  <span className="record-toggle-track">
                    <span className="record-toggle-thumb" />
                  </span>
                </label>
              </div>

              <div className={micEnabled ? 'record-settings-controls' : 'record-settings-controls is-disabled'}>
                <span className="record-field-label">Microphone device</span>
                <select
                  className="record-select"
                  value={micDeviceId}
                  onChange={(event) => setMicDeviceId(event.target.value)}
                  disabled={!micEnabled || !devices.microphones.length}
                >
                  <option value="">
                    {devices.microphones.length ? 'Select a microphone' : 'No microphone found'}
                  </option>
                  {devices.microphones.map((mic) => (
                    <option key={mic.deviceId} value={mic.deviceId}>
                      {mic.label}
                    </option>
                  ))}
                </select>

                {micStream && (
                  <p className="record-status-success">
                    ✓ Microphone connected — recording will include your voice.
                  </p>
                )}
              </div>
            </div>

            <div className="record-settings-card">
              <div className="record-settings-head">
                <span className="record-settings-icon" aria-hidden>🔊</span>
                <div className="record-settings-text">
                  <h3 className="record-settings-title">System Audio</h3>
                  <p className="record-settings-desc">Capture audio from the shared tab or window.</p>
                </div>
                <label className="record-toggle">
                  <input
                    type="checkbox"
                    checked={systemAudioEnabled}
                    onChange={(event) => setSystemAudioEnabled(event.target.checked)}
                  />
                  <span className="record-toggle-track">
                    <span className="record-toggle-thumb" />
                  </span>
                </label>
              </div>
            </div>
          </div>
        </div>

        <footer className="record-modal-footer">
          <button
            type="button"
            className="record-button-secondary"
            onClick={handleCancel}
            disabled={
              recordingState === 'stopping' ||
              recordingState === 'processing' ||
              recordingState === 'completed'
            }
          >
            Cancel
          </button>

          <button
            type="button"
            className={primaryAction.tone === 'danger' ? 'record-button-primary is-danger' : 'record-button-primary'}
            onClick={primaryAction.action ?? undefined}
            disabled={primaryAction.disabled}
          >
            {primaryAction.label}
          </button>
        </footer>
      </div>
    </div>
  )
}

export default RecordModal