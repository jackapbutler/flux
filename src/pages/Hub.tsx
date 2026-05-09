import { collection, limit, onSnapshot, orderBy, query, type Timestamp } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
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

type MaybeFirebaseError = { code?: string; message?: string; details?: unknown }

function errorMessage(err: unknown): string {
  const e = err as MaybeFirebaseError
  const code = typeof e?.code === 'string' ? e.code : ''
  const msg = typeof e?.message === 'string' ? e.message : String(err)
  return code ? `${code}: ${msg}` : msg
}

export function Hub() {
  function IconByType({ type }: { type?: string | null }) {
    const t = (type || '').toLowerCase()
    if (t.includes('run') || t.includes('running')) {
      return (
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M5 16c1-2 3-3 5-3s4 1 6 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="17.5" cy="6.5" r="1.5" fill="currentColor" />
          <path d="M11 12l3-3 2 1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    }
    if (t.includes('ride') || t.includes('bike') || t.includes('cycling')) {
      return (
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="7.5" cy="15.5" r="2.5" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="17.5" cy="15.5" r="2.5" stroke="currentColor" strokeWidth="1.6" />
          <path d="M7.5 15.5L12 9l3 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    }
    if (t.includes('swim') || t.includes('swimming')) {
      return (
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M3 15c3-2 6-2 9 0s6 2 9 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M3 11c3-2 6-2 9 0s6 2 9 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" opacity="0.7" />
        </svg>
      )
    }
    if (t.includes('weight') || t.includes('strength') || t.includes('gym')) {
      return (
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M2 12h3v2H2zM19 12h3v2h-3z" fill="currentColor" />
          <rect x="7" y="9" width="10" height="6" rx="1" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      )
    }
    // default generic icon
    return (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="12" cy="8" r="2" fill="currentColor" />
        <path d="M6 20c1-3 3-5 6-5s5 2 6 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  const { user, profile } = useAuth()
  const [workouts, setWorkouts] = useState<WorkoutRow[]>([])
  const [syncing, setSyncing] = useState(false)
  const [recommending, setRecommending] = useState(false)
  const [recommendation, setRecommendation] = useState<string | null>(null)
  const [expandedWorkoutId, setExpandedWorkoutId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

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

  const sync = async () => {
    try {
      setError(null)
      setSyncing(true)
      const fn = httpsCallable<undefined, { upserted: number }>(functions, 'stravaSyncRecent')
      const res = await fn()
      setError(`Synced ${res.data.upserted} workouts`)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setSyncing(false)
    }
  }

  const recommend = async () => {
    try {
      setError(null)
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

  const connected = Boolean(profile?.strava?.connected)

  return (
    <main className="grid">
      <section className="card">
        <h2>Hub</h2>
        <p className="muted">Goal: {profile?.goalText ? `“${profile.goalText}”` : 'not set'}</p>

        <div className="row" style={{ marginTop: 10 }}>
          {!connected ? (
            <p className="muted">
              Connect Strava in <Link to="/onboarding">Settings</Link>.
            </p>
          ) : (
            <button type="button" onClick={() => void sync()} disabled={syncing}>
              {syncing ? 'Syncing…' : 'Sync Strava'}
            </button>
          )}

          <button
            type="button"
            className="primary"
            onClick={() => void recommend()}
            disabled={recommending}
          >
            {recommending ? 'Thinking…' : 'Recommend next workout'}
          </button>
        </div>

        {error ? (
          <details className="errorBox" open style={{ marginTop: 12 }}>
            <summary>Something went wrong</summary>
            <div className="error">{error}</div>
            <div className="muted" style={{ marginTop: 8 }}>
              If Strava sync keeps failing, try reconnecting Strava in Settings.
            </div>
          </details>
        ) : null}

        {recommendation ? (
          <div style={{ marginTop: 12 }}>
            <div className="label">Next workout</div>
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                margin: 0,
                padding: 12,
                border: '1px solid var(--border)',
                borderRadius: 14,
                background: 'rgba(255,255,255,0.65)',
              }}
            >
              {recommendation}
            </pre>
          </div>
        ) : null}
      </section>

      <section className="card">
        <h2>Workouts</h2>
        {workouts.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: 20 }}>
            <svg width="160" height="100" viewBox="0 0 160 100" xmlns="http://www.w3.org/2000/svg">
              <rect width="160" height="100" rx="12" fill="url(#g)" />
              <defs>
                <linearGradient id="g" x1="0" x2="1">
                  <stop offset="0" stopColor="#06b6d4" stopOpacity="0.12" />
                  <stop offset="1" stopColor="#3b82f6" stopOpacity="0.08" />
                </linearGradient>
              </defs>
              <g fill="none" stroke="#fff" strokeOpacity="0.9">
                <path d="M30 70c20-18 50-18 80 0" strokeOpacity="0.6" />
                <circle cx="48" cy="46" r="8" />
                <rect x="92" y="36" width="18" height="18" rx="4" />
                <path d="M120 50v10" />
              </g>
            </svg>

            <div style={{ textAlign: 'center', maxWidth: 420 }}>
              <div style={{ fontWeight: 700, fontSize: 18 }}>No workouts yet</div>
              <div className="muted" style={{ marginTop: 6 }}>
                Flux supports all fitness types. Connect Strava to import any logged workouts — runs, rides, swims, gym sessions, classes — then add context so AI can provide tailored guidance.
              </div>
              {!connected ? (
                <div style={{ marginTop: 12 }}>
                  <button type="button" onClick={() => void (window.location.href = '/onboarding')}>Connect Strava</button>
                </div>
              ) : (
                <div style={{ marginTop: 12 }}>
                  <button type="button" onClick={() => void sync()} disabled={syncing}>{syncing ? 'Syncing…' : 'Sync Strava'}</button>
                </div>
              )}
            </div>
          </div>
        ) : (
          <ul className="list">
            {workouts.map((w) => {
              const expanded = expandedWorkoutId === w.id
              return (
                <li key={w.id} className="listItem" style={{ padding: 12, borderRadius: 12, boxShadow: '0 6px 18px rgba(15,23,42,0.04)', marginBottom: 12, background: 'linear-gradient(180deg, rgba(255,255,255,0.8), rgba(250,250,250,0.9))' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                      <div style={{ width: 48, height: 48, borderRadius: 10, background: 'linear-gradient(135deg, var(--accent), var(--accent-2))', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 700 }}>
                        <IconByType type={w.strava?.type} />
                      </div>
                      <div>
                        <div style={{ fontWeight: 600 }}>{w.strava?.name ?? w.id}</div>
                        <div className="muted" style={{ fontSize: 12 }}>{w.strava?.startDate ? new Date(w.strava.startDate).toLocaleString() : ''}</div>
                        <div className="muted" style={{ fontSize: 12 }}>{w.strava?.distance ? `${(w.strava.distance / 1000).toFixed(1)} km • ` : ''}{w.strava?.elapsedTime ? `${Math.round(w.strava.elapsedTime / 60)} min` : ''}</div>
                      </div>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
                      <div className="muted" style={{ fontSize: 12 }}>Context: {w.context?.text ? '✓' : '—'}</div>
                      <button type="button" className="secondary" onClick={() => setExpandedWorkoutId(expanded ? null : w.id)}>
                        {expanded ? 'Close' : w.context?.text ? 'Edit' : 'Add context'}
                      </button>
                    </div>
                  </div>

                  {expanded && user ? (
                    <div style={{ marginTop: 12 }}>
                      <WorkoutContextEditor uid={user.uid} workoutId={w.id} initialText={w.context?.text ?? ''} />
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </main>
  )
}
