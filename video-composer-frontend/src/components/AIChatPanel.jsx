import { useEffect, useRef, useState } from 'react'

import { AGENT_MODES } from '../agent/agentSessions'

function getSpeechRecognition() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null
}

function AIChatPanel({ mode, onModeChange, input, onInputChange: setInput, generateAssets, onGenerateAssetsChange, brief, messages, onSend, loading, error, selectedClip, assets, lastResult, onUndo, failedPrompt, onRetry, progress, review, onReview, onCancel }) {
  const copy = AGENT_MODES[mode]
  const [capabilities, setCapabilities] = useState([])
  const [capabilityError, setCapabilityError] = useState(false)
  const [listening, setListening] = useState(false)
  const [speechError, setSpeechError] = useState('')
  const recognitionRef = useRef(null)
  const historyRef = useRef(null)
  useEffect(() => {
    const controller = new AbortController()
    fetch(`/api/ai/tools/?mode=${mode}`, { signal: controller.signal })
      .then((response) => { if (!response.ok) throw new Error('Unavailable'); return response.json() })
      .then((data) => { if (!controller.signal.aborted) setCapabilities(data.tools || []) })
      .catch(() => { if (!controller.signal.aborted) setCapabilityError(true) })
    return () => controller.abort()
  }, [mode])
  const generators = capabilities.filter((tool) => ['generate_image', 'generate_video'].includes(tool.name) && tool.configured)

  useEffect(() => {
    historyRef.current?.scrollTo({ top: historyRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, loading])

  useEffect(() => () => {
    const recognition = recognitionRef.current
    recognitionRef.current = null
    if (recognition) {
      recognition.onresult = null
      recognition.onend = null
      recognition.onerror = null
      recognition.onstart = null
      recognition.abort()
    }
  }, [])

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
      <div className="ai-mode-toggle" role="group" aria-label="AI Agent mode">
        {Object.entries(AGENT_MODES).map(([value, config]) => (
          <button key={value} type="button" aria-pressed={mode === value} disabled={loading}
            title={loading ? 'Finish or cancel the current request before switching modes' : config.title}
            onClick={() => onModeChange(value)}>{config.title}</button>
        ))}
      </div>
      <div className="ai-panel-header">
        <div>
          <p className="sidebar-kicker">{copy.kicker}</p>
          <h2 className="sidebar-title">{copy.title}</h2>
        </div>
        <span className="ai-panel-status" data-loading={loading}>{loading ? 'Working' : 'Ready'}</span>
      </div>

      <p className="ai-mode-capabilities">
        {mode === 'edit' ? 'Trim ? Titles ? Dimensions ? Effects ? edits use your existing media.' : 'Brief ? Scene plan ? Assemble uploaded assets'}
      </p>
      {mode === 'plan' && <>
        <details className="ai-brief-summary">
          <summary>Video brief ? {assets.length} uploaded assets</summary>
          <dl>{[['Topic', 'subject'], ['Audience', 'audience'], ['Key message', 'key_message'], ['Duration', 'duration_seconds'], ['Format', 'format']].map(([label, field]) => (
            <div key={field}><dt>{label}</dt><dd>{brief?.[field] ? `${brief[field]}${field === 'duration_seconds' ? ' seconds' : ''}` : field === 'duration_seconds' ? '30 seconds by default' : field === 'format' ? 'Current canvas by default' : 'Not supplied yet'}</dd></div>
          ))}</dl>
          <p>{assets.length ? assets.map((asset) => asset.name).join(', ') : 'Upload related images or videos using My media > Upload.'}</p>
        </details>
        {generators.length > 0 && <label className="ai-generate-option">
          <input type="checkbox" checked={generateAssets} disabled={loading} onChange={(event) => onGenerateAssetsChange(event.target.checked)} />
          <span>Generate Assets <small>Optional ? {generators.map((tool) => tool.name === 'generate_image' ? 'Images' : 'Video').join(' and ')} ? approve each paid job and preview</small></span>
        </label>}
        {capabilityError && <p className="ai-context-note">Service availability could not be checked. Start Django to use the agent.</p>}
      </>}

      <div className="ai-examples" aria-label="Example prompts">
        {copy.prompts.map((prompt) => (
          <button key={prompt} type="button" onClick={() => setInput(prompt)} disabled={loading}>{prompt}</button>
        ))}
      </div>

      <div className="ai-chat-history" ref={historyRef} aria-live="polite">
        {messages.length === 0 && (
          <p className="ai-empty">{copy.empty}</p>
        )}
        {messages.map((message) => (
          <div key={message.id} className={`ai-message ${message.role}`}>
            <span className="ai-message-role">{message.role === 'user' ? 'You' : 'AI Agent'}</span>
            <p>{message.content}</p>
          </div>
        ))}
        {progress?.results?.filter((result) => result.output?.text).map((result) => (
          <details key={result.id} className="ai-message assistant">
            <summary>Transcript</summary>
            <p>{result.output.text}</p>
          </details>
        ))}
        {loading && <div className="ai-message assistant"><span className="ai-message-role">AI Agent</span><p>{progress?.message || 'Reading your composition...'}</p></div>}
      </div>


      {review && (
        <section className="ai-review" role="dialog" aria-modal="false" aria-label={review.title}>
          <h3>{review.title}</h3>
          {review.kind === 'scenes' && <ol>{review.scenes.map((scene, index) => (
            <li key={index}><strong>{scene.duration}s</strong> — {scene.description}{scene.text && <p>Text: {scene.text}</p>}</li>
          ))}</ol>}
          {review.kind === 'charge' && <>
            <p>{review.tool} via {review.provider}</p>
            <pre>{JSON.stringify(review.arguments, null, 2)}</pre>
            <p>{review.cost_notice}</p>
            {review.sends_source_media && <p>This sends the selected audio/video file to the configured transcription service.</p>}
            <p>Approve this specific job only. Cancelling later or undoing edits cannot reverse service charges.</p>
          </>}
          {review.kind === 'asset' && <>
            {review.asset.type.startsWith('image/') ? <img src={review.asset.previewUrl} alt="Generated asset preview" />
              : review.asset.type.startsWith('video/') ? <video controls src={review.asset.previewUrl} />
                : <audio controls src={review.asset.previewUrl} />}
            <p>Approve this asset for use in the staged timeline.</p>
          </>}
          <div className="ai-result-actions">
            <button type="button" onClick={() => onReview(true)}>{review.kind === 'charge' ? 'Approve paid job' : review.kind === 'asset' ? 'Use this asset' : 'Approve scene plan'}</button>
            <button type="button" onClick={() => onReview(false)}>Decline</button>
          </div>
        </section>
      )}

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
          placeholder={listening ? 'Listening... edit the transcript before sending' : copy.placeholder}
          rows={3}
          disabled={loading}
          aria-label="AI prompt"
        />
        <div className="ai-composer-actions">
          {loading && <button type="button" onClick={onCancel}>Cancel request</button>}
          <button type="button" className={listening ? 'ai-mic-button listening' : 'ai-mic-button'} onClick={listening ? stopListening : startListening} disabled={loading} aria-label={listening ? 'Stop listening' : 'Use microphone'} title={listening ? 'Stop listening' : 'Use microphone'}>{listening ? '■' : '●'}</button>
          <button type="submit" className="ai-send-button" disabled={loading || !input.trim()}>{loading ? 'Working...' : 'Send'}</button>
        </div>
      </form>
      <span className="ai-context-note">{selectedClip ? `Selected: ${selectedClip.fileName}` : `${assets.length} local asset${assets.length === 1 ? '' : 's'} available`}</span>
    </div>
  )
}

export default AIChatPanel
