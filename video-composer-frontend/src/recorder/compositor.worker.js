// Compositor worker (Option B - OffscreenCanvas in a Web Worker).
//
// Draws the screen capture and the webcam overlay into an OffscreenCanvas
// that is owned by this worker. Frame pumps read VideoFrames from
// MediaStreamTrackProcessor readable streams that the main thread created
// and transferred here, so rendering is driven purely by incoming capture
// frames - never by requestAnimationFrame/requestVideoFrameCallback, which
// Chrome throttles/pauses in background tabs.
//
// After each composed frame the worker posts a 'frame' message; the main
// thread answers it with CanvasCaptureMediaStreamTrack.requestFrame() so the
// recorded canvas.captureStream() track emits the composed frame
// deterministically - including while the browser tab is backgrounded.

const WEBCAM_SIZE_RATIO = {
  small: 0.18,
  medium: 0.25,
  large: 0.32,
}

const WEBCAM_MARGIN = 24

// Cap the capture signals so the main thread is not flooded; the recorded
// frame rate of the composite track stays around ~30fps.
const SIGNAL_INTERVAL_MS = 30

let canvas = null
let ctx = null
let settings = null
let lastCameraFrame = null
let lastSignalTime = 0

function drawScreenFrame(frame) {
  const width = frame.displayWidth || canvas.width
  const height = frame.displayHeight || canvas.height

  // Surface switches (or the initial monitor pick) can change the capture
  // resolution - keep the canvas in sync so frames are not drawn at the
  // wrong size.
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }

  ctx.drawImage(frame, 0, 0, canvas.width, canvas.height)
}

function drawWebcamOverlay(frame) {
  if (!frame || !settings) {
    return
  }

  const { shape, size, zoom, mirror, position } = settings

  const sourceWidth = frame.displayWidth
  const sourceHeight = frame.displayHeight

  if (!sourceWidth || !sourceHeight) {
    return
  }

  const side = Math.round(
    canvas.width *
      (WEBCAM_SIZE_RATIO[size] || WEBCAM_SIZE_RATIO.medium),
  )

  const zoomFactor = Math.max(1, Number(zoom) || 1)
  const renderSide = side * zoomFactor

  const margin = Math.max(
    12,
    Math.round((WEBCAM_MARGIN * canvas.width) / 1280),
  )

  const isLeft = position.includes('left')
  const isTop = position.startsWith('top')

  let x = isLeft
    ? margin
    : canvas.width - side - margin

  let y = isTop
    ? margin
    : canvas.height - side - margin

  x = Math.max(
    0,
    Math.min(x, canvas.width - side),
  )

  y = Math.max(
    0,
    Math.min(y, canvas.height - side),
  )

  // Center-crop camera into a square.
  const cropSize = Math.min(
    sourceWidth,
    sourceHeight,
  )

  const sx = (sourceWidth - cropSize) / 2
  const sy = (sourceHeight - cropSize) / 2

  ctx.save()

  if (shape === 'circle') {
    ctx.beginPath()

    ctx.arc(
      x + side / 2,
      y + side / 2,
      side / 2,
      0,
      Math.PI * 2,
    )

    ctx.clip()
  } else if (shape === 'squircle') {
    const radius = Math.round(side * 0.24)

    ctx.beginPath()

    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(
        x,
        y,
        side,
        side,
        radius,
      )
    } else {
      ctx.rect(
        x,
        y,
        side,
        side,
      )
    }

    ctx.clip()
  }

  ctx.translate(
    x + side / 2,
    y + side / 2,
  )

  if (mirror) {
    ctx.scale(-1, 1)
  }

  ctx.drawImage(
    frame,
    sx,
    sy,
    cropSize,
    cropSize,
    -renderSide / 2,
    -renderSide / 2,
    renderSide,
    renderSide,
  )

  ctx.restore()
}

function signalFrame() {
  const now = performance.now()

  if (now - lastSignalTime < SIGNAL_INTERVAL_MS) {
    return
  }

  lastSignalTime = now

  self.postMessage({
    type: 'frame',
  })
}

async function pumpScreen(readable) {
  const reader =
    readable.getReader()

  while (true) {
    const { value, done } =
      await reader.read()

    if (done) {
      break
    }

    try {
      drawScreenFrame(value)
      drawWebcamOverlay(lastCameraFrame)
      signalFrame()
    } catch (err) {
      console.warn(
        '[Compositor] Frame draw skipped:',
        err?.message ?? err,
      )
    } finally {
      // VideoFrames hold native resources - always release.
      value.close()
    }
  }
}

async function pumpCamera(readable) {
  const reader =
    readable.getReader()

  while (true) {
    const { value, done } =
      await reader.read()

    if (done) {
      break
    }

    // Keep only the latest camera frame alive; the screen pump composes it
    // on top of every screen frame.
    if (lastCameraFrame) {
      lastCameraFrame.close()
    }

    lastCameraFrame = value
  }

  // Camera ended (unplugged): drop the overlay from future frames.
  if (lastCameraFrame) {
    lastCameraFrame.close()
    lastCameraFrame = null
  }
}

self.onmessage = (event) => {
  const data =
    event.data || {}

  if (data.type !== 'start') {
    return
  }

  canvas = data.canvas
  settings = data.settings

  try {
    ctx = canvas.getContext('2d')
  } catch (err) {
    console.error(
      '[Compositor] OffscreenCanvas 2D context failed:',
      err,
    )

    return
  }

  pumpScreen(data.screenReadable)
  pumpCamera(data.cameraReadable)

  console.debug(
    '[Compositor] Started - screen + webcam compositing in worker',
  )
}