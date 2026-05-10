import { signInWithEmailAndPassword, signInWithPopup } from 'firebase/auth'
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

export function Login() {
  const nav = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)

  const loginEmail = async () => {
    try {
      setError(null)
      await signInWithEmailAndPassword(auth, email.trim(), password)
      nav('/onboarding', { replace: true })
    } catch (e) {
      setError(formatAuthError(e))
    }
  }

  const loginGoogle = async () => {
    try {
      setError(null)
      await signInWithPopup(auth, googleProvider)
      nav('/onboarding', { replace: true })
    } catch (e) {
      setError(formatAuthError(e))
    }
  }

  return (
    <main className="auth">
      <section className="card authCard">
        <h2>Welcome back</h2>
        <p className="muted">
          Sign in to sync Strava workouts, capture context, and get focused next-workout
          guidance.
        </p>

        <div className="stack" style={{ marginTop: 14 }}>
          <button type="button" className="primary" onClick={() => void loginGoogle()}>
            Continue with Google
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
            />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              autoComplete="current-password"
            />
          </label>
          <button type="button" className="secondary" onClick={() => void loginEmail()}>
            Sign in
          </button>

          {error ? (
            <details className="errorBox" open>
              <summary>Sign-in error</summary>
              <div className="error">{error}</div>
            </details>
          ) : null}

          <p className="muted">
            New here? <Link to="/signup">Create an account</Link>
          </p>
        </div>
      </section>
    </main>
  )
}
