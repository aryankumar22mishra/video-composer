// Given the composition JSON and a point in time, figure out which
// clip is active and draw it onto a canvas. This is the same lookup
// logic that preview playback and (later) export will both share.

export function findActiveClip(composition, time) {
  const videoTrack = composition.tracks[0]
  return videoTrack.clips.find(
    (clip) => time >= clip.startTime && time < clip.startTime + clip.duration
  )
}

export function drawFrame(ctx, canvas, image) {
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  if (!image) return

  // Fit the image inside the canvas while preserving aspect ratio (letterbox)
  const canvasRatio = canvas.width / canvas.height
  const imageRatio = image.width / image.height
  let drawWidth, drawHeight

  if (imageRatio > canvasRatio) {
    drawWidth = canvas.width
    drawHeight = canvas.width / imageRatio
  } else {
    drawHeight = canvas.height
    drawWidth = canvas.height * imageRatio
  }

  const x = (canvas.width - drawWidth) / 2
  const y = (canvas.height - drawHeight) / 2

  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(image, x, y, drawWidth, drawHeight)
}

export function seekAndDrawVideo(video, ctx, canvas, timeWithinClip, onReady) {
  const trySeek = () => {
    if (Math.abs(video.currentTime - timeWithinClip) > 0.05) {
      video.currentTime = timeWithinClip
    } else {
      drawFrame(ctx, canvas, video)
      onReady && onReady()
    }
  }

  if (video.readyState >= 2) {
    trySeek()
  } else {
    video.addEventListener('loadeddata', trySeek, { once: true })
  }
}