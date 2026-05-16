import { useState, useRef, useEffect } from 'react'
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
  placeholder = "Ask Flux anything about your next workout...",
}: Props) {
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  const handleSend = async () => {
    const message = input.trim()
    if (!message || loading || disabled) return

    try {
      setError(null)
      setInput('')
      await onSend(message)
    } catch (e) {
      setError((e as Error)?.message || 'Failed to send message')
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  return (
    <div className="chatContainer">
      <div className="chatMessages">
        {messages.map((msg, i) => (
          <div key={i} className={`chatMessage ${msg.role}`}>
            <div className="chatRole">{msg.role === 'user' ? 'You' : 'Flux'}</div>
            <div className="chatContent">{msg.content}</div>
          </div>
        ))}
        {loading && (
          <div className="chatMessage assistant">
            <div className="chatRole">Flux</div>
            <div className="chatContent chatLoading">Thinking...</div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {error && <div className="error" style={{ marginBottom: '10px' }}>{error}</div>}

      {suggestedMessages.length > 0 && (
        <div className="chatSuggestions">
          {suggestedMessages.map((suggestion, idx) => (
            <button
              key={`${suggestion}-${idx}`}
              type="button"
              className="secondary chatSuggestion"
              disabled={loading || disabled}
              onClick={() => {
                void onSend(suggestion)
              }}
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}

      <div className="chatInput">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={loading || disabled}
        />
        <button
          type="button"
          className="primary"
          onClick={() => void handleSend()}
          disabled={!input.trim() || loading || disabled}
        >
          {loading ? 'Refining...' : 'Send'}
        </button>
      </div>
    </div>
  )
}
