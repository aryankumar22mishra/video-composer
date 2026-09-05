// Given the composition JSON and a point in time, figure out which
// clip is active and draw it onto a canvas. This is the same lookup
// logic that preview playback and (later) export will both share.

export function findActiveClip(composition, time) {
  const videoTrack = composition.tracks[0]
  return videoTrack.clips.find(
    (clip) => time >= clip.startTime && time < clip.startTime + clip.duration
  )
}

const DEFAULT_TRANSFORM = { x: 0.5, y: 0.5, scale: 1, opacity: 1, rotation: 0 }

export function drawFrame(ctx, canvas, image, transform = DEFAULT_TRANSFORM) {
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  if (!image) return

  const t = { ...DEFAULT_TRANSFORM, ...transform }

  // Base "fit to canvas" size (same letterbox logic as before), then apply scale
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
  ctx.globalAlpha = t.opacity
  ctx.translate(centerX, centerY)
  ctx.rotate((t.rotation * Math.PI) / 180)
  ctx.drawImage(image, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight)
  ctx.restore()
}

export function seekAndDrawVideo(video, ctx, canvas, timeWithinClip, transform) {
  const needsSeek = Math.abs(video.currentTime - timeWithinClip) > 0.05

  const draw = () => drawFrame(ctx, canvas, video, transform)

  if (!needsSeek && video.readyState >= 2) {
    draw()
    return
  }

  const onSeeked = () => {
    video.removeEventListener('seeked', onSeeked)
    draw()
  }
  video.addEventListener('seeked', onSeeked)
  video.currentTime = timeWithinClip
}