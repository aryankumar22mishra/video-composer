// DimensionsPopover — OpenVid-style output-dimension picker.
//
// Rendered by App.jsx next to the composer toolbar's dimension trigger
// button. Shows the six aspect-ratio presets (Auto / YouTube / TikTok /
// Instagram / Standard / Portrait) plus a custom W x H form, and reports
// selections back through props:
//
//   onSelect(preset)              -> a preset card was clicked
//   onApplyCustom(width, height)  -> "Apply dimensions" with validated ints
//   onClose()                     -> Escape pressed or clicked outside
//
// This component is pure UI: it owns only its draft-input state. The
// App applies chosen values to composition.width/height (the single
// source of truth that drives preview AND export).

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ASPECT_PRESETS,
  MAX_DIMENSION,
  toEvenDimension,
} from '../dimensions/DimensionPresets'

// Returns an error string or null. Values must be whole numbers within
// [2, MAX_DIMENSION]; even rounding happens on apply (H.264 requirement).
const validateDimension = (label, value) => {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    return `${label} must be a whole number.`
  }
  if (value < 2) {
    return `${label} must be at least 2 pixels.`
  }
  if (value > MAX_DIMENSION) {
    return `${label} must be at most ${MAX_DIMENSION} pixels.`
  }
  return null
}

function DimensionsPopover({
  value,
  width,
  height,
  anchorRef,
  onSelect,
  onApplyCustom,
  onClose,
}) {
  const popoverRef = useRef(null)
  const [draftWidth, setDraftWidth] = useState(String(width ?? ''))
  const [draftHeight, setDraftHeight] = useState(String(height ?? ''))
  const [validationMessage, setValidationMessage] = useState('')

  // Fixed position computed from the trigger button's box. The panel is
  // rendered through a portal into <body>, so ancestor `overflow: hidden`
  // cards (result-card, timeline-section) can never clip it out of view.
  // Anchored so the panel's top-left sits just above the button's top-left.
  const [placement, setPlacement] = useState(null)
  useEffect(() => {
    const place = () => {
      const anchor = anchorRef.current
      if (!anchor) return
      const rect = anchor.getBoundingClientRect()
      const PANEL_WIDTH = 420
      const GAP = 10
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - PANEL_WIDTH - 8))
      setPlacement({
        left,
        bottom: window.innerHeight - rect.top + GAP,
      })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [anchorRef])

  // Position is relative to the trigger, so scrolling under the open panel
  // would desync it — close on any scroll instead.
  useEffect(() => {
    window.addEventListener('scroll', onClose, true)
    return () => window.removeEventListener('scroll', onClose, true)
  }, [onClose])

  // Escape closes the popover.
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  // Pointer-down outside the popover (and outside the trigger button,
  // so clicking the trigger toggles instead of close+reopen) closes it.
  useEffect(() => {
    const handlePointerDown = (event) => {
      if (!popoverRef.current) return
      if (popoverRef.current.contains(event.target)) return
      if (anchorRef.current && anchorRef.current.contains(event.target)) return
      onClose()
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [anchorRef, onClose])

  const parsedWidth = Number(draftWidth)
  const parsedHeight = Number(draftHeight)
  const widthError = draftWidth === '' ? 'Width is required.' : validateDimension('Width', parsedWidth)
  const heightError = draftHeight === '' ? 'Height is required.' : validateDimension('Height', parsedHeight)
  const canApply = !widthError && !heightError

  const handleDraftChange = (nextWidth, nextHeight) => {
    setDraftWidth(nextWidth)
    setDraftHeight(nextHeight)
    const nextWidthError = nextWidth === '' ? 'Width is required.' : validateDimension('Width', Number(nextWidth))
    const nextHeightError = nextHeight === '' ? 'Height is required.' : validateDimension('Height', Number(nextHeight))
    setValidationMessage(nextWidthError || nextHeightError || '')
  }

  const handlePresetClick = (preset) => {
    setValidationMessage('')
    setDraftWidth(preset.width ? String(preset.width) : '')
    setDraftHeight(preset.height ? String(preset.height) : '')
    onSelect(preset)
  }

  const handleApply = () => {
    if (!canApply) {
      setValidationMessage(widthError || heightError)
      return
    }
    // Even-round at the boundary so H.264-compatible values reach the app.
    onApplyCustom(toEvenDimension(parsedWidth), toEvenDimension(parsedHeight))
    onClose()
  }

  // Wait for the first measured placement before painting (avoids a flash
  // in the top-left corner of the viewport on first render).
  if (!placement) return null

  return createPortal(
    <div
      className="dimensions-popover"
      ref={popoverRef}
      role="dialog"
      aria-label="Dimensions"
      style={{ left: placement.left, bottom: placement.bottom }}
    >
      <span className="dimensions-popover-title">Dimensions</span>

      <div className="dimensions-grid" role="group" aria-label="Aspect ratio presets">
        {ASPECT_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className={value === preset.id ? 'dimensions-card selected' : 'dimensions-card'}
            onClick={() => handlePresetClick(preset)}
            aria-pressed={value === preset.id}
          >
            <b>{preset.label}</b>
            <small>{preset.badge}</small>
          </button>
        ))}
      </div>


      <div className="dimensions-custom">
        <label className="dimension-field">
          <span>W</span>
          <input
            type="number"
            min="2"
            step="2"
            inputMode="numeric"
            placeholder="1920"
            value={draftWidth}
            onChange={(event) => handleDraftChange(event.target.value, draftHeight)}
          />
        </label>

        <span className="dimension-x" aria-hidden="true">&#215;</span>

        <label className="dimension-field">
          <span>H</span>
          <input
            type="number"
            min="2"
            step="2"
            inputMode="numeric"
            placeholder="1080"
            value={draftHeight}
            onChange={(event) => handleDraftChange(draftWidth, event.target.value)}
          />
        </label>

        <button
          type="button"
          className="dimension-apply-button"
          disabled={!canApply}
          onClick={handleApply}
        >
          Apply dimensions
        </button>
      </div>

      {validationMessage && <p className="dimensions-error">{validationMessage}</p>}

      {value === 'custom' && !validationMessage && (
        <p className="dimension-note">
          Custom &mdash; clips are scaled and padded to {width}&times;{height}
        </p>
      )}
      {value === 'auto' && !validationMessage && (
        <p className="dimension-note">
          Auto &mdash; keeps the current {width}&times;{height} composition size
        </p>
      )}
    </div>,
    document.body,
  )
}

export default DimensionsPopover
