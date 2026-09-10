// Shared output-dimension constants and helpers for the Dimension Panel.
// Kept in a plain module (no React component) so the panel file can stay a
// fast-refresh-friendly single-component export while App.jsx reuses the same
// presets and the even-number rounding for the job payload + preview sizing.

export const ASPECT_PRESETS = [
  { id: 'auto', label: 'Auto', aspect: 'auto', badge: 'Native', frame: 'auto', description: 'Keep the source aspect ratio', width: null, height: null },
  { id: 'wide', label: 'Wide', aspect: '16:9', badge: '16:9', frame: 'wide', description: 'YouTube and streaming sites', width: 1920, height: 1080 },
  { id: 'vertical', label: 'Vertical', aspect: '9:16', badge: '9:16', frame: 'tall', description: 'Instagram Reels and TikTok', width: 1080, height: 1920 },
  { id: 'square', label: 'Square', aspect: '1:1', badge: '1:1', frame: 'square', description: 'Instagram posts', width: 1080, height: 1080 },
  { id: 'classic', label: 'Classic', aspect: '4:3', badge: '4:3', frame: 'wide', description: 'Traditional video', width: 1440, height: 1080 },
  { id: 'social', label: 'Social', aspect: 'custom', badge: '4:5', frame: 'tallish', description: 'Instagram feed', width: 1080, height: 1350 },
  { id: 'cinema', label: 'Cinema', aspect: 'custom', badge: '21:9', frame: 'ultrawide', description: 'Cinematic and wide video', width: 2560, height: 1080 },
  { id: 'portrait', label: 'Portrait', aspect: 'custom', badge: '2:3', frame: 'tall', description: 'Portrait photography and content', width: 1080, height: 1620 },
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