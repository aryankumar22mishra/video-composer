// Single shared render path for the live preview and the client-side
// exporter. Both call drawCompositionFrame so the exported video can never
// diverge from what the user sees on the canvas. Handles video clips, image
// clips, and text overlays in one pass.

const DEFAULT_TRANSFORM = { x: 0.5, y: 0.5, scale: 1, opacity: 1, rotation: 0 }

export function findActiveClip(composition, time) {
  const videoTrack = composition.tracks[0]
  return videoTrack.clips.find(
    (clip) => time >= clip.startTime && time < clip.startTime + clip.duration
  )
}

// Find the text overlays that are visible at the given timeline time.
export function findActiveTexts(composition, time) {
  return (composition.texts || []).filter(
    (text) => time >= text.startTime && time < text.startTime + text.duration
  )
}

// Draw a single media frame (video or image) onto the canvas with the
// given transform. Letterbox-fits the media into the canvas (preserving
// aspect ratio) and applies scale / position / opacity / rotation.
export function drawFrame(ctx, canvas, image, transform = DEFAULT_TRANSFORM, grayscale = false) {
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  if (!image) return

  const t = { ...DEFAULT_TRANSFORM, ...transform }

  // Base "fit to canvas" size (letterbox, preserving aspect ratio) + scale
  const canvasRatio = canvas.width / canvas.height
  const mediaWidth = image.videoWidth || image.width
  const mediaHeight = image.videoHeight || image.height
  const imageRatio = mediaWidth / mediaHeight

  let baseWidth, baseHeight
  if (imageRatio > canvasRatio) {
    baseWidth = canvas.width
    baseHeight = canvas.width / imageRatio
  } else {
    baseHeight = canvas.height
    baseWidth = canvas.height * imageRatio
  }

  const drawWidth = baseWidth * t.scale
  const drawHeight = baseHeight * t.scale

  const centerX = canvas.width * t.x
  const centerY = canvas.height * t.y

  ctx.save()
  if (grayscale) ctx.filter = 'grayscale(1)'
  ctx.globalAlpha = t.opacity
  ctx.translate(centerX, centerY)
  ctx.rotate((t.rotation * Math.PI) / 180)
  ctx.drawImage(image, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight)
  ctx.restore()
}

// Draw the visible text overlays on top of the (already-rendered) media.
// Uses a stroke outline + fill for legibility over any background.
function drawTexts(ctx, canvas, composition, time) {
  const texts = findActiveTexts(composition, time)
  if (!texts.length) return

  ctx.save()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  for (const text of texts) {
    const x = canvas.width * text.x
    const y = canvas.height * text.y
    const fontString = `${text.weight} ${text.size}px ${text.font}`

    ctx.globalAlpha = text.opacity
    ctx.font = fontString

    // Legibility outline
    ctx.lineWidth = text.strokeWidth
    ctx.strokeStyle = text.strokeColor
    ctx.lineJoin = 'round'
    ctx.strokeText(text.content, x, y)

    // Fill
    ctx.fillStyle = text.color
    ctx.fillText(text.content, x, y)
  }

  ctx.restore()
}

// Master render function: paints the active media clip AND all visible text
// overlays for the given timeline time. This is THE shared path — the live
// preview effect in App.jsx and every exporter (WebM/MP4) call this.
//
//   ctx, canvas        — target 2D context
//   composition        — the composition JSON (state/composition.js)
//   time               — timeline time in seconds
//   mediaSources       — { images: {fileIndex: HTMLImageElement},
//                          videos: {fileIndex: HTMLVideoElement} }
export function drawCompositionFrame(ctx, canvas, composition, time, mediaSources = {}) {
  const activeClip = findActiveClip(composition, time)

  if (activeClip) {
    const media = mediaSources[activeClip.fileType?.startsWith('image/') ? 'images' : 'videos']
    const source = media?.[activeClip.fileIndex]

    if (activeClip.fileType?.startsWith('image/')) {
      // Image clip — static, drawn directly.
      drawFrame(ctx, canvas, source, activeClip.transform, activeClip.grayscale)
    } else if (source) {
      // Video clip — draw its current frame. During live playback the source
      // element is already advancing; during export it's seeked frame-by-frame.
      if (source.readyState >= 2) {
        drawFrame(ctx, canvas, source, activeClip.transform, activeClip.grayscale)
      }
    } else {
      drawFrame(ctx, canvas, null, activeClip.transform, activeClip.grayscale)
    }
  } else {
    // No active clip — black frame.
    drawFrame(ctx, canvas, null)
  }

  // Overlay text on top of the media.
  drawTexts(ctx, canvas, composition, time)
}

export function seekAndDrawVideo(video, ctx, canvas, timeWithinClip, transform) {
  const needsSeek = Math.abs(video.currentTime - timeWithinClip) > 0.05

  const draw = () => drawFrame(ctx, canvas, video, transform)

  // Paint whatever frame is already decoded so the preview is never blank
  // while a seek is pending (e.g. during the WebM duration probe right
  // after a recording is added).
  if (video.readyState >= 2) {
    draw()
  }

  if (!needsSeek) return

  const onSeeked = () => {
    video.removeEventListener('seeked', onSeeked)
    draw()
  }
  video.addEventListener('seeked', onSeeked)
  video.currentTime = timeWithinClip
}

export function sourceTimeForClip(clip, timelineTime) {
  const speed = clip.speed || 1
  const sourceStart = Number(clip.sourceStart ?? clip.sourceOffset ?? 0)
  return Math.max(0, sourceStart + (timelineTime - clip.startTime) * speed)
}