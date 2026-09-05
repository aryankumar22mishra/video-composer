export function createComposition() {
  return {
    width: 1280,
    height: 720,
    fps: 30,
    duration: 0,
    tracks: [
      { type: 'video', clips: [] },
      { type: 'audio', clips: [] },
    ],
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