import { collection, limit, onSnapshot, orderBy, query, type Timestamp } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { WorkoutContextEditor } from '../components/WorkoutContextEditor'
import { RecommendationCard } from '../components/RecommendationCard'
import { RecommendationChat } from '../components/RecommendationChat'
import { WorkoutIcon } from '../components/WorkoutIcon'
import { useAuth } from '../lib/useAuth'
import { db, functions } from '../lib/firebase'
import type { RecommendationResponse } from '../lib/types'

type WorkoutRow = {
  id: string
  strava?: {
    type?: string | null
    name?: string | null
    startDate?: string | null
    distance?: number | null
    elapsedTime?: number | null
  }
  context?: { text?: string | null; tags?: string[] | null; voiceUrl?: string | null; updatedAt?: Timestamp | null }
}

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
  const [workouts, setWorkouts] = useState<WorkoutRow[]>([])
  const [syncing, setSyncing] = useState(false)
  const [recommending, setRecommending] = useState(false)
  const [recommendation, setRecommendation] = useState<RecommendationResponse | null>(null)
  const [expandedWorkoutId, setExpandedWorkoutId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'plan' | 'workouts'>('plan')

  const workoutsRef = useMemo(() => {
    if (!user) return null
    return collection(db, 'users', user.uid, 'workouts')
  }, [user])

  useEffect(() => {
    if (!workoutsRef) return
    const q = query(workoutsRef, orderBy('strava.startDate', 'desc'), limit(25))
    return onSnapshot(q, (snap) => {
      setWorkouts(
        snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<WorkoutRow, 'id'>) })),
      )
    })
  }, [workoutsRef])

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

  const recommend = async () => {
    try {
      setError(null)
      setStatus(null)
      setRecommendation(null)
      setRecommending(true)
      const fn = httpsCallable<undefined, RecommendationResponse>(functions, 'recommendNextWorkout')
      const res = await fn()
      setRecommendation(res.data)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setRecommending(false)
    }
  }

  const refineRecommendation = async (
    userMessage: string,
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
  ) => {
    const fn = httpsCallable<
      { userMessage: string; conversationHistory: Array<{ role: string; content: string }> },
      RecommendationResponse
    >(functions, 'refineRecommendation')
    const res = await fn({
      userMessage,
      conversationHistory: history,
    })
    return res.data
  }

  return (
    <main className="stack">
      <section className="card hero">
        <h2>Your training hub</h2>
        <p className="muted">
          Sync Strava history, add short verbal or text context, and get a recommended next
          session based on your goals and recent load.
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
        <h2>Plan next workout</h2>
        <p className="muted">
          Goal & preferences: {profile?.goalText ? `"${profile.goalText}"` : 'Not set yet'}
        </p>
        <p className="muted">
          Environment constraints:{' '}
          {profile?.workoutEnvironmentConstraintsText
            ? `"${profile.workoutEnvironmentConstraintsText}"`
            : 'Not set yet'}
        </p>

        <div className="row">
          {!connected ? (
            <button type="button" className="secondary" onClick={() => nav('/onboarding')}>
              Connect Strava first
            </button>
          ) : (
            <button type="button" className="secondary" onClick={() => void sync()} disabled={syncing}>
              {syncing ? 'Syncing...' : workouts.length === 0 ? 'Sync Strava history' : 'Refresh sync'}
            </button>
          )}

          {workouts.length > 0 && (
            <button
              type="button"
              className="primary"
              onClick={() => void recommend()}
              disabled={recommending}
            >
              {recommending ? 'Generating...' : 'Recommend next workout'}
            </button>
          )}
        </div>

        {workouts.length === 0 && connected && !syncing && (
          <p className="muted" style={{ fontSize: '13px' }}>
            Sync your Strava history to give Flux context for your recommendations.
          </p>
        )}

        {status ? <p className="muted">{status}</p> : null}
        {error ? <p className="error">{error}</p> : null}

        {recommendation ? (
          <div className="stack">
            <div className="label">Recommended workouts</div>
            
            {recommendation.options.map((option, idx) => (
              <RecommendationCard key={idx} option={option} index={idx} />
            ))}

            <RecommendationChat
              onRefine={refineRecommendation}
              onUpdate={setRecommendation}
              disabled={false}
            />
          </div>
        ) : null}
      </section>

      <section className="card">
        <div className="tabNav">
          <button
            type="button"
            className={`tabButton ${activeTab === 'plan' ? 'active' : ''}`}
            onClick={() => setActiveTab('plan')}
          >
            Overview
          </button>
          <button
            type="button"
            className={`tabButton ${activeTab === 'workouts' ? 'active' : ''}`}
            onClick={() => setActiveTab('workouts')}
          >
            Recent workouts
          </button>
        </div>

        {activeTab === 'plan' && (
          <div className="tabContent stack">
            <h2>Overview</h2>
            <p className="muted">
              Sync Strava history, add context to workouts, and track your progress.
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
          </div>
        )}

        {activeTab === 'workouts' && (
          <div className="tabContent stack">
            <h2>Recent workouts</h2>
            {workouts.length === 0 ? (
              <p className="muted">
                No workouts yet. Connect Strava in <Link to="/onboarding">Settings</Link>, then
                sync to import your latest activities.
              </p>
            ) : (
              <ul className="list">
                {workouts.map((workout) => {
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
                              {workout.strava?.startDate
                                ? new Date(workout.strava.startDate).toLocaleString()
                                : ''}
                            </div>
                            {details ? <div className="muted">{details}</div> : null}
                          </div>
                        </div>

                        <div className="stack" style={{ alignItems: 'flex-end', gap: 6 }}>
                          <div
                            className={`contextStatus ${
                              workout.context?.text ? 'contextStatus--added' : 'contextStatus--missing'
                            }`}
                          >
                            Context: {workout.context?.text ? 'Added' : 'Missing'}
                          </div>
                          <button
                            type="button"
                            className="secondary"
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
            )}
          </div>
        )}
      </section>
    </main>
  )
}
