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

export function loadVideoMetadata(file) {
  return new Promise((resolve, reject) => {
    const url = createObjectUrlAsset(file)
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.onloadedmetadata = () => {
      resolve({ url, width: video.videoWidth, height: video.videoHeight, duration: video.duration })
    }
    video.onerror = () => {
      revokeObjectUrlAsset(url)
      reject(new Error(`Could not load video: ${file.name}`))
    }
    video.src = url
  })
}

export function loadAssetMetadata(file) {
  if (file.type.startsWith('image/')) return loadImageMetadata(file)
  if (file.type.startsWith('video/')) return loadVideoMetadata(file)
  return Promise.reject(new Error(`Unsupported file type: ${file.type}`))
}