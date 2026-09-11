import { useEffect, useRef, useState } from 'react'

const EXAMPLE_PROMPTS = [
  'Make the selected clip grayscale and 1.25x faster',
  'Trim the selected clip to 5 seconds and add a title',
  'Set this composition to 1080 by 1920',
]

function getSpeechRecognition() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null
}

function AIChatPanel({ messages, onSend, loading, error, selectedClip, assets, lastResult, onUndo, failedPrompt, onRetry }) {
  const [input, setInput] = useState('')
  const [listening, setListening] = useState(false)
  const [speechError, setSpeechError] = useState('')
  const recognitionRef = useRef(null)
  const historyRef = useRef(null)

  useEffect(() => {
    historyRef.current?.scrollTo({ top: historyRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, loading])

  useEffect(() => () => recognitionRef.current?.stop(), [])

  const startListening = () => {
    const Recognition = getSpeechRecognition()
    if (!Recognition) {
      setSpeechError('Speech input is not supported in this browser. You can still type your prompt.')
      return
    }
    setSpeechError('')
    const recognition = new Recognition()
    recognition.lang = 'en-US'
    recognition.interimResults = true
    recognition.continuous = false
    recognition.onstart = () => setListening(true)
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results).map((result) => result[0].transcript).join(' ')
      setInput(transcript)
    }
    recognition.onerror = (event) => {
      setSpeechError(event.error === 'not-allowed' ? 'Microphone permission was denied.' : `Speech input error: ${event.error}.`)
      setListening(false)
    }
    recognition.onend = () => setListening(false)
    recognitionRef.current = recognition
    try { recognition.start() } catch { setSpeechError('Speech input could not start. Try again.') }
  }

  const stopListening = () => {
    recognitionRef.current?.stop()
    setListening(false)
  }

  const submit = (event) => {
    event.preventDefault()
    const prompt = input.trim()
    if (!prompt || loading) return
    onSend(prompt)
    setInput('')
  }

  return (
    <div className="ai-panel" aria-label="AI Agent">
      <div className="ai-panel-header">
        <div>
          <p className="sidebar-kicker">Editing assistant</p>
          <h2 className="sidebar-title">AI Agent</h2>
        </div>
        <span className="ai-panel-status" data-loading={loading}>{loading ? 'Working' : 'Ready'}</span>
      </div>

      <div className="ai-examples" aria-label="Example prompts">
        {EXAMPLE_PROMPTS.map((prompt) => (
          <button key={prompt} type="button" onClick={() => setInput(prompt)} disabled={loading}>{prompt}</button>
        ))}
      </div>

      <div className="ai-chat-history" ref={historyRef} aria-live="polite">
        {messages.length === 0 && (
          <p className="ai-empty">Ask me to edit your timeline. I can change clips, text, audio, dimensions, speed, and effects.</p>
        )}
        {messages.map((message) => (
          <div key={message.id} className={`ai-message ${message.role}`}>
            <span className="ai-message-role">{message.role === 'user' ? 'You' : 'AI Agent'}</span>
            <p>{message.content}</p>
          </div>
        ))}
        {loading && <div className="ai-message assistant"><span className="ai-message-role">AI Agent</span><p>Reviewing your composition...</p></div>}
      </div>

      {(error || speechError) && <p className="message error ai-error" role="alert">{error || speechError}</p>}
      {(error || failedPrompt || lastResult) && (
        <div className="ai-result-actions">
          {failedPrompt && <button type="button" onClick={() => onRetry(failedPrompt)} disabled={loading}>Retry</button>}
          {lastResult && <button type="button" onClick={onUndo} disabled={loading}>Undo last edit</button>}
        </div>
      )}

      <form className="ai-composer" onSubmit={submit}>
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={listening ? 'Listening... edit the transcript before sending' : 'Describe an edit...'}
          rows={3}
          disabled={loading}
          aria-label="AI prompt"
        />
        <div className="ai-composer-actions">
          <button type="button" className={listening ? 'ai-mic-button listening' : 'ai-mic-button'} onClick={listening ? stopListening : startListening} disabled={loading} aria-label={listening ? 'Stop listening' : 'Use microphone'} title={listening ? 'Stop listening' : 'Use microphone'}>{listening ? '■' : '●'}</button>
          <button type="submit" className="ai-send-button" disabled={loading || !input.trim()}>{loading ? 'Working...' : 'Send'}</button>
        </div>
      </form>
      <span className="ai-context-note">{selectedClip ? `Selected: ${selectedClip.fileName}` : `${assets.length} local asset${assets.length === 1 ? '' : 's'} available`}</span>
    </div>
  )
}

export default AIChatPanel
