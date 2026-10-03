import { useState, useRef, useEffect } from 'react'
import { httpsCallable } from 'firebase/functions'
import { functions } from '../lib/firebase'
import type { ChatMessage } from '../lib/types'

type Props = {
  messages: ChatMessage[]
  suggestedMessages?: string[]
  onSend: (userMessage: string) => Promise<void>
  disabled?: boolean
  loading?: boolean
  placeholder?: string
}

export function RecommendationChat({
  messages,
  suggestedMessages = [],
  onSend,
  disabled,
  loading = false,
  placeholder = "Refine today's plan...",
}: Props) {
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  const handleSend = async (textOverride?: string) => {
    const message = textOverride ?? input.trim()
    if (!message || loading || disabled || transcribing) return

    try {
      setError(null)
      if (!textOverride) setInput('')
      await onSend(message)
    } catch (e) {
      setError((e as Error)?.message || 'Failed to send')
    }
  }

  const startRecording = async () => {
    try {
      setError(null)
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mr = new MediaRecorder(stream)
      chunksRef.current = []
      mr.ondataavailable = (ev) => { if (ev.data.size > 0) chunksRef.current.push(ev.data) }
      mr.onstop = () => { stream.getTracks().forEach((t) => t.stop()) }
      mr.start()
      mediaRecorderRef.current = mr
      setRecording(true)
    } catch (e) {
      setError('Mic access denied')
    }
  }

  const stopAndTranscribe = async () => {
    const mr = mediaRecorderRef.current
    if (!mr) return
    try {
      setTranscribing(true)
      const stopped = new Promise<void>((resolve) => { mr.onstop = () => resolve(); mr.stop() })
      await stopped
      const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
      const reader = new FileReader()
      const base64Promise = new Promise<string>((resolve) => {
        reader.onloadend = () => resolve((reader.result as string).split(',')[1])
      })
      reader.readAsDataURL(blob)
      const audioBase64 = await base64Promise
      const transcribeFn = httpsCallable<{ audio: string; mimeType?: string }, { transcription: string }>(functions, 'transcribeWorkoutVoice')
      const { data: { transcription } } = await transcribeFn({ audio: audioBase64, mimeType: 'audio/webm' })
      if (transcription) await handleSend(transcription)
    } catch (e) {
      setError('Transcription failed')
    } finally {
      setTranscribing(false)
      setRecording(false)
    }
  }

  return (
    <div className="chat-container">
      <div className="chat-messages">
        {messages.map((msg, i) => (
          <div key={i} className={`chat-msg ${msg.role}`}>
            {msg.content}
          </div>
        ))}
        {(loading || transcribing) && (
          <div className="chat-msg assistant small muted" style={{ background: 'transparent' }}>
            {transcribing ? 'Transcribing...' : 'Coach is thinking...'}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="chat-input-area stack">
        {suggestedMessages.length > 0 && (
          <div className="chatSuggestions" style={{ margin: '0 0 12px' }}>
            {suggestedMessages.map((suggestion, idx) => (
              <button
                key={`${suggestion}-${idx}`}
                className="secondary chatSuggestion"
                disabled={loading || disabled || transcribing}
                onClick={() => void handleSend(suggestion)}
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}

        <div className="chat-input-row">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void handleSend()}
            placeholder={placeholder}
            disabled={loading || disabled || transcribing || recording}
          />

          <button
            className={`secondary ${recording ? 'recording' : ''}`}
            style={{
              width: '36px',
              height: '36px',
              padding: 0,
              borderRadius: '50%',
              background: recording ? 'var(--error)' : 'transparent',
              borderColor: recording ? 'var(--error)' : 'var(--border)'
            }}
            onClick={() => void (recording ? stopAndTranscribe() : startRecording())}
            disabled={loading || disabled || transcribing}
          >
            {recording ? '⏹' : '🎤'}
          </button>

          <button
            className="primary"
            style={{ width: '36px', height: '36px', padding: 0, borderRadius: '50%' }}
            onClick={() => void handleSend()}
            disabled={!input.trim() || loading || disabled || transcribing || recording}
          >
            ↑
          </button>
        </div>
        {error && <div className="error" style={{ textAlign: 'center', marginTop: '8px' }}>{error}</div>}
      </div>
    </div>
  )
}
