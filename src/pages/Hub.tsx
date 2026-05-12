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
import type {
  PlanRangeUnit,
  RecommendationResponse,
  SavedWorkout,
  TrainingPlanResponse,
  WorkoutOption,
} from '../lib/types'

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

type SavedWorkoutRow = SavedWorkout

type MaybeFirebaseError = { code?: string; message?: string; details?: unknown }
const MIN_PARSED_DURATION_MINUTES = 15
const DEFAULT_DURATION_MINUTES = 60
const PLAN_EVENT_BASE_HOUR_UTC = 7
const PLAN_EVENT_OFFSET_HOURS = 2

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

function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
}

function parseDurationMinutes(value: string): number {
  const lower = value.toLowerCase()
  const hours = lower.match(/(\d+)\s*(h|hr|hrs|hour|hours)/)
  const minutes = lower.match(/(\d+)\s*(m|min|mins|minute|minutes)/)
  const hourMinutes = hours ? Number(hours[1]) * 60 : 0
  const minuteMinutes = minutes ? Number(minutes[1]) : 0
  const total = hourMinutes + minuteMinutes
  if (total > 0) return total
  const firstNumber = lower.match(/(\d+)/)
  return firstNumber
    ? Math.max(MIN_PARSED_DURATION_MINUTES, Number(firstNumber[1]))
    : DEFAULT_DURATION_MINUTES
}

function toIcsUtcDateTime(date: string, hour: number, minute: number): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!parts) return ''
  const at = new Date(
    Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]), hour, minute, 0),
  )
  if (Number.isNaN(at.getTime())) return ''
  const y = at.getUTCFullYear()
  const mo = String(at.getUTCMonth() + 1).padStart(2, '0')
  const d = String(at.getUTCDate()).padStart(2, '0')
  const h = String(at.getUTCHours()).padStart(2, '0')
  const mi = String(at.getUTCMinutes()).padStart(2, '0')
  const s = String(at.getUTCSeconds()).padStart(2, '0')
  return `${y}${mo}${d}T${h}${mi}${s}Z`
}

function formatPlanDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return date
  return parsed.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export function Hub() {
  const nav = useNavigate()
  const { user, profile } = useAuth()
  const [workouts, setWorkouts] = useState<WorkoutRow[]>([])
  const [syncing, setSyncing] = useState(false)
  const [recommending, setRecommending] = useState(false)
  const [planning, setPlanning] = useState(false)
  const [respondingToRecommendation, setRespondingToRecommendation] = useState(false)
  const [recommendation, setRecommendation] = useState<RecommendationResponse | null>(null)
  const [currentOptionIndex, setCurrentOptionIndex] = useState(0)
  const [savedWorkouts, setSavedWorkouts] = useState<SavedWorkoutRow[]>([])
  const [plan, setPlan] = useState<TrainingPlanResponse | null>(null)
  const [planRangeValue, setPlanRangeValue] = useState(4)
  const [planRangeUnit, setPlanRangeUnit] = useState<PlanRangeUnit>('weeks')
  const [expandedWorkoutId, setExpandedWorkoutId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'plan' | 'workouts'>('plan')

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
        snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<WorkoutRow, 'id'>) })),
      )
    })
  }, [workoutsRef])

  useEffect(() => {
    if (!savedWorkoutsRef) return
    const q = query(savedWorkoutsRef, orderBy('savedAt', 'desc'), limit(10))
    return onSnapshot(q, (snap) => {
      setSavedWorkouts(
        snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<SavedWorkoutRow, 'id'>) })),
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

  const recommend = async () => {
    try {
      setError(null)
      setStatus(null)
      setRecommendation(null)
      setRecommending(true)
      const fn = httpsCallable<undefined, RecommendationResponse>(functions, 'recommendNextWorkout')
      const res = await fn()
      setRecommendation(res.data)
      setCurrentOptionIndex(0)
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

  const generatePlan = async () => {
    try {
      setError(null)
      setStatus(null)
      setPlanning(true)
      const fn = httpsCallable<
        { rangeValue: number; rangeUnit: PlanRangeUnit },
        TrainingPlanResponse
      >(functions, 'generateTrainingPlan')
      const res = await fn({ rangeValue: planRangeValue, rangeUnit: planRangeUnit })
      setPlan(res.data)
      setStatus(`Generated ${res.data.sessions.length} planned sessions`)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setPlanning(false)
    }
  }

  const downloadPlanAsIcs = () => {
    if (!plan || plan.sessions.length === 0) return

    const nowStamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
    const dayOffsets = new Map<string, number>()

    const events = plan.sessions
      .map((session, idx) => {
        const existing = dayOffsets.get(session.date) ?? 0
        dayOffsets.set(session.date, existing + 1)
        const startHour = PLAN_EVENT_BASE_HOUR_UTC + existing * PLAN_EVENT_OFFSET_HOURS
        const start = toIcsUtcDateTime(session.date, startHour, 0)
        if (!start) return null
        const durationMinutes = parseDurationMinutes(session.duration)
        const endDate = new Date(`${session.date}T${String(startHour).padStart(2, '0')}:00:00Z`)
        endDate.setUTCMinutes(endDate.getUTCMinutes() + durationMinutes)
        const end = toIcsUtcDateTime(
          endDate.toISOString().slice(0, 10),
          endDate.getUTCHours(),
          endDate.getUTCMinutes(),
        )
        if (!end) return null
        const summary = escapeIcsText(session.title)
        const description = escapeIcsText(
          [
            `Type: ${session.type || 'workout'}`,
            `Duration: ${session.duration}`,
            `Intensity: ${session.intensity}`,
            `Main set: ${session.mainSet}`,
            session.notes ? `Notes: ${session.notes}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        )
        return [
          'BEGIN:VEVENT',
          `UID:flux-${session.date}-${idx}@flux.app`,
          `DTSTAMP:${nowStamp}`,
          `DTSTART:${start}`,
          `DTEND:${end}`,
          `SUMMARY:${summary}`,
          `DESCRIPTION:${description}`,
          'END:VEVENT',
        ].join('\r\n')
      })
      .filter(Boolean)
      .join('\r\n')

    if (!events) return

    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Flux//Training Plan//EN',
      'CALSCALE:GREGORIAN',
      events,
      'END:VCALENDAR',
      '',
    ].join('\r\n')

    const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' })
    const href = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = href
    a.download = `flux-plan-${plan.range.startDateUtc}-to-${plan.range.endDateUtc}.ics`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(href)
  }

  const respondToRecommendation = async (decision: 'pass' | 'accept') => {
    if (!recommendation) return
    const option = recommendation.options[currentOptionIndex]
    if (!option) return

    try {
      setError(null)
      setStatus(null)
      setRespondingToRecommendation(true)

      const fn = httpsCallable<
        { decision: 'pass' | 'accept'; option: WorkoutOption },
        { saved: boolean; preferenceSummary: string }
      >(functions, 'respondToWorkoutRecommendation')

      const res = await fn({ decision, option })
      const remainingCount = recommendation.options.length - (currentOptionIndex + 1)

      if (decision === 'accept') {
        setRecommendation(null)
        setCurrentOptionIndex(0)
        setStatus('Workout accepted and saved. Flux persona updated with your preference.')
      } else if (remainingCount > 0) {
        setCurrentOptionIndex((prev) => prev + 1)
        setStatus('Passed. Showing another option and updating your preference profile.')
      } else {
        setRecommendation(null)
        setCurrentOptionIndex(0)
        setStatus('Passed. No more options left in this set. Generate a new recommendation anytime.')
      }

      if (!res.data.saved && decision === 'accept') {
        setStatus('Workout accepted. Saved workout list will update shortly.')
      }
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setRespondingToRecommendation(false)
    }
  }

  const currentRecommendationOption = recommendation?.options[currentOptionIndex] ?? null

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

        {workouts.length > 0 && (
          <div className="row planRangeControls">
            <span className="muted">Plan range</span>
            <input
              type="number"
              min={1}
              max={planRangeUnit === 'weeks' ? 24 : 12}
              value={planRangeValue}
              onChange={(e) => {
                const next = Number(e.target.value)
                setPlanRangeValue(Number.isFinite(next) && next > 0 ? Math.floor(next) : 1)
                setPlan(null)
              }}
              className="planRangeInput"
              disabled={planning}
            />
            <select
              value={planRangeUnit}
              onChange={(e) => {
                setPlanRangeUnit(e.target.value as PlanRangeUnit)
                setPlan(null)
              }}
              className="planRangeSelect"
              disabled={planning}
            >
              <option value="weeks">Weeks</option>
              <option value="months">Months</option>
            </select>
            <button type="button" className="primary" onClick={() => void generatePlan()} disabled={planning}>
              {planning ? 'Generating plan...' : 'Generate plan'}
            </button>
            <button type="button" className="secondary" onClick={downloadPlanAsIcs} disabled={!plan}>
              Download Google Calendar (.ics)
            </button>
          </div>
        )}

        {workouts.length === 0 && connected && !syncing && (
          <p className="muted" style={{ fontSize: '13px' }}>
            Sync your Strava history to give Flux context for your recommendations.
          </p>
        )}

        {status ? <p className="muted">{status}</p> : null}
        {error ? <p className="error">{error}</p> : null}

        {recommendation ? (
          <div className="stack">
            <div className="label">Recommended workout</div>

            {currentRecommendationOption ? (
              <>
                <p className="muted" style={{ fontSize: '12px' }}>
                  Option {currentOptionIndex + 1} of {recommendation.options.length}
                </p>
                <RecommendationCard
                  option={currentRecommendationOption}
                  index={currentOptionIndex}
                  onPass={() => void respondToRecommendation('pass')}
                  onAccept={() => void respondToRecommendation('accept')}
                  disabled={respondingToRecommendation}
                />
              </>
            ) : null}

            <RecommendationChat
              onRefine={refineRecommendation}
              onUpdate={(next) => {
                setRecommendation(next)
                setCurrentOptionIndex(0)
              }}
              disabled={respondingToRecommendation}
            />
          </div>
        ) : null}

        {plan ? (
          <div className="stack">
            <div className="label">Long-range plan</div>
            <p className="muted">
              {plan.range.value} {plan.range.unit} • {plan.range.startDateUtc} to {plan.range.endDateUtc}
            </p>
            {plan.safetyChecks.length > 0 ? (
              <ul className="whyList">
                {plan.safetyChecks.map((check, idx) => (
                  <li key={idx}>{check}</li>
                ))}
              </ul>
            ) : null}
            <ul className="planList">
              {plan.sessions.map((session, idx) => (
                <li key={`${session.date}-${idx}`} className="listItem">
                  <div className="workoutHeader">
                    <div className="workoutMain">
                      <div className="workoutIcon">
                        <WorkoutIcon type={session.type} size="small" />
                      </div>
                      <div>
                        <div className="workoutName">{session.title}</div>
                        <div className="muted">{formatPlanDate(session.date)}</div>
                      </div>
                    </div>
                  </div>
                  <div className="optionMetrics" style={{ marginTop: 12 }}>
                    <div className="metricSmall">
                      <span className="optionMetricLabel">Duration</span>
                      <span className="optionMetricValue">{session.duration}</span>
                    </div>
                    <div className="metricSmall">
                      <span className="optionMetricLabel">Intensity</span>
                      <span className="optionMetricValue">{session.intensity}</span>
                    </div>
                  </div>
                  <div className="optionSection" style={{ marginTop: 12 }}>
                    <div className="sectionLabel">Main set</div>
                    <div className="sectionContent">{session.mainSet}</div>
                  </div>
                  {session.notes ? (
                    <div className="optionSection" style={{ marginTop: 12 }}>
                      <div className="sectionLabel">Notes</div>
                      <div className="sectionContent">{session.notes}</div>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="stack">
          <div className="label">Saved workouts</div>
          {savedWorkouts.length === 0 ? (
            <p className="muted">Accepted workouts will appear here.</p>
          ) : (
            <ul className="list">
              {savedWorkouts.map((savedWorkout) => (
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
                    <div className="muted" style={{ fontSize: '12px' }}>
                      {savedWorkout.savedAt?.toDate
                        ? savedWorkout.savedAt.toDate().toLocaleString()
                        : 'Saved just now'}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
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
