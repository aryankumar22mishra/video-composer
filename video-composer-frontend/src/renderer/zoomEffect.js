// Zoom fragment envelope — single source of truth for how the Zoom Fragment
// editor's settings become a per-frame transform. Imported only by the
// shared renderer (CompositionRenderer.js), so the live preview and every
// exporter (WebM / MP4) stay pixel-identical by construction.
//
// Timing model mirrors the panel's "Fragment duration" / "Transition speed":
// the zoom eases IN over half the transition at the fragment start, holds at
// the peak zoom level through the middle, then returns OUT over the second
// half — both transitions rotating/panning around the chosen focus point.

const ZOOM_SPEED_DIVISOR = 3
const MAX_3D_ROTATION_DEG = 3

export const ZOOM_LEVEL_MIN = 1
export const ZOOM_LEVEL_MAX = 3

const clamp01 = (value) => Math.min(1, Math.max(0, value))
const easeInOut = (value) => value * value * (3 - 2 * value)
const lerp = (a, b, t) => a + (b - a) * t

// Transition length (in + out combined) for a fragment, derived from the
// panel's transition speed: duration * 3 / speed, clamped to at least 0.2s
// and at most the fragment duration itself.
export function transitionDurationFor(fragment, clipDuration) {
  const duration = Number(clipDuration) || 0
  if (duration <= 0) return 0
  const speed = Math.max(0.1, Number(fragment?.transitionSpeed) || 5)
  const raw = (duration * ZOOM_SPEED_DIVISOR) / speed
  return Math.max(0.2, Math.min(raw, duration))
}

// Per-frame zoom parameters for a timeline time inside a bound clip, or null
// when the fragment does not apply at that time / has no zoom / is not bound.
//
// Returns:
//   scale     — multiplier on top of the clip's own transform scale
//   focusX/Y  — the effective view-center fractions (0..1) the zoom pivots on
//   rotation  — extra degrees applied for the 3D effect (pivots on the focus)
export function zoomEffectsForTime(fragment, clipStart, clipDuration, timelineTime) {
  if (!fragment) return null
  const zoomLevel = Number(fragment.zoomLevel)
  if (!Number.isFinite(zoomLevel) || zoomLevel <= 1) return null

  const legacyStart = Number(clipStart) || 0
  const legacyDuration = Math.max(0.001, Number(clipDuration) || 0)
  const start = Number.isFinite(Number(fragment.startTime)) ? Number(fragment.startTime) : legacyStart
  const end = Number.isFinite(Number(fragment.endTime)) ? Number(fragment.endTime) : start + legacyDuration
  const duration = Math.max(0.001, end - start)
  if (timelineTime < start || timelineTime > end) return null

  const progress01 = clamp01((timelineTime - start) / duration)
  const half = clamp01(transitionDurationFor(fragment, duration) / duration)

  const progress = progress01 < half
    ? easeInOut(clamp01(progress01 / half))
    : progress01 > 1 - half
      ? easeInOut(clamp01((1 - progress01) / half))
      : 1

  const scale = 1 + (Math.min(ZOOM_LEVEL_MAX, Math.max(ZOOM_LEVEL_MIN, zoomLevel)) - 1) * progress
  if (scale <= 1.001) return null

  const fx = Number(fragment.focus?.x ?? 0.5)
  const fy = Number(fragment.focus?.y ?? 0.5)

  // Camera Movement ON: the view glides from the frame center to the focus
  // point while zooming in (and back while zooming out). OFF: the view stays
  // pinned on the focus point — a pure magnification around it.
  const pan = fragment.cameraMovement ? progress : 1

  return {
    scale,
    focusX: lerp(0.5, fx, pan),
    focusY: lerp(0.5, fy, pan),
    rotation: fragment.threeDEffect ? (fx - 0.5) * MAX_3D_ROTATION_DEG * progress : 0,
  }
}