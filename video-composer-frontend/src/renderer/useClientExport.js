// Phase 5 — client export hook. Single entry point for ALL client-side
// exports. Picks the best engine for the requested format, with automatic
// fallback to the zero-dependency real-time WebM path:
//   MP4 fast (WebCodecs+mp4-muxer) -> WebM fast -> WebM real-time
//   WebM fast (WebCodecs+webm-muxer) -> WebM real-time
// Result previews play instantly from an object URL; downloads are plain
// <a download> links. No Django/Celery/FFmpeg involved anywhere here.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  exportWebM,
  cancelWebMExport,
  resetWebMExportCancel,
} from './webmExporter'
import {
  exportMP4,
  exportFastWebM,
  cancelFastExport,
  resetFastExportCancel,
  webCodecsSupported,
} from './mp4Exporter'

export const EXPORT_FORMATS = {
  MP4: 'mp4',
  WEBM: 'webm',
}

const initialState = {
  status: 'idle',
  phase: null,
  progress: 0,
  elapsed: 0,
  total: 0,
  message: '',
  result: null,
  error: null,
}

export function useClientExport() {
  const [state, setState] = useState(initialState)
  const runIdRef = useRef(0)

  const cancel = useCallback(() => {
    runIdRef.current += 1
    cancelWebMExport()
    cancelFastExport()
    setState((prev) => {
      if (prev.result?.url) { try { URL.revokeObjectURL(prev.result.url) } catch { /* noop */ } }
      return { ...initialState, status: 'cancelled', message: 'Export cancelled.' }
    })
  }, [])

  useEffect(() => () => {
    runIdRef.current += 1
    cancelWebMExport()
    cancelFastExport()
    setState((prev) => {
      if (prev.result?.url) { try { URL.revokeObjectURL(prev.result.url) } catch { /* noop */ } }
      return prev
    })
  }, [])

  const start = useCallback(async ({
    composition,
    clips,
    audioFile,
    mediaImages,
    format = EXPORT_FORMATS.MP4,
  } = {}) => {
    const runId = runIdRef.current + 1
    runIdRef.current = runId
    const alive = () => runIdRef.current === runId

    setState((prev) => {
      if (prev.result?.url) { try { URL.revokeObjectURL(prev.result.url) } catch { /* noop */ } }
      return { ...initialState, status: 'working', phase: 'preparing', message: 'Preparing export…' }
    })
    resetWebMExportCancel()
    resetFastExportCancel()

    const report = (p) => {
      if (!alive()) return
      const phase = p.phase || 'working'
      let message = 'Exporting…'
      let progress = p.progress ?? 0
      if (phase === 'loading') {
        message = p.total ? `Loading media ${p.done || 0}/${p.total}…` : 'Loading media…'
        progress = 0.02
      } else if (phase === 'mixing') {
        message = p.stage === 'decode-background'
          ? 'Decoding background audio…'
          : p.stage === 'decode-clip'
            ? `Decoding clip audio ${(p.index ?? 0) + 1}/${p.total || ''}…`
            : 'Mixing audio…'
        progress = 0.05
      } else if (phase === 'rendering') {
        message = `Rendering ${formatLabel(format)} ${(p.elapsed || 0).toFixed(1)}s / ${(p.total || 0).toFixed(1)}s — keep this tab visible…`
        progress = 0.05 + 0.95 * (p.progress || 0)
      } else if (phase === 'encoding') {
        message = `Encoding frame ${p.frame || 0}/${p.totalFrames || ''}…`
        progress = 0.05 + 0.95 * (p.progress || 0)
      }
      setState((prev) => ({ ...prev, phase, progress, message, elapsed: p.elapsed ?? prev.elapsed, total: p.total ?? p.totalFrames ?? prev.total }))
    }

    try {
      let result = null
      const common = { composition, clips, audioFile, mediaImages, onProgress: report }
      if (format === EXPORT_FORMATS.WEBM) {
        if (webCodecsSupported()) {
          try { result = await exportFastWebM(common) }
          catch (err) {
            if (!alive()) return null
            if (String(err?.message || '').toLowerCase().includes('cancelled')) throw err
            result = await exportWebM(common)
          }
        } else {
          result = await exportWebM(common)
        }
      } else {
        try { result = await exportMP4(common) }
        catch (err) {
          if (!alive()) return null
          if (String(err?.message || '').toLowerCase().includes('cancelled')) throw err
          if (webCodecsSupported()) {
            try { result = await exportFastWebM(common) }
            catch { result = await exportWebM(common) }
          } else {
            result = await exportWebM(common)
          }
        }
      }
      if (!alive() || !result) return null
      setState({
        ...initialState,
        status: 'done',
        phase: 'done',
        progress: 1,
        message: `${formatLabel(result.mimeType?.includes('mp4') ? 'mp4' : 'webm')} ready — preview below.`,
        result,
      })
      return result
    } catch (err) {
      if (!alive()) return null
      const cancelled = String(err?.message || '').toLowerCase().includes('cancelled')
      setState({
        ...initialState,
        status: cancelled ? 'cancelled' : 'error',
        message: '',
        error: cancelled ? 'Export cancelled.' : (err?.message || 'Export failed.'),
      })
      return null
    }
  }, [])

  const reset = useCallback(() => {
    runIdRef.current += 1
    setState((prev) => {
      if (prev.result?.url) { try { URL.revokeObjectURL(prev.result.url) } catch { /* noop */ } }
      return { ...initialState }
    })
  }, [])

  return { ...state, start, cancel, reset, exporting: state.status === 'working' }
}

function formatLabel(format) {
  return String(format).toLowerCase() === 'mp4' ? 'MP4' : 'WebM'
}
