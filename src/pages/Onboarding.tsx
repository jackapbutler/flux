import { doc, serverTimestamp, setDoc } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../lib/useAuth'
import { db, functions } from '../lib/firebase'

function errorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const message = 'message' in err && typeof (err as { message?: unknown }).message === 'string' ? (err as { message: string }).message : String(err)
    const details = 'details' in err ? (err as { details?: unknown }).details : null
    if (details && typeof details === 'object') {
      const status = 'status' in details && typeof (details as { status?: unknown }).status === 'number' ? (details as { status: number }).status : null
      const step = 'step' in details && typeof (details as { step?: unknown }).step === 'string' ? (details as { step: string }).step : null
      const body = 'body' in details && typeof (details as { body?: unknown }).body === 'string' ? (details as { body: string }).body : null
      const meta = [step ? `step=${step}` : null, status ? `status=${status}` : null, body].filter(Boolean).join(' | ')
      return meta ? `${message}\n${meta}` : message
    }
    return message
  }
  return String(err)
}

export function Onboarding() {
  const nav = useNavigate()
  const [params] = useSearchParams()
  const { user, profile } = useAuth()
  const [goalDraft, setGoalDraft] = useState<string | null>(null)
  const [environmentDraft, setEnvironmentDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const goalPreferencesText = goalDraft ?? profile?.goalText ?? ''
  const workoutEnvironmentConstraintsText = environmentDraft ?? profile?.workoutEnvironmentConstraintsText ?? ''
  const [goalSaved, setGoalSaved] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const connected = Boolean(profile?.strava?.connected)
  const hasSavedGoal = Boolean(profile?.goalText?.trim())
  const stravaState = params.get('strava')
  const stravaStatusMessage = stravaState === 'denied' ? 'Strava authorization was canceled.' : stravaState === 'scope_missing' ? 'Strava did not grant required scopes.' : stravaState === 'callback_error' ? 'Strava callback failed.' : stravaState === 'connected' ? 'Strava connected.' : null

  const userRef = useMemo(() => user ? doc(db, 'users', user.uid) : null, [user])

  const saveGoal = async () => {
    if (!userRef) return
    try {
      setError(null); setGoalSaved(null); setSaving(true)
      await setDoc(userRef, {
        goalText: goalPreferencesText.trim(),
        workoutEnvironmentConstraintsText: workoutEnvironmentConstraintsText.trim(),
        updatedAt: serverTimestamp(),
      }, { merge: true })
      setGoalDraft(null); setEnvironmentDraft(null); setGoalSaved('Settings saved')
    } catch (e) { setError(errorMessage(e)) } finally { setSaving(false) }
  }

  const connectStrava = async () => {
    try {
      setError(null)
      const fn = httpsCallable<undefined, { url: string }>(functions, 'stravaAuthUrl')
      const res = await fn()
      window.location.assign(res.data.url)
    } catch (e) { setError(errorMessage(e)) }
  }

  const syncAndPersona = async () => {
    try {
      setError(null); setSyncing(true)
      const fn = httpsCallable<undefined, { upserted: number }>(functions, 'stravaSyncRecent')
      await fn()
    } catch (e) { setError(errorMessage(e)) } finally { setSyncing(false) }
  }

  useEffect(() => {
    if (user && stravaState === 'connected' && connected) {
      void syncAndPersona()
    }
  }, [connected, stravaState, user?.uid])

  return (
    <div className="stack">
      <section className="card hero stack">
        <h2>Settings</h2>
        <p className="muted" style={{ color: 'rgba(255,255,255,0.7)' }}>Tailor your Flux experience.</p>
      </section>

      <section className="stack">
        <div className="card stack">
          <div className="rec-label">Performance Profile</div>
          <p className="muted">Flux uses your goals and constraints to shape proactive advice.</p>

          <label className="field">
            <span>Core Goal</span>
            <input value={goalPreferencesText} onChange={(e) => setGoalDraft(e.target.value)} placeholder="e.g. Build aerobic base, improve deadlift" />
          </label>
          <label className="field">
            <span>Environment</span>
            <input value={workoutEnvironmentConstraintsText} onChange={(e) => setEnvironmentDraft(e.target.value)} placeholder="e.g. Dumbbells only, short lunch sessions" />
          </label>

          <button className="primary" onClick={() => void saveGoal()} disabled={saving}>
            {saving ? 'Saving...' : 'Save Profile'}
          </button>
          {goalSaved && <p className="muted" style={{ textAlign: 'center', fontSize: '12px', color: 'var(--success)' }}>{goalSaved}</p>}
        </div>

        <div className="card stack">
          <div className="rec-label">Data Integration</div>
          <p className="muted">Connect Strava to import your performance history.</p>

          {connected ? (
            <div className="stack">
              <div className="row" style={{ justifyContent: 'center' }}>
                <div className="badge" style={{ background: 'var(--success)', color: 'white', borderColor: 'transparent' }}>STRAVA CONNECTED</div>
              </div>
              <button className="secondary" onClick={() => void syncAndPersona()} disabled={syncing}>
                {syncing ? 'Syncing...' : 'Force Data Sync'}
              </button>
            </div>
          ) : (
            <button className="primary" onClick={() => void connectStrava()}>Connect Strava</button>
          )}
          {stravaStatusMessage && <p className="muted" style={{ textAlign: 'center', fontSize: '12px' }}>{stravaStatusMessage}</p>}
        </div>
      </section>

      {!hasSavedGoal && (
        <button className="secondary" onClick={() => nav('/app')}>Skip for now</button>
      )}

      {error && <div className="error" style={{ textAlign: 'center' }}>{error}</div>}
    </div>
  )
}
