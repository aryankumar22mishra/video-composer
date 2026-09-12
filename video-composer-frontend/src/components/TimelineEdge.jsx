import { useRef, useState } from 'react'

export default function TimelineEdge({ edge, duration, zoom, onCommit }) {
  const drag = useRef(null)
  const [delta, setDelta] = useState(null)
  const finish = (event, commit) => {
    if (!drag.current) return
    const change = (event.clientX - drag.current.x) / zoom
    drag.current = null
    setDelta(null)
    if (commit && Math.abs(change) > 0.01) onCommit(change)
  }
  return <button type="button" className={`timeline-trim-handle timeline-trim-${edge}`}
    aria-label={`Resize clip ${edge}`} title={`Drag to adjust ${edge}; arrow keys adjust by 0.25 seconds`}
    onClick={(event) => event.stopPropagation()}
    onPointerDown={(event) => { event.stopPropagation(); event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX }; setDelta(0) }}
    onPointerMove={(event) => { if (drag.current) setDelta((event.clientX - drag.current.x) / zoom) }}
    onPointerUp={(event) => finish(event, true)} onPointerCancel={(event) => finish(event, false)}
    onLostPointerCapture={() => { drag.current = null; setDelta(null) }}
    onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); onCommit(event.key === 'ArrowLeft' ? -0.25 : 0.25) } }}>
    {edge === 'start' ? '\u2039' : '\u203a'}
    {delta !== null && <span className="timeline-resize-feedback">{Math.max(.25, duration + (edge === 'start' ? -delta : delta)).toFixed(2)}s requested</span>}
  </button>
}
