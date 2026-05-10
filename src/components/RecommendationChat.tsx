import { useState, useRef, useEffect } from 'react'
import type { RecommendationResponse } from '../lib/types'

type ConversationMessage = {
  role: 'user' | 'assistant'
  content: string
}

type Props = {
  onRefine: (userMessage: string, history: ConversationMessage[]) => Promise<RecommendationResponse>
  onUpdate: (recommendation: RecommendationResponse) => void
  disabled?: boolean
}

export function RecommendationChat({ onRefine, onUpdate, disabled }: Props) {
  const [messages, setMessages] = useState<ConversationMessage[]>([
    {
      role: 'assistant',
      content: 'Feel free to ask me to adjust the recommendation. For example: "I only have 30 minutes", "I don\'t have equipment", or "Make it harder".',
    },
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
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

      // Add user message
      const updatedMessages = [
        ...messages,
        { role: 'user' as const, content: message },
      ]
      setMessages(updatedMessages)

      // Request refinement
      setLoading(true)
      const refined = await onRefine(message, updatedMessages)
      onUpdate(refined)

      // Add assistant response (summary of what was updated)
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: 'I\'ve updated your recommendation. Check the workout options above!',
        },
      ])
    } catch (e) {
      setError((e as Error)?.message || 'Failed to refine recommendation')
      setMessages((prev) => prev.slice(0, -1)) // Remove failed user message
    } finally {
      setLoading(false)
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
            <div className="chatContent chatLoading">Refining recommendation...</div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {error && <div className="error" style={{ marginBottom: '10px' }}>{error}</div>}

      <div className="chatInput">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask for adjustments... (e.g., 'I only have 30 min')"
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
