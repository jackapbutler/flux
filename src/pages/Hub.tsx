import { collection, limit, onSnapshot, orderBy, query, type Timestamp } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { WorkoutContextEditor } from '../components/WorkoutContextEditor'
import { useAuth } from '../lib/useAuth'
import { db, functions } from '../lib/firebase'

type WorkoutRow = {
  id: string
  strava?: {
    type?: string | null
    name?: string | null
    startDate?: string | null
    distance?: number | null
    elapsedTime?: number | null
  }
  context?: { text?: string | null; voiceUrl?: string | null; updatedAt?: Timestamp | null }
}

type MaybeFirebaseError = { code?: string; message?: string }

function errorMessage(err: unknown): string {
  const e = err as MaybeFirebaseError
  const code = typeof e?.code === 'string' ? e.code : ''
  const msg = typeof e?.message === 'string' ? e.message : String(err)
  return code ? `${code}: ${msg}` : msg
}

function formatMinutes(seconds?: number | null): string {
  if (!seconds || seconds <= 0) return ''
  return `${Math.round(seconds / 60)} min`
}

function formatKilometers(meters?: number | null): string {
  if (!meters || meters <= 0) return ''
  return `${(meters / 1000).toFixed(1)} km`
}

function IconByType({ type }: { type?: string | null }) {
  const t = (type || '').toLowerCase()
  if (t.includes('run') || t.includes('running')) {
    return (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
        <path
          d="M5 16c1-2 3-3 5-3s4 1 6 2"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="17.5" cy="6.5" r="1.5" fill="currentColor" />
        <path
          d="M11 12l3-3 2 1"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  if (t.includes('ride') || t.includes('bike') || t.includes('cycling')) {
    return (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
        <circle cx="7.5" cy="15.5" r="2.5" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="17.5" cy="15.5" r="2.5" stroke="currentColor" strokeWidth="1.6" />
        <path
          d="M7.5 15.5L12 9l3 6"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  if (t.includes('swim') || t.includes('swimming')) {
    return (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
        <path
          d="M3 15c3-2 6-2 9 0s6 2 9 0"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M3 11c3-2 6-2 9 0s6 2 9 0"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity="0.7"
        />
      </svg>
    )
  }
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="8" r="2" fill="currentColor" />
      <path
        d="M6 20c1-3 3-5 6-5s5 2 6 5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function Hub() {
  const nav = useNavigate()
  const { user, profile } = useAuth()
  const [workouts, setWorkouts] = useState<WorkoutRow[]>([])
  const [syncing, setSyncing] = useState(false)
  const [recommending, setRecommending] = useState(false)
  const [recommendation, setRecommendation] = useState<string | null>(null)
  const [expandedWorkoutId, setExpandedWorkoutId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

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
        setError(`Workouts synced, but persona update failed: ${res.data.personaError}`)
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
      const fn = httpsCallable<undefined, { text: string }>(functions, 'recommendNextWorkout')
      const res = await fn()
      setRecommendation(res.data.text)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setRecommending(false)
    }
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

      <section className="grid">
        <section className="card stack">
          <h2>Plan next workout</h2>
          <p className="muted">Goal: {profile?.goalText ? `“${profile.goalText}”` : 'Not set yet'}</p>

          <div className="row">
            {!connected ? (
              <button type="button" className="secondary" onClick={() => nav('/onboarding')}>
                Connect Strava first
              </button>
            ) : (
              <button type="button" className="secondary" onClick={() => void sync()} disabled={syncing}>
                {syncing ? 'Syncing...' : 'Sync Strava'}
              </button>
            )}

            <button
              type="button"
              className="primary"
              onClick={() => void recommend()}
              disabled={recommending}
            >
              {recommending ? 'Generating...' : 'Recommend next workout'}
            </button>
          </div>

          {status ? <p className="muted">{status}</p> : null}
          {error ? <p className="error">{error}</p> : null}

          {recommendation ? (
            <div className="stack">
              <div className="label">Recommended session</div>
              <pre className="recommendation">{recommendation}</pre>
            </div>
          ) : null}
        </section>

        <section className="card stack">
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
                          <IconByType type={workout.strava?.type} />
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
                        <div className="muted">
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
                        initialText={workout.context?.text ?? ''}
                      />
                    ) : null}
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </section>
    </main>
  )
}
