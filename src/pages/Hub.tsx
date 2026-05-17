import { collection, limit, onSnapshot, orderBy, query } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { RecommendationCard } from '../components/RecommendationCard'
import { RecommendationChat } from '../components/RecommendationChat'
import { WorkoutIcon } from '../components/WorkoutIcon'
import { useAuth } from '../lib/useAuth'
import { db, functions } from '../lib/firebase'
import type { HubChatState, SavedWorkout, Workout, WorkoutOption } from '../lib/types'

type MaybeFirebaseError = { code?: string; message?: string; details?: unknown }

function detailsMessage(details: unknown): string | null {
  if (!details) return null
  if (typeof details === 'string') return details
  if (typeof details === 'object') {
    const status = 'status' in details && typeof (details as { status?: unknown }).status === 'number' ? String((details as { status: number }).status) : null
    const step = 'step' in details && typeof (details as { step?: unknown }).step === 'string' ? (details as { step: string }).step : null
    const body = 'body' in details && typeof (details as { body?: unknown }).body === 'string' ? (details as { body: string }).body : null
    const chunks = [step ? `step=${step}` : null, status ? `status=${status}` : null, body].filter(Boolean).join(' | ')
    return chunks || null
  }
  return null
}

function errorMessage(err: unknown): string {
  const e = err as MaybeFirebaseError
  const code = typeof e?.code === 'string' ? e.code : ''
  const msg = typeof e?.message === 'string' ? e.message : String(err)
  const details = detailsMessage(e?.details)
  const core = code ? `${code}: ${msg}` : msg
  return details ? `${core}\n${details}` : core
}

const DEFAULT_GREETING = 'Coach Flux here. Your performance profile is updated. How are we tackling today?'

export function Hub() {
  const nav = useNavigate()
  const { user, profile } = useAuth()
  const [workouts, setWorkouts] = useState<Workout[]>([])
  const [syncing, setSyncing] = useState(false)
  const [respondingToRecommendation, setRespondingToRecommendation] = useState(false)
  const [savedWorkouts, setSavedWorkouts] = useState<SavedWorkout[]>([])
  const [expandedSavedId, setExpandedSavedId] = useState<string | null>(null)
  const [swipeModalOpen, setSwipeModalOpen] = useState(false)
  const [chatLoading, setChatLoading] = useState(false)
  const [sendingMessage, setSendingMessage] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [chatState, setChatState] = useState<HubChatState>({
    messages: [{ role: 'assistant', content: DEFAULT_GREETING }],
    recommendation: null,
    suggestedMessages: [],
    ui: {
      showSwipeModal: false,
      swipePrompt: '',
    }
  })

  const workoutsRef = useMemo(() => user ? collection(db, 'users', user.uid, 'workouts') : null, [user])
  const savedWorkoutsRef = useMemo(() => user ? collection(db, 'users', user.uid, 'savedWorkouts') : null, [user])

  useEffect(() => {
    if (!workoutsRef) return
    const q = query(workoutsRef, orderBy('strava.startDate', 'desc'), limit(25))
    return onSnapshot(q, (snap) => setWorkouts(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Workout, 'id'>) }))))
  }, [workoutsRef])

  useEffect(() => {
    if (!savedWorkoutsRef) return
    const q = query(savedWorkoutsRef, orderBy('savedAt', 'desc'), limit(10))
    return onSnapshot(q, (snap) => setSavedWorkouts(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<SavedWorkout, 'id'>) }))))
  }, [savedWorkoutsRef])

  const connected = Boolean(profile?.strava?.connected)

  const sync = async () => {
    try {
      setError(null); setStatus(null); setSyncing(true)
      const fn = httpsCallable<{ buildPersona?: boolean }, { upserted: number }>(functions, 'stravaSyncRecent')
      const res = await fn({ buildPersona: true })
      setStatus(`Synced ${res.data.upserted} workouts`)
    } catch (e) { setError(errorMessage(e)) } finally { setSyncing(false) }
  }

  const loadChatState = useCallback(async () => {
    if (!connected) return
    try {
      setChatLoading(true)
      const fn = httpsCallable<undefined, HubChatState>(functions, 'getHubChatStateCallable')
      const res = await fn()
      setChatState({
        messages: res.data.messages.length > 0 ? res.data.messages : [{ role: 'assistant', content: DEFAULT_GREETING }],
        recommendation: res.data.recommendation,
        suggestedMessages: res.data.suggestedMessages ?? [],
        ui: res.data.ui
      })
      if (res.data.ui?.showSwipeModal) setSwipeModalOpen(true)
    } catch (e) { setError(errorMessage(e)) } finally { setChatLoading(false) }
  }, [connected])

  useEffect(() => {
    if (connected) void loadChatState()
  }, [connected, user?.uid, loadChatState])

  const sendChatMessage = async (userMessage: string) => {
    if (!connected || sendingMessage) return
    try {
      setError(null); setSendingMessage(true)
      setChatState((prev) => ({ ...prev, messages: [...prev.messages, { role: 'user', content: userMessage }] }))
      const fn = httpsCallable<{ userMessage: string }, HubChatState>(functions, 'chatInHubCallable')
      const res = await fn({ userMessage })
      setChatState(res.data)
      if (res.data.ui?.showSwipeModal) setSwipeModalOpen(true)
    } catch (e) { setError(errorMessage(e)); void loadChatState() } finally { setSendingMessage(false) }
  }

  const respondToRecommendation = async (decision: 'pass' | 'accept', option: WorkoutOption) => {
    try {
      setError(null); setStatus(null); setRespondingToRecommendation(true)
      const fn = httpsCallable<{ decision: 'pass' | 'accept'; option: WorkoutOption }, { saved: boolean }>(functions, 'respondToWorkoutRecommendation')
      await fn({ decision, option })
      if (decision === 'accept') {
        setStatus('Plan accepted'); setChatState((prev) => ({ ...prev, recommendation: null })); setSwipeModalOpen(false)
      } else {
        setStatus('Passed'); setChatState((prev) => {
          const nextOptions = prev.recommendation ? prev.recommendation.options.filter((o) => o.title !== option.title) : []
          if (nextOptions.length === 0) setSwipeModalOpen(false)
          return {
            ...prev,
            recommendation: prev.recommendation ? { ...prev.recommendation, options: nextOptions } : null
          }
        })
      }
    } catch (e) { setError(errorMessage(e)) } finally { setRespondingToRecommendation(false) }
  }

  const hasSwipeRecommendations = Boolean(chatState.recommendation && chatState.recommendation.options.length > 0)

  return (
    <div className="stack">
      <section className="card hero stack">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ fontSize: '1.25rem' }}>Coach's Briefing</h2>
          <button className="secondary small" onClick={() => void sync()} disabled={syncing} style={{ padding: '6px 12px' }}>
            {syncing ? '...' : 'Sync Now'}
          </button>
        </div>
        <p className="muted" style={{ color: 'rgba(255,255,255,0.7)', margin: 0 }}>
          {connected ? "Your profile is primed. I've noted your recent load and drafted proactive adjustments." : "Connect Strava to unlock performance coaching."}
        </p>
      </section>

      <section className="stack">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ fontSize: '1.1rem' }}>Coach Flux</h2>
          <div className="row" style={{ gap: 6 }}>
            {profile?.goalText && <div className="badge" style={{ fontSize: '0.6rem' }}>{profile.goalText}</div>}
          </div>
        </div>

        {!connected ? (
          <button className="primary" onClick={() => nav('/onboarding')} style={{ width: '100%' }}>Connect Strava</button>
        ) : (
          <div className="stack" style={{ gap: 12 }}>
            {hasSwipeRecommendations && (
              <div className="swipe-launcher">
                <div className="muted small">{chatState.ui?.swipePrompt || 'I have workout options ready.'}</div>
                <button className="primary small" onClick={() => setSwipeModalOpen(true)}>Open Swipe Mode</button>
              </div>
            )}
            <RecommendationChat
              messages={chatState.messages}
              suggestedMessages={chatState.suggestedMessages}
              onSend={sendChatMessage}
              loading={chatLoading || sendingMessage}
              disabled={respondingToRecommendation}
            />
          </div>
        )}
      </section>

      {swipeModalOpen && hasSwipeRecommendations && (
        <div className="modal-overlay" onClick={() => setSwipeModalOpen(false)}>
          <div className="modal-card stack" onClick={(e) => e.stopPropagation()}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div className="stack" style={{ gap: 2 }}>
                <h3 style={{ fontSize: '1.1rem' }}>Swipe Workouts</h3>
                <p className="muted small" style={{ margin: 0 }}>Review and save what fits today.</p>
              </div>
              <button className="secondary small" onClick={() => setSwipeModalOpen(false)}>Close</button>
            </div>

            <div className="stack" style={{ gap: 16 }}>
              {chatState.recommendation?.options.map((option, idx) => (
                <RecommendationCard
                  key={idx}
                  option={option}
                  index={idx}
                  onPass={() => void respondToRecommendation('pass', option)}
                  onAccept={() => void respondToRecommendation('accept', option)}
                  disabled={respondingToRecommendation}
                />
              ))}
            </div>

            {chatState.recommendation?.safetyChecks && chatState.recommendation.safetyChecks.length > 0 && (
              <div className="stack" style={{ gap: 8, marginTop: '8px' }}>
                <div className="rec-label">Safety Checks</div>
                <ul className="whyList" style={{ marginTop: 0 }}>
                  {chatState.recommendation.safetyChecks.map((check, i) => <li key={i}>{check}</li>)}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}

      {chatState.recommendation && chatState.recommendation.options.length > 0 && !swipeModalOpen && (
        <section className="stack">
          <h2 style={{ fontSize: '1.1rem' }}>Recommended Plans</h2>
          <div className="stack">
            {chatState.recommendation.options.map((option, idx) => (
              <RecommendationCard
                key={idx}
                option={option}
                index={idx}
                onPass={() => void respondToRecommendation('pass', option)}
                onAccept={() => void respondToRecommendation('accept', option)}
                disabled={respondingToRecommendation}
              />
            ))}
          </div>
        </section>
      )}

      <section className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <div className="card stack" style={{ padding: '16px' }}>
          <div className="rec-label">Activities</div>
          <div style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--text-h)' }}>{workouts.length}</div>
        </div>
        <div className="card stack" style={{ padding: '16px' }}>
          <div className="rec-label">Context Added</div>
          <div style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--text-h)' }}>{workouts.filter(w => w.context?.text).length}</div>
        </div>
      </section>

      {savedWorkouts.length > 0 && (
        <section className="stack">
          <h2 style={{ fontSize: '1.1rem' }}>Recently Saved</h2>
          <div className="stack" style={{ gap: 12 }}>
            {savedWorkouts.slice(0, 3).map((sw) => (
              <div key={sw.id} className="card stack" style={{ padding: '16px' }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div className="row">
                    <div className="rec-icon" style={{ width: '32px', height: '32px' }}><WorkoutIcon type={sw.option.type} /></div>
                    <div className="rec-value" style={{ fontSize: '0.9rem' }}>{sw.option.title}</div>
                  </div>
                  <button className="secondary small" onClick={() => setExpandedSavedId(expandedSavedId === sw.id ? null : sw.id)}>
                    {expandedSavedId === sw.id ? 'Close' : 'View'}
                  </button>
                </div>
                {expandedSavedId === sw.id && (
                  <div className="stack" style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--border)', gap: 12 }}>
                    <div className="stack" style={{ gap: 4 }}>
                      <div className="rec-label">Main Set</div>
                      <div className="sectionContent" style={{ fontSize: '0.8rem' }}>{sw.option.mainSet}</div>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {status ? <p className="muted" style={{ textAlign: 'center', fontSize: '12px' }}>{status}</p> : null}
      {error ? <p className="error" style={{ textAlign: 'center', fontSize: '12px' }}>{error}</p> : null}
    </div>
  )
}
