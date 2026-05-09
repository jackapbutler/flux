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
  const stravaJustConnected = params.get('strava') === 'connected'

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
    <main className="grid">
      <section className="card">
        <h2>Setup</h2>
        <p className="muted">Two quick steps, then you’re in.</p>

        <div className="stack">
          <label className="field">
            <span>Fitness goal (in your words)</span>
            <input
              value={goalText}
              onChange={(e) => setGoalText(e.target.value)}
              placeholder="E.g. get stronger for running, 3x/week, stay injury-free"
            />
          </label>

          <div className="row">
            <button type="button" onClick={() => void saveGoal()} disabled={saving}>
              {saving ? 'Saving…' : 'Save goal'}
            </button>
            <button type="button" className="secondary" onClick={() => nav('/app')}>
              Continue
            </button>
          </div>

          <div className="divider" />

          <div>
            <div className="label">Strava</div>
            {connected ? (
              <p className="muted">Connected ✓</p>
            ) : (
              <p className="muted">Not connected yet.</p>
            )}
            {stravaJustConnected ? (
              <p className="muted">Strava connected — pulling workouts now.</p>
            ) : null}

            {connected ? (
              <div className="row" style={{ marginTop: 10 }}>
                <button
                  type="button"
                  className="primary"
                  onClick={() => void syncAndPersona()}
                  disabled={syncing}
                >
                  {syncing ? 'Pulling workouts…' : 'Pull workouts + build persona'}
                </button>
                <button type="button" className="secondary" onClick={() => nav('/app')}>
                  Go to Hub
                </button>
              </div>
            ) : (
              <button type="button" onClick={() => void connectStrava()}>
                Connect Strava
              </button>
            )}
          </div>

          {error ? <p className="error">{error}</p> : null}
        </div>
      </section>
    </main>
  )
}
