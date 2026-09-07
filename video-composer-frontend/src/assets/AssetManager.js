// Turns a File into a browser-usable asset: an Object URL plus real
// metadata (duration, width, height) read from the actual media.
// This does not touch the upload/composition flow yet — it's a
// standalone utility for later phases to build on.

export function createObjectUrlAsset(file) {
  return URL.createObjectURL(file)
}

export function revokeObjectUrlAsset(url) {
  if (url) URL.revokeObjectURL(url)
}

export function loadImageMetadata(file) {
  return new Promise((resolve, reject) => {
    const url = createObjectUrlAsset(file)
    const img = new Image()
    img.onload = () => {
      resolve({ url, width: img.naturalWidth, height: img.naturalHeight, duration: null })
    }
    img.onerror = () => {
      revokeObjectUrlAsset(url)
      reject(new Error(`Could not load image: ${file.name}`))
    }
    img.src = url
  })
}

// Resolves the true duration of a video. MediaRecorder-produced WebM
// files (screen/webcam recordings) do not declare a Duration element in
// their header, so the browser initially reports `duration === Infinity`
// for them. The seek-to-end workaround below forces the browser to scan
// the stream and compute the real duration. Never resolves Infinity/NaN.
//
// Exported so the composer's hidden preview <video> elements can run the
// same fix — without it those elements are unseekable and the canvas
// preview cannot play recorded clips (the file itself is fine; FFmpeg
// reads it correctly on the backend).
export function resolveVideoDuration(video, timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (Number.isFinite(video.duration) && video.duration > 0) {
      resolve(video.duration)
      return
    }

    let settled = false
    const cleanup = () => {
      video.removeEventListener('durationchange', onDurationChange)
      video.removeEventListener('error', onError)
      clearTimeout(timer)
    }
    const finish = (duration) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(duration)
    }
    const onDurationChange = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        video.currentTime = 0 // rewind after the probe seek
        finish(video.duration)
      }
    }
    const onError = () => finish(NaN)
    video.addEventListener('durationchange', onDurationChange)
    video.addEventListener('error', onError)
    const timer = setTimeout(() => finish(NaN), timeoutMs)

    // Seek far past the end: the browser must scan the whole stream to
    // satisfy the seek, which reveals the real duration via durationchange.
    try {
      video.currentTime = 1e101
    } catch {
      finish(NaN)
    }
  })
}

export function loadVideoMetadata(file) {
  return new Promise((resolve, reject) => {
    const url = createObjectUrlAsset(file)
    const video = document.createElement('video')
    video.preload = 'metadata'

    video.onerror = () => {
      revokeObjectUrlAsset(url)
      reject(new Error(`Could not load video: ${file.name}`))
    }

    video.onloadedmetadata = async () => {
      try {
        const duration = await resolveVideoDuration(video)
        console.debug('[Duration] file=%s duration=%s', file.name, duration)

        // Never hand Infinity/NaN upstream as a valid duration.
        if (!Number.isFinite(duration) || duration <= 0) {
          revokeObjectUrlAsset(url)
          reject(new Error(`Could not determine duration for video: ${file.name}`))
          return
        }

        resolve({ url, width: video.videoWidth, height: video.videoHeight, duration })
      } catch (metadataError) {
        revokeObjectUrlAsset(url)
        reject(metadataError)
      }
    }

    video.src = url
  })
}

export function loadAssetMetadata(file) {
  if (file.type.startsWith('image/')) return loadImageMetadata(file)
  if (file.type.startsWith('video/')) return loadVideoMetadata(file)
  return Promise.reject(new Error(`Unsupported file type: ${file.type}`))
}