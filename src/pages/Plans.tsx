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
  return firstNumber ? Math.max(MIN_PARSED_DURATION_MINUTES, Number(firstNumber[1])) : DEFAULT_DURATION_MINUTES
}

function toIcsUtcDateTime(date: string, hour: number, minute: number): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!parts) return ''
  const at = new Date(Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]), hour, minute, 0))
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
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;')
}

function formatPlanDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return date
  return parsed.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

type MaybeFirebaseError = { code?: string; message?: string; details?: unknown }

function errorMessage(err: unknown): string {
  const e = err as MaybeFirebaseError
  return typeof e?.message === 'string' ? e.message : String(err)
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

  const workoutsRef = useMemo(() => user ? collection(db, 'users', user.uid, 'workouts') : null, [user])

  useEffect(() => {
    if (!workoutsRef) return
    const q = query(workoutsRef, orderBy('strava.startDate', 'desc'), limit(25))
    return onSnapshot(q, (snap) => setWorkouts(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Workout, 'id'>) }))))
  }, [workoutsRef])

  const connected = Boolean(profile?.strava?.connected)

  const generatePlan = async () => {
    try {
      setError(null); setStatus(null); setPlanning(true)
      const fn = httpsCallable<{ rangeValue: number; rangeUnit: PlanRangeUnit }, TrainingPlanResponse>(functions, 'generateTrainingPlan')
      const res = await fn({ rangeValue: planRangeValue, rangeUnit: planRangeUnit })
      setPlan(res.data)
      setStatus(`Generated ${res.data.sessions.length} sessions`)
    } catch (e) { setError(errorMessage(e)) } finally { setPlanning(false) }
  }

  const downloadPlanAsIcs = () => {
    if (!plan || plan.sessions.length === 0) return
    const nowStamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
    const dayOffsets = new Map<string, number>()
    const events = plan.sessions.map((session, idx) => {
      const existing = dayOffsets.get(session.date) ?? 0
      dayOffsets.set(session.date, existing + 1)
      const startHour = PLAN_EVENT_BASE_HOUR_UTC + existing * PLAN_EVENT_OFFSET_HOURS
      const start = toIcsUtcDateTime(session.date, startHour, 0)
      if (!start) return null
      const durationMinutes = parseDurationMinutes(session.duration)
      const endDate = new Date(`${session.date}T${String(startHour).padStart(2, '0')}:00:00Z`)
      endDate.setUTCMinutes(endDate.getUTCMinutes() + durationMinutes)
      const end = toIcsUtcDateTime(endDate.toISOString().slice(0, 10), endDate.getUTCHours(), endDate.getUTCMinutes())
      if (!end) return null
      const summary = escapeIcsText(session.title)
      const description = escapeIcsText([`Type: ${session.type || 'workout'}`, `Duration: ${session.duration}`, `Intensity: ${session.intensity}`, `Main set: ${session.mainSet}`, session.notes ? `Notes: ${session.notes}` : ''].filter(Boolean).join('\n'))
      return [`BEGIN:VEVENT`, `UID:flux-${session.date}-${idx}@flux.app`, `DTSTAMP:${nowStamp}`, `DTSTART:${start}`, `DTEND:${end}`, `SUMMARY:${summary}`, `DESCRIPTION:${description}`, `END:VEVENT`].join('\r\n')
    }).filter(Boolean).join('\r\n')
    if (!events) return
    const ics = [`BEGIN:VCALENDAR`, `VERSION:2.0`, `PRODID:-//Flux//Training Plan//EN`, `CALSCALE:GREGORIAN`, events, `END:VCALENDAR`, ''].join('\r\n')
    const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' })
    const href = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = href; a.download = `flux-plan.ics`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(href)
  }

  return (
    <div className="stack">
      <header className="stack" style={{ gap: 4 }}>
        <h2 style={{ fontSize: '1.25rem' }}>Long-range Planning</h2>
        <p className="muted">Build a multi-week progression and sync it to your calendar.</p>
      </header>

      {!connected ? (
        <section className="card stack" style={{ alignItems: 'center', textAlign: 'center', padding: '40px 24px' }}>
          <p className="muted">Connect Strava in Settings to unlock personalized plan generation.</p>
        </section>
      ) : (
        <section className="card stack">
          <div className="rec-label">Plan Duration</div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
            <div className="row" style={{ gap: 8, flex: '1' }}>
              <input type="number" min={1} max={12} value={planRangeValue} onChange={(e) => setPlanRangeValue(Number(e.target.value))} style={{ width: '80px' }} disabled={planning} />
              <select value={planRangeUnit} onChange={(e) => setPlanRangeUnit(e.target.value as PlanRangeUnit)} style={{ flex: 1 }} disabled={planning}>
                <option value="weeks">Weeks</option>
                <option value="months">Months</option>
              </select>
            </div>
            <button className="primary" onClick={() => void generatePlan()} disabled={planning} style={{ minWidth: '140px' }}>
              {planning ? 'Generating...' : 'Generate Plan'}
            </button>
          </div>

          {plan && (
            <button className="secondary" onClick={downloadPlanAsIcs} style={{ width: '100%' }}>Download Calendar (.ics)</button>
          )}
          {status && <p className="muted" style={{ textAlign: 'center', fontSize: '12px', color: 'var(--success)' }}>{status}</p>}
          {error && <p className="error" style={{ textAlign: 'center', fontSize: '12px' }}>{error}</p>}
        </section>
      )}

      {plan && (
        <div className="stack">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ fontSize: '1.1rem' }}>Plan Overview</h2>
            <div className="badge">{plan.range.value} {plan.range.unit}</div>
          </div>
          
          {plan.safetyChecks.length > 0 && (
            <div className="card stack" style={{ padding: '16px', background: 'rgba(245, 158, 11, 0.05)', borderColor: 'rgba(245, 158, 11, 0.1)' }}>
               <div className="rec-label" style={{ color: 'var(--accent-2)' }}>Safety Guidelines</div>
               <ul className="whyList">
                 {plan.safetyChecks.map((c, i) => <li key={i}>{c}</li>)}
               </ul>
            </div>
          )}

          <div className="stack">
            {plan.sessions.map((s, i) => (
              <div key={i} className="card stack" style={{ padding: '20px' }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div className="row">
                    <div className="rec-icon" style={{ width: '36px', height: '36px' }}><WorkoutIcon type={s.type} /></div>
                    <div className="stack" style={{ gap: 2 }}>
                      <div className="rec-value">{s.title}</div>
                      <div className="muted small">{formatPlanDate(s.date)}</div>
                    </div>
                  </div>
                  <div className="badge">{s.duration}</div>
                </div>
                <div className="stack" style={{ gap: 8, marginTop: '8px' }}>
                  <div className="rec-label">Main Set</div>
                  <div className="sectionContent" style={{ fontSize: '0.8125rem' }}>{s.mainSet}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
