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

  const buildPersona = async () => {
    try {
      setError(null)
      const fn = httpsCallable<undefined, { text: string }>(functions, 'buildFitnessPersona')
      await fn()
    } catch (e) {
      setError(errorMessage(e))
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
          <p className="muted">No workouts yet. Sync from Strava.</p>
        ) : (
          <ul className="list">
            {workouts.map((w) => {
              const expanded = expandedWorkoutId === w.id
              return (
                <li key={w.id} className="listItem" style={{ padding: 12, borderRadius: 12, boxShadow: '0 6px 18px rgba(15,23,42,0.04)', marginBottom: 12, background: 'linear-gradient(180deg, rgba(255,255,255,0.8), rgba(250,250,250,0.9))' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                      <div style={{ width: 48, height: 48, borderRadius: 10, background: 'linear-gradient(135deg, var(--accent), #7dd3fc)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 700 }}>
                        {(w.strava?.type ?? 'W').slice(0, 1).toUpperCase()}
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
