import { doc, serverTimestamp, setDoc } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../lib/useAuth'
import { db, functions } from '../lib/firebase'

function errorMessage(err: unknown): string {
  if (
    err &&
    typeof err === 'object' &&
    'message' in err &&
    typeof (err as { message?: unknown }).message === 'string'
  ) {
    return (err as { message: string }).message
  }
  return String(err)
}

export function Onboarding() {
  const nav = useNavigate()
  const [params] = useSearchParams()
  const { user, profile } = useAuth()
  const [goalText, setGoalText] = useState(profile?.goalText ?? '')
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const connected = Boolean(profile?.strava?.connected)
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
    if (!userRef) return
    try {
      setError(null)
      setSaving(true)
      await setDoc(
        userRef,
        { goalText: goalText.trim(), updatedAt: serverTimestamp() },
        { merge: true },
      )
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
          <h2>Define your goal</h2>
          <p className="muted">
            Keep it simple and specific. Flux uses this with your workout history to shape
            recommendations.
          </p>

          <label className="field">
            <span>Fitness goal</span>
            <input
              value={goalText}
              onChange={(e) => setGoalText(e.target.value)}
              placeholder="Build endurance, keep strength, train 4 days per week"
            />
          </label>

          <div className="row">
            <button type="button" className="primary" onClick={() => void saveGoal()} disabled={saving}>
              {saving ? 'Saving...' : 'Save goal'}
            </button>
            <button type="button" className="secondary" onClick={() => nav('/app')}>
              Skip for now
            </button>
          </div>
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
