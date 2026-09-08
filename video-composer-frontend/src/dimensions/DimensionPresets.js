// Shared output-dimension constants and helpers for the Dimension Panel.
//
// Kept in a plain module (no React component) so the panel file can stay a
// fast-refresh-friendly single-component export while App.jsx reuses the same
// presets and the even-number rounding for the job payload + preview sizing.

export const ASPECT_PRESETS = [
  { id: 'auto', label: 'Auto', badge: 'Native', width: null, height: null },
  { id: '16:9', label: 'YouTube', badge: '16:9', width: 1920, height: 1080 },
  { id: '9:16', label: 'TikTok', badge: '9:16', width: 1080, height: 1920 },
  { id: '1:1', label: 'Instagram', badge: '1:1', width: 1080, height: 1080 },
  { id: '4:3', label: 'Standard', badge: '4:3', width: 1440, height: 1080 },
  { id: '3:4', label: 'Portrait', badge: '3:4', width: 1080, height: 1440 },
]

export const ASPECT_PRESET_BY_ID = Object.fromEntries(
  ASPECT_PRESETS.map((preset) => [preset.id, preset])
)

export const isEvenNumber = (value) => Number.isFinite(value) && value % 2 === 0

// Upper bound for custom dimensions. Prevents accidentally creating an
// enormous browser canvas (preview buffers are capped separately) while
// still allowing 8K-class exports.
export const MAX_DIMENSION = 7680

// Force an integer to be even (H.264 requires even width/height), clamped
// to a sane minimum of 2 pixels.
export const toEvenDimension = (value) => {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 2) return null
  const even = Math.round(number / 2) * 2
  return Math.max(2, even)
}