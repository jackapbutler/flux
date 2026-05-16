import { collection, limit, onSnapshot, orderBy, query } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { useEffect, useMemo, useState } from 'react'
import { WorkoutIcon } from '../components/WorkoutIcon'
import { useAuth } from '../lib/useAuth'
import { db, functions } from '../lib/firebase'
import type { PlanRangeUnit, TrainingPlanResponse, Workout } from '../lib/types'

const MIN_PARSED_DURATION_MINUTES = 15
const DEFAULT_DURATION_MINUTES = 60
const PLAN_EVENT_BASE_HOUR_UTC = 7
const PLAN_EVENT_OFFSET_HOURS = 2

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

function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
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

export function Plans() {
  const { user, profile } = useAuth()
  const [workouts, setWorkouts] = useState<Workout[]>([])
  const [plan, setPlan] = useState<TrainingPlanResponse | null>(null)
  const [planning, setPlanning] = useState(false)
  const [planRangeValue, setPlanRangeValue] = useState(4)
  const [planRangeUnit, setPlanRangeUnit] = useState<PlanRangeUnit>('weeks')
  const [status, setStatus] = useState<string | null>(null)
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
        snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Workout, 'id'>) })),
      )
    })
  }, [workoutsRef])

  const connected = Boolean(profile?.strava?.connected)

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

  return (
    <main className="stack">
      <section className="card hero">
        <h2>Plans</h2>
        <p className="muted">
          Build a multi-week or multi-month progression and export it to your calendar.
        </p>
      </section>

      <section className="card stack">
        <div className="stack" style={{ gap: 4 }}>
          <h2>Long-range planning</h2>
          <p className="muted" style={{ fontSize: '13px' }}>
            Choose a range, generate a plan from your recent training, and download as .ics.
          </p>
        </div>

        {!connected ? (
          <p className="muted">Connect Strava in Settings to unlock personalized plan generation.</p>
        ) : workouts.length === 0 ? (
          <p className="muted">Sync workout history first so Flux can build a safer progression.</p>
        ) : (
          <>
            <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
              <div className="row" style={{ gap: 8, flex: '1 1 auto' }}>
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
                  style={{ width: '70px' }}
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
                <button
                  type="button"
                  className="primary"
                  onClick={() => void generatePlan()}
                  disabled={planning}
                  style={{ whiteSpace: 'nowrap' }}
                >
                  {planning ? 'Generating...' : 'Generate plan'}
                </button>
              </div>
              {plan && (
                <button type="button" className="secondary" onClick={downloadPlanAsIcs}>
                  Download .ics
                </button>
              )}
            </div>

            {status ? <p className="muted" style={{ fontSize: '13px' }}>{status}</p> : null}
            {error ? <p className="error" style={{ fontSize: '13px' }}>{error}</p> : null}
          </>
        )}

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
      </section>
    </main>
  )
}
