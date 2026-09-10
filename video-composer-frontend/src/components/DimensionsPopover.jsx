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
  // Anchored above the button, but clamped to the viewport: the panel is
  // taller than the space above the trigger when near the top of the page,
  // so the final top is measured from the rendered panel's real height.
  const [placement, setPlacement] = useState(null)
  useEffect(() => {
    const place = () => {
      const anchor = anchorRef.current
      if (!anchor) return
      const rect = anchor.getBoundingClientRect()
      const GAP = 8
      const panelHeight = popoverRef.current?.offsetHeight ?? 0
      const maxListTop = 8
      const preferredTop = rect.top - panelHeight - GAP
      const top = Math.max(maxListTop, Math.min(preferredTop, window.innerHeight - panelHeight - 8))
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - 320 - 8))
      setPlacement({ top, left, measuredHeight: 0 })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [anchorRef])

  // Re-measure once after the panel paints: the first pass runs before the
  // portal exists (height 0), so the clamped top would be wrong. Only update
  // when the measured height actually changed — prevents a re-render loop.
  useEffect(() => {
    const anchor = anchorRef.current
    const panel = popoverRef.current
    if (!anchor || !panel || !placement) return
    const rect = anchor.getBoundingClientRect()
    const GAP = 8
    const panelHeight = panel.offsetHeight
    if (panelHeight === placement.measuredHeight) return
    const preferredTop = rect.top - panelHeight - GAP
    const top = Math.max(8, Math.min(preferredTop, window.innerHeight - panelHeight - 8))
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - 320 - 8))
    setPlacement({ top, left, measuredHeight: panelHeight })
  }, [placement, anchorRef])

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
      style={{ top: placement.top, left: placement.left }}
    >
      <span className="dimensions-popover-title">Dimensions</span>

      <div className="dimensions-list" role="listbox" aria-label="Aspect ratio presets">
        {ASPECT_PRESETS.map((preset) => {
          // A preset is active when the applied aspect matches AND, for the
          // presets that share the backend value 'custom' (Social 4:5 /
          // Cinema 21:9 / Portrait 2:3), the resolution matches too.
          const presetAspect = preset.aspect ?? preset.id
          const isActive = value === presetAspect
            && (preset.width == null || (width === preset.width && height === preset.height))
          return (
            <button
              key={preset.id}
              type="button"
              role="option"
              aria-selected={isActive}
              className={`dimensions-row${isActive ? ' selected' : ''}`}
              onClick={() => handlePresetClick(preset)}
            >
              <span className="dimensions-check" aria-hidden="true">
                {isActive ? '✓' : ''}
              </span>
              <span className="dimensions-glyph" aria-hidden="true">
                <span className={`aspect-frame aspect-frame--${preset.frame ?? 'auto'}`} />
              </span>
              <span className="dimensions-row-text">
                <b>
                  {preset.label} <small>{preset.badge}</small>
                </b>
                <small className="dimensions-row-desc">{preset.description}</small>
              </span>
            </button>
          )
        })}
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
