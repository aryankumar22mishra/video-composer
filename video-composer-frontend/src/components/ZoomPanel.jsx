// ZoomPanel — "Zoom Fragment" editor shown in the left panel while the Zoom
// section is active in the sidebar rail (between Background and Record).
//
// Layout mirrors the reference design:
//   header       → back arrow, "Zoom Fragment" title, red Delete action
//   focus point  → selected clip preview with a draggable focus handle (A)
//   effect cards → Camera Movement / 3D Effect toggles
//   slider rows  → Zoom level / Transition speed (filled-track sliders)
//   summary rows → fragment duration, zoom factor, transition duration
//
// Pure presentation: all state lives in App (zoomFragment) and flows in
// through props, so settings survive closing and reopening the panel.
// The fragment summary derives from the timeline-selected clip; with no
// selection the panel still works but shows a hint and zeroed duration.

import { useRef } from 'react'

const ZOOM_LEVEL_MIN = 1
const ZOOM_LEVEL_MAX = 3
const ZOOM_LEVEL_STEP = 0.1
const TRANSITION_SPEED_MIN = 1
const TRANSITION_SPEED_MAX = 10
const TRANSITION_SPEED_STEP = 0.5

// Transition length derived from speed: a 2s fragment at speed 5 → 1.2s.
const TRANSITION_SPEED_DIVISOR = 3

const clampFocus = (value) => Math.min(0.96, Math.max(0.04, value))

const sliderPercent = (value, min, max) =>
  `${Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100))}%`

const formatClock = (seconds) => {
  const safe = Math.max(0, Math.floor(seconds || 0))
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`
}

function Icon({ children }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

const TrashIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 7h16" />
    <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    <path d="M6.5 7l1 12a1.5 1.5 0 0 0 1.5 1.4h6a1.5 1.5 0 0 0 1.5-1.4l1-12" />
    <path d="M10 11v6M14 11v6" />
  </svg>
)

const FocusIcon = () => (
  <Icon>
    <path d="M4 9V6a2 2 0 0 1 2-2h3" />
    <path d="M15 4h3a2 2 0 0 1 2 2v3" />
    <path d="M20 15v3a2 2 0 0 1-2 2h-3" />
    <path d="M9 20H6a2 2 0 0 1-2-2v-3" />
    <circle cx="12" cy="12" r="2.4" />
  </Icon>
)

const CameraMoveIcon = () => (
  <Icon>
    <path d="M5 19 19 5" />
    <path d="M9 5h10v10" />
    <path d="M5 19h4" />
    <path d="M5 19v-4" />
  </Icon>
)

const CubeIcon = () => (
  <Icon>
    <path d="M12 3l7.5 4.3v9.4L12 21l-7.5-4.3V7.3z" />
    <path d="M12 12l7.5-4.7" />
    <path d="M12 12 4.5 7.3" />
    <path d="M12 12v9" />
  </Icon>
)

const ZoomLevelIcon = () => (
  <Icon>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M15.8 15.8 20 20" />
    <path d="M8.5 11h5" />
    <path d="M11 8.5v5" />
  </Icon>
)

const SpeedIcon = () => (
  <Icon>
    <path d="M20 12a8 8 0 1 1-2.4-5.7" />
    <path d="M20 4v4h-4" />
  </Icon>
)

function ZoomToggle({ checked, onChange, label }) {
  return (
    <label className="zoom-toggle" title={label}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        aria-label={label}
      />
      <span className="zoom-toggle-track" aria-hidden="true">
        <span className="zoom-toggle-knob" />
      </span>
    </label>
  )
}

function ZoomSliderRow({ icon, label, value, min, max, step, onChange, format }) {
  return (
    <div className="zoom-slider-row" style={{ '--zoom-fill': sliderPercent(value, min, max) }}>
      <span className="zoom-slider-icon" aria-hidden="true">{icon}</span>
      <span className="zoom-slider-label">{label}</span>
      <span className="zoom-slider-value">{format(value)}</span>
      <input
        className="zoom-slider-input"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label={label}
      />
    </div>
  )
}

function ZoomPanel({ fragment, onChange, onBack, onDelete, selectedClip, previewUrl }) {
  const stageRef = useRef(null)
  const draggingRef = useRef(false)

  const applyFocusFromPointer = (event) => {
    const stage = stageRef.current
    if (!stage) return
    const rect = stage.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    const x = (event.clientX - rect.left) / rect.width
    const y = (event.clientY - rect.top) / rect.height
    onChange((prev) => ({ ...prev, focus: { x: clampFocus(x), y: clampFocus(y) } }))
  }

  const handleStagePointerDown = (event) => {
    const stage = stageRef.current
    if (!stage || draggingRef.current) return
    event.preventDefault()
    draggingRef.current = true
    try { stage.setPointerCapture(event.pointerId) } catch { /* older browsers */ }
    applyFocusFromPointer(event)

    const handleMove = (moveEvent) => {
      if (!draggingRef.current) return
      applyFocusFromPointer(moveEvent)
    }
    const handleUp = (upEvent) => {
      draggingRef.current = false
      try { stage.releasePointerCapture(upEvent.pointerId) } catch { /* noop */ }
      stage.removeEventListener('pointermove', handleMove)
      stage.removeEventListener('pointerup', handleUp)
      stage.removeEventListener('pointercancel', handleUp)
    }
    stage.addEventListener('pointermove', handleMove)
    stage.addEventListener('pointerup', handleUp)
    stage.addEventListener('pointercancel', handleUp)
  }

  const fragmentStart = selectedClip ? selectedClip.startTime : 0
  const fragmentEnd = selectedClip ? selectedClip.startTime + selectedClip.duration : 0
  const fragmentSeconds = Math.max(0, fragmentEnd - fragmentStart)
  const transitionDuration = fragmentSeconds > 0
    ? Math.min(fragmentSeconds, Math.max(0.2, (fragmentSeconds * TRANSITION_SPEED_DIVISOR) / fragment.transitionSpeed))
    : 0

  return (
    <div className="zoom-panel" aria-label="Zoom Fragment">
      <div className="zoom-header">
        <button type="button" className="zoom-back" onClick={onBack} aria-label="Back to media">&#8592;</button>
        <h2 className="zoom-title">Zoom Fragment</h2>
        <button type="button" className="zoom-delete" onClick={onDelete} aria-label="Delete zoom fragment">
          <TrashIcon />
          Delete
        </button>
      </div>

      <div className="zoom-body">
        <p className="zoom-section-label">
          <FocusIcon />
          Focus point
        </p>

        <div
          className="zoom-stage"
          ref={stageRef}
          onPointerDown={handleStagePointerDown}
          role="application"
          aria-label="Drag to set the zoom focus point"
        >
          {previewUrl ? (
            <img src={previewUrl} alt={selectedClip ? selectedClip.fileName : 'Clip preview'} draggable={false} />
          ) : (
            <div className="zoom-stage-placeholder" aria-hidden="true">&#127916;</div>
          )}
          <span
            className="zoom-focus-handle"
            style={{ left: `${fragment.focus.x * 100}%`, top: `${fragment.focus.y * 100}%` }}
            aria-hidden="true"
          >
            A
          </span>
        </div>

        {selectedClip ? (
          <p className="zoom-hint">{selectedClip.fileName}</p>
        ) : (
          <p className="zoom-hint">Select a clip on the timeline to attach this zoom fragment to it.</p>
        )}

        <div className="zoom-card">
          <span className="zoom-card-icon" aria-hidden="true"><CameraMoveIcon /></span>
          <span className="zoom-card-text">
            <b>Camera Movement</b>
            <small>Panning during zoom</small>
          </span>
          <ZoomToggle
            checked={fragment.cameraMovement}
            onChange={(next) => onChange((prev) => ({ ...prev, cameraMovement: next }))}
            label="Camera movement"
          />
        </div>

        <div className="zoom-card">
          <span className="zoom-card-icon" aria-hidden="true"><CubeIcon /></span>
          <span className="zoom-card-text">
            <b>3D Effect</b>
            <small>Perspective with depth</small>
          </span>
          <ZoomToggle
            checked={fragment.threeDEffect}
            onChange={(next) => onChange((prev) => ({ ...prev, threeDEffect: next }))}
            label="3D effect"
          />
        </div>

        <ZoomSliderRow
          icon={<ZoomLevelIcon />}
          label="Zoom level"
          value={fragment.zoomLevel}
          min={ZOOM_LEVEL_MIN}
          max={ZOOM_LEVEL_MAX}
          step={ZOOM_LEVEL_STEP}
          format={(value) => value.toFixed(1)}
          onChange={(next) => onChange((prev) => ({ ...prev, zoomLevel: next }))}
        />

        <ZoomSliderRow
          icon={<SpeedIcon />}
          label="Transition speed"
          value={fragment.transitionSpeed}
          min={TRANSITION_SPEED_MIN}
          max={TRANSITION_SPEED_MAX}
          step={TRANSITION_SPEED_STEP}
          format={(value) => value.toFixed(1)}
          onChange={(next) => onChange((prev) => ({ ...prev, transitionSpeed: next }))}
        />

        <div className="zoom-summary">
          <span className="zoom-summary-label">Fragment duration</span>
          <span className="zoom-summary-value">{formatClock(fragmentStart)} - {formatClock(fragmentEnd)}</span>
        </div>
        <div className="zoom-summary">
          <span className="zoom-summary-label">Zoom factor</span>
          <span className="zoom-summary-value">{fragment.zoomLevel.toFixed(1)}&#215;</span>
        </div>
        <div className="zoom-summary">
          <span className="zoom-summary-label">Transition duration</span>
          <span className="zoom-summary-value">{transitionDuration.toFixed(1)}s</span>
        </div>
      </div>
    </div>
  )
}

export default ZoomPanel

