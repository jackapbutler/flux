import { createUserWithEmailAndPassword, signInWithPopup } from 'firebase/auth'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { auth, googleProvider } from '../lib/firebase'

type MaybeAuthError = { code?: string; message?: string }

function formatAuthError(err: unknown): string {
  const e = err as MaybeAuthError
  const code = typeof e?.code === 'string' ? e.code : ''

  if (code === 'auth/configuration-not-found') {
    return (
      'Google sign-in isn\'t enabled for this Firebase project yet. ' +
      'In Firebase Console → Authentication → Sign-in method, enable Google. ' +
      'Then add your domain in Authentication → Settings → Authorized domains.'
    )
  }

  const msg = typeof e?.message === 'string' ? e.message : String(err)
  return code ? `${code}: ${msg}` : msg
}

export function Signup() {
  const nav = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const signupEmail = async () => {
    try {
      setLoading(true)
      setError(null)
      await createUserWithEmailAndPassword(auth, email.trim(), password)
      nav('/onboarding', { replace: true })
    } catch (e) {
      setError(formatAuthError(e))
    } finally {
      setLoading(false)
    }
  }

  const signupGoogle = async () => {
    try {
      setLoading(true)
      setError(null)
      await signInWithPopup(auth, googleProvider)
      nav('/onboarding', { replace: true })
    } catch (e) {
      setError(formatAuthError(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="auth">
      <section className="card authCard">
        <h2>Create your account</h2>
        <p className="muted">
          Start with account setup, connect Strava, and unlock personalized next workouts.
        </p>

        <div className="stack" style={{ marginTop: 14 }}>
          <button
            type="button"
            className="primary"
            onClick={() => void signupGoogle()}
            disabled={loading}
          >
            {loading ? 'Connecting...' : 'Continue with Google'}
          </button>

          <div className="dividerText">
            <span>or</span>
          </div>

          <label className="field">
            <span>Email</span>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              inputMode="email"
              disabled={loading}
            />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              autoComplete="new-password"
              minLength={6}
              disabled={loading}
            />
          </label>
          <button
            type="button"
            className="secondary"
            onClick={() => void signupEmail()}
            disabled={loading}
          >
            {loading ? 'Creating...' : 'Create account'}
          </button>

          {error ? (
            <details className="errorBox" open>
              <summary>Sign-up error</summary>
              <div className="error">{error}</div>
            </details>
          ) : null}

          <p className="muted">
            Already have an account? <Link to="/login">Sign in</Link>
          </p>
        </div>
      </section>
    </main>
  )
}
