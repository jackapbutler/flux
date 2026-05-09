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
        <p className="muted" style={{ marginTop: 6 }}>
          Persona: {profile?.fitnessPersonaText ? 'ready ✓' : 'not built yet'}
        </p>

        <div className="row" style={{ marginTop: 10 }}>
          <button
            type="button"
            className="secondary"
            onClick={() => void buildPersona()}
            disabled={!user}
          >
            {profile?.fitnessPersonaText ? 'Refresh persona' : 'Build persona'}
          </button>
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
                <li key={w.id} className="listItem" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <div>
                      <div>
                        {w.strava?.type ?? 'Workout'} — {w.strava?.name ?? w.id}
                      </div>
                      <div className="muted">
                        {w.strava?.startDate ? new Date(w.strava.startDate).toLocaleString() : ''}
                      </div>
                      <div className="muted">Context: {w.context?.text ? '✓' : '—'}</div>
                    </div>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => setExpandedWorkoutId(expanded ? null : w.id)}
                    >
                      {expanded ? 'Close' : w.context?.text ? 'Edit context' : 'Add context'}
                    </button>
                  </div>

                  {expanded && user ? (
                    <WorkoutContextEditor uid={user.uid} workoutId={w.id} initialText={w.context?.text ?? ''} />
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
