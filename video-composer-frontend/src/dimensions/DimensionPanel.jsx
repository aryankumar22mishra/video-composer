// Dimension / Aspect Ratio Selection Panel
//
// Lets the user pick an output aspect-ratio preset (Auto, YouTube, TikTok,
// Instagram, Standard, Portrait) or enter a custom W x H resolution. Every
// change is reported back to the App, which forwards it to the Django job
// payload and resizes the live preview bounding box.
//
// Aspect presets (id, label, output width/height):
//   - auto       native source aspect ratio (no target box)
//   - 16:9       YouTube      1920x1080
//   - 9:16       TikTok       1080x1920
//   - 1:1        Instagram    1080x1080
//   - 4:3        Standard     1440x1080
//   - 3:4        Portrait     1080x1440
import { useState } from 'react'
import {
  ASPECT_PRESETS,
  ASPECT_PRESET_BY_ID,
  toEvenDimension,
} from './DimensionPresets'

// Draft inputs live here so typing feels native; every valid value still
// streams to the App so the payload + preview update live.
function DimensionPanel({
  value,
  width,
  height,
  onSelect,
  onCustomChange,
  onApplyCustom,
}) {
  const [draftWidth, setDraftWidth] = useState(width ? String(width) : '')
  const [draftHeight, setDraftHeight] = useState(height ? String(height) : '')

  const handleDraftChange = (nextWidth, nextHeight) => {
    setDraftWidth(nextWidth)
    setDraftHeight(nextHeight)

    const parsedWidth = Number(nextWidth)
    const parsedHeight = Number(nextHeight)
    const validWidth = Number.isFinite(parsedWidth) && parsedWidth >= 2
    const validHeight = Number.isFinite(parsedHeight) && parsedHeight >= 2

    if (validWidth && validHeight) {
      const evenWidth = toEvenDimension(parsedWidth)
      const evenHeight = toEvenDimension(parsedHeight)
      if (evenWidth && evenHeight) {
        onCustomChange(evenWidth, evenHeight)
      }
    }
  }

  const handlePresetSelect = (preset) => {
    // Sync the draft inputs so the custom fields stay coherent with the
    // highlighted preset.
    setDraftWidth(preset.width ? String(preset.width) : '')
    setDraftHeight(preset.height ? String(preset.height) : '')
    onSelect(preset.id, preset.width, preset.height)
  }

  const isCustomActive = value === 'custom'

  return (
    <div className="dimension-panel">
      <span className="dimension-panel-title">Output dimensions</span>

      <div className="dimension-presets" role="group" aria-label="Aspect ratio presets">
        {ASPECT_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className={`dimension-preset${value === preset.id ? ' selected' : ''}`}
            onClick={() => handlePresetSelect(preset)}
            aria-pressed={value === preset.id}
          >
            <b>{preset.label}</b>
            <small>{preset.badge}</small>
          </button>
        ))}
      </div>

      <div className="dimension-custom">
        <label className="dimension-field">
          <span>Width (W)</span>
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

        <span className="dimension-x">×</span>

        <label className="dimension-field">
          <span>Height (H)</span>
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
          className={`dimension-apply-button${isCustomActive ? ' selected' : ''}`}
          disabled={!draftWidth || !draftHeight}
          onClick={onApplyCustom}
        >
          Apply dimensions
        </button>
      </div>

      {isCustomActive ? (
        <p className="dimension-note">Custom — videos are scaled and padded to {width}×{height}</p>
      ) : value === 'auto' ? (
        <p className="dimension-note">Auto — uses each source&apos;s native aspect ratio</p>
      ) : (
        <p className="dimension-note">
          {ASPECT_PRESET_BY_ID[value]?.label} ({ASPECT_PRESET_BY_ID[value]?.badge}) — {width}×{height}
        </p>
      )}
    </div>
  )
}

export default DimensionPanel