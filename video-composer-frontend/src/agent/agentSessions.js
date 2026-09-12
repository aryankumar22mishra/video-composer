import { useState } from 'react'

export const AGENT_MODES = {
  edit: { title: 'Edit Video', kicker: 'Edit your existing media', placeholder: 'Describe an edit to your timeline...',
    empty: 'Trim clips, add text, change dimensions or adjust effects using your timeline and uploaded media.',
    prompts: ['Trim this clip to 5 seconds', 'Add a title', 'Change to 9:16', 'Make this clip black and white'] },
  plan: { title: 'Plan New Video', kicker: 'Turn an idea into a scene plan', placeholder: 'Describe your video idea, audience and message...',
    empty: 'Tell me your topic and audience. We’ll build a brief, review a scene plan, and assemble your uploaded assets into an editable timeline.',
    prompts: ['Create a 30-second AI video for college students'] },
}

export function createAgentSessions() {
  const create = () => ({ messages: [], draft: '', error: '', goal: null, lastEditedTarget: null,
    lastResult: null, failedPrompt: '', progress: null, generateAssets: false })
  return { edit: create(), plan: create() }
}

export function updateAgentSession(sessions, mode, field, value) {
  return { ...sessions, [mode]: { ...sessions[mode], [field]: typeof value === 'function' ? value(sessions[mode][field]) : value } }
}

export function useAgentSessions(mode) {
  const [sessions, setSessions] = useState(createAgentSessions)
  const set = (field) => (value) => setSessions((previous) => updateAgentSession(previous, mode, field, value))
  return { ...sessions[mode], set }
}
