import { collection, limit, onSnapshot, orderBy, query } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { RecommendationCard } from '../components/RecommendationCard'
import { RecommendationChat } from '../components/RecommendationChat'
import { WorkoutContextEditor } from '../components/WorkoutContextEditor'
import { WorkoutIcon } from '../components/WorkoutIcon'
import { useAuth } from '../lib/useAuth'
import { db, functions } from '../lib/firebase'
import type { HubChatState, SavedWorkout, Workout, WorkoutOption } from '../lib/types'

type MaybeFirebaseError = { code?: string; message?: string; details?: unknown }

function detailsMessage(details: unknown): string | null {
  if (!details) return null
  if (typeof details === 'string') return details
  if (typeof details === 'object') {
    const status =
      'status' in details && typeof (details as { status?: unknown }).status === 'number'
        ? String((details as { status: number }).status)
        : null
    const step =
      'step' in details && typeof (details as { step?: unknown }).step === 'string'
        ? (details as { step: string }).step
        : null
    const body =
      'body' in details && typeof (details as { body?: unknown }).body === 'string'
        ? (details as { body: string }).body
        : null
    const chunks = [step ? `step=${step}` : null, status ? `status=${status}` : null, body]
      .filter(Boolean)
      .join(' | ')
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

const DEFAULT_GREETING = 'I’m your training coach. Tell me your goals, time, equipment, or how you feel, and I’ll tailor your next workout.'
const DEFAULT_SWIPE_PROMPT = 'I have workout options ready. Open swipe mode to pass or save what fits today.'

function formatMinutes(seconds?: number | null): string {
  if (!seconds || seconds <= 0) return ''
  return `${Math.round(seconds / 60)} min`
}

function formatKilometers(meters?: number | null): string {
  if (!meters || meters <= 0) return ''
  return `${(meters / 1000).toFixed(1)} km`
}

export function Hub() {
  const nav = useNavigate()
  const { user, profile } = useAuth()
  const [workouts, setWorkouts] = useState<Workout[]>([])
  const [syncing, setSyncing] = useState(false)
  const [respondingToRecommendation, setRespondingToRecommendation] = useState(false)
  const [savedWorkouts, setSavedWorkouts] = useState<SavedWorkout[]>([])
  const [expandedSavedId, setExpandedSavedId] = useState<string | null>(null)
  const [expandedWorkoutId, setExpandedWorkoutId] = useState<string | null>(null)
  const [showPastWorkoutsPanel, setShowPastWorkoutsPanel] = useState(false)
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
      swipePrompt: DEFAULT_SWIPE_PROMPT,
    },
  })

  const workoutsRef = useMemo(() => {
    if (!user) return null
    return collection(db, 'users', user.uid, 'workouts')
  }, [user])

  const savedWorkoutsRef = useMemo(() => {
    if (!user) return null
    return collection(db, 'users', user.uid, 'savedWorkouts')
  }, [user])

  useEffect(() => {
    if (!workoutsRef) return
    const q = query(workoutsRef, orderBy('strava.startDate', 'desc'), limit(25))
    return onSnapshot(q, (snap) => {
      setWorkouts(
        snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Workout, 'id'>) })),
      )
    })
  }, [workoutsRef])

  useEffect(() => {
    if (!savedWorkoutsRef) return
    const q = query(savedWorkoutsRef, orderBy('savedAt', 'desc'), limit(10))
    return onSnapshot(q, (snap) => {
      setSavedWorkouts(
        snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<SavedWorkout, 'id'>) })),
      )
    })
  }, [savedWorkoutsRef])

  const connected = Boolean(profile?.strava?.connected)
  const withContext = workouts.filter((w) => Boolean(w.context?.text)).length

  const sync = async () => {
    try {
      setError(null)
      setStatus(null)
      setSyncing(true)
      const fn = httpsCallable<
        { buildPersona?: boolean },
        { upserted: number; personaBuilt?: boolean; personaError?: string | null }
      >(functions, 'stravaSyncRecent')
      const res = await fn({ buildPersona: true })
      setStatus(`Synced ${res.data.upserted} workouts`)
      if (res.data.personaError) {
        setError(`Workouts synced, but background sync encountered an issue: ${res.data.personaError}`)
      }
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setSyncing(false)
    }
  }

  const loadChatState = useCallback(async () => {
    if (!connected) return
    try {
      setChatLoading(true)
      const fn = httpsCallable<undefined, HubChatState>(functions, 'getHubChatState')
      const res = await fn()
      const next = res.data
      setChatState({
        messages: next.messages.length > 0 ? next.messages : [{ role: 'assistant', content: DEFAULT_GREETING }],
        recommendation: next.recommendation,
        suggestedMessages: next.suggestedMessages ?? [],
        ui: {
          showSwipeModal: Boolean(next.ui?.showSwipeModal && next.recommendation?.options?.length),
          swipePrompt: next.ui?.swipePrompt?.trim() || DEFAULT_SWIPE_PROMPT,
        },
      })
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setChatLoading(false)
    }
  }, [connected])

  useEffect(() => {
    if (!connected) return
    const timeoutId = window.setTimeout(() => {
      void loadChatState()
    }, 0)
    return () => window.clearTimeout(timeoutId)
  }, [connected, user?.uid, loadChatState])

  const sendChatMessage = async (userMessage: string) => {
    if (!connected || sendingMessage) return
    try {
      setError(null)
      setSendingMessage(true)
      setChatState((prev) => ({
        ...prev,
        messages: [...prev.messages, { role: 'user', content: userMessage }],
      }))
      const fn = httpsCallable<{ userMessage: string }, HubChatState>(functions, 'chatInHub')
      const res = await fn({ userMessage })
      setChatState(res.data)
    } catch (e) {
      setError(errorMessage(e))
      await loadChatState()
    } finally {
      setSendingMessage(false)
    }
  }

  const respondToRecommendation = async (decision: 'pass' | 'accept', option: WorkoutOption) => {
    try {
      setError(null)
      setStatus(null)
      setRespondingToRecommendation(true)

      const fn = httpsCallable<
        { decision: 'pass' | 'accept'; option: WorkoutOption },
        { saved: boolean }
      >(functions, 'respondToWorkoutRecommendation')

      const res = await fn({ decision, option })

      if (decision === 'accept') {
        setStatus('Workout accepted and saved. Flux persona updated with your preference.')
        setChatState((prev) => ({
          ...prev,
          recommendation: null,
          ui: {
            showSwipeModal: false,
            swipePrompt: prev.ui?.swipePrompt || DEFAULT_SWIPE_PROMPT,
          },
        }))
        setSwipeModalOpen(false)
        if (!res.data.saved) {
          setStatus('Workout accepted. Saved workout list will update shortly.')
        }
      } else {
        setStatus('Passed. Flux noted your preference and can suggest alternatives in chat.')
        setChatState((prev) => ({
          ...prev,
          recommendation: prev.recommendation
            ? {
                ...prev.recommendation,
                options: prev.recommendation.options.filter((candidate) => candidate.title !== option.title),
              }
            : null,
          ui: {
            showSwipeModal: false,
            swipePrompt: prev.ui?.swipePrompt || DEFAULT_SWIPE_PROMPT,
          },
        }))
      }
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setRespondingToRecommendation(false)
    }
  }

  const hasSwipeRecommendations = Boolean(chatState.recommendation && chatState.recommendation.options.length > 0)

  useEffect(() => {
    if (chatState.ui?.showSwipeModal && hasSwipeRecommendations) {
      setSwipeModalOpen(true)
    }
  }, [chatState.ui?.showSwipeModal, hasSwipeRecommendations])

  useEffect(() => {
    if (!swipeModalOpen) return
    const onEsc = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSwipeModalOpen(false)
    }
    window.addEventListener('keydown', onEsc)
    return () => window.removeEventListener('keydown', onEsc)
  }, [swipeModalOpen])

  return (
    <main className="stack">
      <section className="card hero">
        <h2>Hub</h2>
        <p className="muted">
          Chat with Flux for your next workout, then accept or pass options to keep improving your persona.
        </p>
        <div className="metricGrid">
          <div className="metric">
            <div className="metricLabel">Recent workouts</div>
            <div className="metricValue">{workouts.length}</div>
          </div>
          <div className="metric">
            <div className="metricLabel">Context added</div>
            <div className="metricValue">{withContext}</div>
          </div>
          <div className="metric">
            <div className="metricLabel">Strava status</div>
            <div className="metricValue">{connected ? 'Connected' : 'Pending'}</div>
          </div>
        </div>
      </section>

      <section className="card stack">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div className="stack" style={{ gap: 4 }}>
            <h2>Coach chat</h2>
            <div className="stack" style={{ gap: 2 }}>
              <p className="muted" style={{ fontSize: '13px' }}>
                Goal: {profile?.goalText ? `"${profile.goalText}"` : 'Not set'}
              </p>
              <p className="muted" style={{ fontSize: '13px' }}>
                Environment: {profile?.workoutEnvironmentConstraintsText ? `"${profile.workoutEnvironmentConstraintsText}"` : 'Not set'}
              </p>
            </div>
          </div>
          <button
            type="button"
            className="secondary"
            style={{ minHeight: 'auto', padding: '6px 12px', fontSize: '12px' }}
            onClick={() => void sync()}
            disabled={syncing}
          >
            {syncing ? 'Syncing...' : 'Refresh sync'}
          </button>
        </div>

        {!connected ? (
          <button type="button" className="secondary" onClick={() => nav('/onboarding')}>
            Connect Strava to get started
          </button>
        ) : workouts.length === 0 ? (
          <p className="muted" style={{ fontSize: '13px' }}>
            Sync your Strava history to unlock personalized recommendations in chat.
          </p>
        ) : (
          <RecommendationChat
            messages={chatState.messages}
            suggestedMessages={chatState.suggestedMessages}
            onSend={sendChatMessage}
            onOpenSwipeModal={() => setSwipeModalOpen(true)}
            showSwipeEntry={hasSwipeRecommendations}
            swipePrompt={chatState.ui?.swipePrompt || DEFAULT_SWIPE_PROMPT}
            loading={chatLoading || sendingMessage}
            disabled={respondingToRecommendation}
            placeholder="Try: I have 35 minutes and only dumbbells today."
          />
        )}

        {status ? <p className="muted" style={{ fontSize: '13px' }}>{status}</p> : null}
        {error ? <p className="error" style={{ fontSize: '13px', whiteSpace: 'pre-wrap' }}>{error}</p> : null}

        {hasSwipeRecommendations ? (
          <div className="hubSwipeLauncher">
            <div className="muted" style={{ fontSize: '13px' }}>
              {chatState.recommendation?.options.length} swipeable workout option
              {chatState.recommendation?.options.length === 1 ? '' : 's'} ready from chat.
            </div>
            <button type="button" className="secondary" onClick={() => setSwipeModalOpen(true)}>
              Open swipe modal
            </button>
          </div>
        ) : null}

        <div className="stack">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <div className="label">Past workouts context</div>
            <button
              type="button"
              className="secondary"
              style={{ minHeight: 'auto', padding: '6px 12px', fontSize: '12px' }}
              onClick={() => setShowPastWorkoutsPanel((prev) => !prev)}
              disabled={!connected || workouts.length === 0}
            >
              {showPastWorkoutsPanel ? 'Hide workouts' : 'Review + add context'}
            </button>
          </div>

          {showPastWorkoutsPanel ? (
            workouts.length === 0 ? (
              <p className="muted">No workouts yet. Sync Strava to add context.</p>
            ) : (
              <ul className="list">
                {workouts.slice(0, 8).map((workout) => {
                  const expanded = expandedWorkoutId === workout.id
                  const details = [formatKilometers(workout.strava?.distance), formatMinutes(workout.strava?.elapsedTime)]
                    .filter(Boolean)
                    .join(' • ')
                  return (
                    <li key={workout.id} className="listItem">
                      <div className="workoutHeader">
                        <div className="workoutMain">
                          <div className="workoutIcon">
                            <WorkoutIcon type={workout.strava?.type} size="small" />
                          </div>
                          <div>
                            <div className="workoutName">{workout.strava?.name ?? workout.id}</div>
                            <div className="muted">
                              {workout.strava?.startDate ? new Date(workout.strava.startDate).toLocaleString() : ''}
                            </div>
                            {details ? <div className="muted">{details}</div> : null}
                          </div>
                        </div>
                        <div className="stack" style={{ alignItems: 'flex-end', gap: 6 }}>
                          <div className={`contextStatus ${workout.context?.text ? 'contextStatus--added' : 'contextStatus--missing'}`}>
                            Context: {workout.context?.text ? 'Added' : 'Missing'}
                          </div>
                          <button
                            type="button"
                            className="secondary"
                            style={{ minHeight: 'auto', padding: '4px 8px', fontSize: '11px' }}
                            onClick={() => setExpandedWorkoutId(expanded ? null : workout.id)}
                          >
                            {expanded ? 'Close' : workout.context?.text ? 'Edit context' : 'Add context'}
                          </button>
                        </div>
                      </div>
                      {expanded && user ? (
                        <WorkoutContextEditor
                          uid={user.uid}
                          workoutId={workout.id}
                          workoutType={workout.strava?.type ?? null}
                          initialText={workout.context?.text ?? ''}
                          initialTags={workout.context?.tags ?? []}
                          initialVoiceUrl={workout.context?.voiceUrl ?? null}
                        />
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            )
          ) : (
            <p className="muted" style={{ fontSize: '13px' }}>
              Keep your coach personalized by adding context to recent workouts.
            </p>
          )}
        </div>

        {swipeModalOpen && hasSwipeRecommendations ? (
          <div
            className="hubModalOverlay"
            role="button"
            tabIndex={0}
            aria-label="Close workout swipe modal"
            onClick={() => setSwipeModalOpen(false)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                setSwipeModalOpen(false)
              }
            }}
          >
            <div
              className="hubModalCard"
              role="dialog"
              aria-modal="true"
              aria-label="Workout swipe modal"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <div className="stack" style={{ gap: 2 }}>
                  <div className="label">Swipe workout options</div>
                  <p className="muted" style={{ margin: 0, fontSize: '12px' }}>
                    Swipe right to save, left to pass.
                  </p>
                </div>
                <button type="button" className="secondary" onClick={() => setSwipeModalOpen(false)}>
                  Close
                </button>
              </div>
              <div className="stack" style={{ gap: 16 }}>
                {chatState.recommendation?.options.map((option, index) => (
                  <RecommendationCard
                    key={`${option.title}-${index}`}
                    option={option}
                    index={index}
                    onPass={() => void respondToRecommendation('pass', option)}
                    onAccept={() => void respondToRecommendation('accept', option)}
                    disabled={respondingToRecommendation}
                  />
                ))}
              </div>
            </div>
          </div>
        ) : null}

        {chatState.recommendation && chatState.recommendation.options.length > 0 ? (
          <div className="stack" style={{ marginTop: 8 }}>
            <div className="label">Safety checks</div>
            {chatState.recommendation.safetyChecks?.length ? (
              <ul className="whyList" style={{ marginTop: 6 }}>
                {chatState.recommendation.safetyChecks.map((item, index) => (
                  <li key={`${item}-${index}`}>{item}</li>
                ))}
              </ul>
            ) : (
              <p className="muted">No additional checks from coach chat.</p>
            )}
          </div>
        ) : null}

        <div className="stack">
          <div className="label">Saved workouts</div>
          {savedWorkouts.length === 0 ? (
            <p className="muted">Accepted workouts will appear here.</p>
          ) : (
            <ul className="list">
              {savedWorkouts.map((savedWorkout) => {
                const expanded = expandedSavedId === savedWorkout.id
                return (
                  <li key={savedWorkout.id} className="listItem">
                    <div className="savedWorkoutHeader">
                      <div className="workoutMain">
                        <div className="workoutIcon">
                          <WorkoutIcon type={savedWorkout.option?.type} size="small" />
                        </div>
                        <div>
                          <div className="workoutName">
                            {savedWorkout.option?.title ?? 'Saved workout'}
                          </div>
                          <div className="muted">
                            {savedWorkout.option?.duration ?? ''} • {savedWorkout.option?.intensity ?? ''}
                          </div>
                        </div>
                      </div>
                      <div className="stack" style={{ alignItems: 'flex-end', gap: 6 }}>
                        <div className="muted" style={{ fontSize: '12px' }}>
                          {savedWorkout.savedAt?.toDate
                            ? savedWorkout.savedAt.toDate().toLocaleString()
                            : 'Saved just now'}
                        </div>
                        <button
                          type="button"
                          className="secondary"
                          style={{ minHeight: 'auto', padding: '4px 8px', fontSize: '11px' }}
                          onClick={() => setExpandedSavedId(expanded ? null : savedWorkout.id)}
                        >
                          {expanded ? 'Close' : 'View details'}
                        </button>
                      </div>
                    </div>

                    {expanded && (
                      <div className="stack" style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)', gap: 12 }}>
                        <div className="optionSection">
                          <div className="sectionLabel">Main set</div>
                          <div className="sectionContent">{savedWorkout.option.mainSet}</div>
                        </div>
                        {savedWorkout.option.why && savedWorkout.option.why.length > 0 && (
                          <div className="optionSection">
                            <div className="sectionLabel">Rationale</div>
                            <ul className="whyList" style={{ marginTop: 8 }}>
                              {savedWorkout.option.why.map((reason, i) => (
                                <li key={i}>{reason}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </section>
    </main>
  )
}
