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
  const [expandedWorkoutId, setExpandedWorkoutId] = useState<string | null>(null)

  const workoutsRef = useMemo(() => {
    if (!user) return null
    return collection(db, 'users', user.uid, 'workouts')
  }, [user])

  useEffect(() => {
    if (!workoutsRef) return
    const q = query(workoutsRef, orderBy('strava.startDate', 'desc'), limit(50))
    return onSnapshot(q, (snap) => {
      setWorkouts(
        snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Workout, 'id'>) })),
      )
    })
  }, [workoutsRef])

  return (
    <main className="stack">
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
      </section>
    </main>
  )
}
