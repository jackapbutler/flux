import { doc, serverTimestamp, setDoc } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../lib/useAuth'
import { db, functions } from '../lib/firebase'

function errorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const message =
      'message' in err && typeof (err as { message?: unknown }).message === 'string'
        ? (err as { message: string }).message
        : String(err)
    const details =
      'details' in err ? (err as { details?: unknown }).details : null
    if (details && typeof details === 'object') {
      const status =
        'status' in details && typeof (details as { status?: unknown }).status === 'number'
          ? (details as { status: number }).status
          : null
      const step =
        'step' in details && typeof (details as { step?: unknown }).step === 'string'
          ? (details as { step: string }).step
          : null
      const body =
        'body' in details && typeof (details as { body?: unknown }).body === 'string'
          ? (details as { body: string }).body
          : null
      const meta = [step ? `step=${step}` : null, status ? `status=${status}` : null, body]
        .filter(Boolean)
        .join(' | ')
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
  const workoutEnvironmentConstraintsText =
    environmentDraft ?? profile?.workoutEnvironmentConstraintsText ?? ''
  const [goalSaved, setGoalSaved] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const connected = Boolean(profile?.strava?.connected)
  const hasSavedGoal = Boolean(profile?.goalText?.trim())
  const stravaState = params.get('strava')
  const stravaJustConnected = stravaState === 'connected'
  const stravaStatusMessage =
    stravaState === 'denied'
      ? 'Strava authorization was canceled. Please try again.'
      : stravaState === 'scope_missing'
        ? 'Strava did not grant required scopes (read, activity:read_all). Please authorize both scopes.'
        : stravaState === 'callback_error'
          ? 'Strava callback was incomplete. Please reconnect.'
          : stravaJustConnected
            ? 'Strava connected. Pulling workouts now.'
            : null

  const userRef = useMemo(() => {
    if (!user) return null
    return doc(db, 'users', user.uid)
  }, [user])

  const saveGoal = async () => {
    if (!userRef) {
      setError('You need to be signed in to save your goal and preferences.')
      return
    }
    try {
      setError(null)
      setGoalSaved(null)
      setSaving(true)
      const trimmedGoalPreferences = goalPreferencesText.trim()
      const trimmedEnvironmentConstraints = workoutEnvironmentConstraintsText.trim()
      await setDoc(
        userRef,
        {
          goalText: trimmedGoalPreferences,
          workoutEnvironmentConstraintsText: trimmedEnvironmentConstraints,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      )
      setGoalDraft(null)
      setEnvironmentDraft(null)
      setGoalSaved('Goal and preferences saved')
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  const connectStrava = async () => {
    try {
      setError(null)
      const fn = httpsCallable<undefined, { url: string }>(functions, 'stravaAuthUrl')
      const res = await fn()
      window.location.assign(res.data.url)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const syncAndPersona = async () => {
    try {
      setError(null)
      setSyncing(true)
      const fn = httpsCallable<{ buildPersona: boolean }, { upserted: number }>(
        functions,
        'stravaSyncRecent',
      )
      await fn({ buildPersona: true })
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setSyncing(false)
    }
  }

  useEffect(() => {
    if (!user) return
    if (!stravaJustConnected) return
    if (!connected) return

    // After the OAuth callback, schedule the sync so we don't trigger state updates
    // synchronously inside the effect body.
    const t = window.setTimeout(() => {
      void syncAndPersona()
    }, 0)

    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, stravaJustConnected, user?.uid])

  return (
    <main className="stack">
      <section className="card hero">
        <h2>Set up your training space</h2>
        <p className="muted">
          Complete these two steps to unlock synced history and high-quality workout
          recommendations.
        </p>
      </section>

      <section className="grid">
        <div className="card stack">
          <div className="label">Step 1</div>
          <h2>Define your goals and preferences</h2>
          <p className="muted">
            Share your goal, preferences, and environment constraints. Flux uses this with your
            workout history to shape recommendations.
          </p>

          <label className="field">
            <span>Goal and preferences</span>
            <input
              value={goalPreferencesText}
              onChange={(e) => setGoalDraft(e.target.value)}
              placeholder="Build endurance, keep strength, train 4 days per week, low-impact preferred"
            />
          </label>
          <label className="field">
            <span>Workout environment constraints</span>
            <input
              value={workoutEnvironmentConstraintsText}
              onChange={(e) => setEnvironmentDraft(e.target.value)}
              placeholder="No gym, dumbbells and bike at home, weekday sessions are short"
            />
          </label>

          <div className="row">
            <button
              type="button"
              className="primary"
              onClick={() => void saveGoal()}
              disabled={saving}
            >
              {saving ? 'Saving...' : 'Save preferences'}
            </button>
          </div>
          {goalSaved ? <p className="muted">{goalSaved}</p> : null}
          {!hasSavedGoal ? (
            <button
              type="button"
              className="secondary"
              onClick={() => nav('/app')}
              disabled={saving}
            >
              Skip for now
            </button>
          ) : null}
        </div>

        <div className="card stack">
          <div className="label">Step 2</div>
          <h2>Connect Strava</h2>
          <p className="muted">
            Import your latest activities, then enrich each workout with notes for better next
            workout guidance.
          </p>

          <p className="muted">{connected ? 'Connected' : 'Not connected yet'}</p>
          {stravaStatusMessage ? <p className="muted">{stravaStatusMessage}</p> : null}

          {connected ? (
            <div className="row">
              <button
                type="button"
                className="primary"
                onClick={() => void syncAndPersona()}
                disabled={syncing}
              >
                {syncing ? 'Syncing workouts...' : 'Sync workouts'}
              </button>
              <button type="button" className="secondary" onClick={() => nav('/app')}>
                Open Hub
              </button>
            </div>
          ) : (
            <button type="button" className="primary" onClick={() => void connectStrava()}>
              Connect Strava
            </button>
          )}
        </div>
      </section>

      {error ? (
        <section className="card">
          <div className="error">{error}</div>
        </section>
      ) : null}
    </main>
  )
}
