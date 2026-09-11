// Composition snapshots include agent-selected background audio IDs. Asset Files
// stay in the library so undo/redo never recreates or re-bills generated media.
export function createHistory(composition) {
  return { past: [], future: [], last: JSON.stringify(composition) }
}

export function recordHistory(history, composition) {
  const serialized = JSON.stringify(composition)
  if (serialized === history.last) return
  history.past.push(JSON.parse(history.last))
  history.future = []
  history.last = serialized
}

export function restoreHistory(history, direction) {
  const source = direction === 'undo' ? history.past : history.future
  const target = direction === 'undo' ? history.future : history.past
  const composition = source.pop()
  if (!composition) return null
  target.push(JSON.parse(history.last))
  history.last = JSON.stringify(composition)
  return composition
}
