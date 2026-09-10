// Single source of truth for the composition canvas. Every consumer
// (live preview, dimension picker, export payload) derives its sizes
// from composition.width / composition.height — never from separate
// per-feature state.
export const COMPOSITION_DEFAULTS = {
  width: 1280,
  height: 720,
  fps: 30,
};

export function createComposition() {
  return {
    width: COMPOSITION_DEFAULTS.width,
    height: COMPOSITION_DEFAULTS.height,
    fps: COMPOSITION_DEFAULTS.fps,
    duration: 0,
    tracks: [
      { type: 'video', clips: [] },
      { type: 'audio', clips: [] },
    ],
    // Text overlays rendered on top of the video track. Both the live preview
    // and the client-side exporter draw these via drawCompositionFrame so the
    // output can never diverge from what the user sees.
    texts: [],
  };
}

export function createCompositionText(partial = {}) {
  return {
    id: partial.id ?? `text-${Date.now()}-${Math.random()}`,
    content: partial.content ?? 'Your text here',
    x: partial.x ?? 0.5,            // 0..1 of canvas width (anchor center)
    y: partial.y ?? 0.5,            // 0..1 of canvas height (anchor center)
    startTime: partial.startTime ?? 0,
    duration: partial.duration ?? 3,
    size: partial.size ?? 48,        // px font size at the composition resolution
    color: partial.color ?? '#ffffff',
    font: partial.font ?? 'sans-serif',
    align: partial.align ?? 'center',
    weight: partial.weight ?? 700,
    opacity: partial.opacity ?? 1,
    strokeColor: partial.strokeColor ?? '#000000',
    strokeWidth: partial.strokeWidth ?? 2,
  };
}

export function createCompositionClip(
  file,
  index,
  startTime,
  duration
) {
  return {
    id: `${index}-${Date.now()}-${Math.random()}`,

    fileIndex: index,
    fileName: file.name,
    fileType: file.type,

    startTime,
    duration,

    speed: 1,

    transform: {
      x: 0.5,
      y: 0.5,
      scale: 1,
      opacity: 1,
      rotation: 0,
    },
  };
}