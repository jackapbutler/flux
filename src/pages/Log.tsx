import { collection, limit, onSnapshot, orderBy, query } from 'firebase/firestore'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { WorkoutContextEditor } from '../components/WorkoutContextEditor'
import { WorkoutIcon } from '../components/WorkoutIcon'
import { useAuth } from '../lib/useAuth'
import { db } from '../lib/firebase'
import type { Workout } from '../lib/types'

function formatMinutes(seconds?: number | null): string {
  if (!seconds || seconds <= 0) return ''
  return `${Math.round(seconds / 60)} min`
}

function formatKilometers(meters?: number | null): string {
  if (!meters || meters <= 0) return ''
  return `${(meters / 1000).toFixed(1)} km`
}

export function Log() {
  const { user } = useAuth()
  const [workouts, setWorkouts] = useState<Workout[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [showNoContextOnly, setShowNoContextOnly] = useState(false)

  const workoutsRef = useMemo(() => user ? collection(db, 'users', user.uid, 'workouts') : null, [user])

  useEffect(() => {
    if (!workoutsRef) return
    const q = query(workoutsRef, orderBy('strava.startDate', 'desc'), limit(50))
    return onSnapshot(q, (snap) => setWorkouts(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Workout, 'id'>) }))))
  }, [workoutsRef])

  const filteredWorkouts = useMemo(
    () =>
      showNoContextOnly
        ? workouts.filter((workout) => !workout.context?.text?.trim())
        : workouts,
    [showNoContextOnly, workouts],
  )

  const noContextCount = useMemo(() => workouts.filter((workout) => !workout.context?.text?.trim()).length, [workouts])

  return (
    <div className="stack">
      <header className="stack" style={{ gap: 4 }}>
        <h2 style={{ fontSize: '1.25rem' }}>Performance Log</h2>
        <p className="muted">Enrich your activities with context for better coaching.</p>
      </header>

      {workouts.length > 0 && (
        <section className="row" style={{ gap: 8 }}>
          <button
            className={showNoContextOnly ? 'secondary' : 'primary'}
            onClick={() => setShowNoContextOnly(false)}
          >
            All ({workouts.length})
          </button>
          <button
            className={showNoContextOnly ? 'primary' : 'secondary'}
            onClick={() => setShowNoContextOnly(true)}
          >
            Needs Context ({noContextCount})
          </button>
        </section>
      )}

      {workouts.length === 0 ? (
        <section className="card stack" style={{ alignItems: 'center', textAlign: 'center', padding: '40px 24px' }}>
          <p className="muted">No workouts found. Sync your Strava history in Settings.</p>
          <Link to="/onboarding" style={{ color: 'var(--accent)', fontWeight: 600, textDecoration: 'none' }}>Go to Settings</Link>
        </section>
      ) : filteredWorkouts.length === 0 ? (
        <section className="card stack" style={{ alignItems: 'center', textAlign: 'center', padding: '24px' }}>
          <p className="muted" style={{ margin: 0 }}>All visible workouts already have context.</p>
        </section>
      ) : (
        <div className="stack">
          {filteredWorkouts.map((w) => {
            const expanded = expandedId === w.id
            const details = [formatKilometers(w.strava?.distance), formatMinutes(w.strava?.elapsedTime)].filter(Boolean).join(' • ')
            
            return (
              <div key={w.id} className="card stack" style={{ padding: '20px' }}>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div className="row">
                    <div className="rec-icon" style={{ width: '40px', height: '40px' }}><WorkoutIcon type={w.strava?.type} /></div>
                    <div className="stack" style={{ gap: 2 }}>
                      <div className="rec-value">{w.strava?.name || 'Workout'}</div>
                      <div className="muted small">
                        {w.strava?.startDate ? new Date(w.strava.startDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}
                        {details && ` • ${details}`}
                      </div>
                    </div>
                  </div>
                  <div className={`badge ${w.context?.text ? '' : 'muted'}`} style={{ fontSize: '0.6rem', background: w.context?.text ? 'var(--accent-soft)' : 'var(--surface-2)', color: w.context?.text ? 'var(--accent)' : 'var(--muted)' }}>
                    {w.context?.text ? 'CONTEXT ADDED' : 'NO CONTEXT'}
                  </div>
                </div>

                <div className="row" style={{ marginTop: '4px' }}>
                  <button className="secondary small" style={{ flex: 1 }} onClick={() => setExpandedId(expanded ? null : w.id)}>
                    {expanded ? 'Close' : w.context?.text ? 'Edit Context' : 'Add Context ✦'}
                  </button>
                </div>

                {expanded && user && (
                  <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid var(--border)' }}>
                    <WorkoutContextEditor
                      uid={user.uid}
                      workoutId={w.id}
                      workoutType={w.strava?.type ?? null}
                      initialText={w.context?.text ?? ''}
                      initialTags={w.context?.tags ?? []}
                      initialVoiceUrl={w.context?.voiceUrl ?? null}
                    />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
