import {
  createUserWithEmailAndPassword,
  getRedirectResult,
  signInWithPopup,
  signInWithRedirect,
} from 'firebase/auth'
import { useEffect, useState } from 'react'
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
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const res = await getRedirectResult(auth)
        if (res?.user) nav('/onboarding', { replace: true })
      } catch (e) {
        setError(formatAuthError(e))
      }
    })()
  }, [nav])

  const signupEmail = async () => {
    try {
      setError(null)
      await createUserWithEmailAndPassword(auth, email.trim(), password)
      nav('/onboarding', { replace: true })
    } catch (e) {
      setError(formatAuthError(e))
    }
  }

  const signupGoogle = async () => {
    try {
      setError(null)
      await signInWithPopup(auth, googleProvider)
      nav('/onboarding', { replace: true })
    } catch (e) {
      const code = (e as any)?.code
      if (
        code === 'auth/popup-blocked' ||
        code === 'auth/cancelled-popup-request' ||
        code === 'auth/web-storage-unsupported'
      ) {
        try {
          await signInWithRedirect(auth, googleProvider)
          return
        } catch (err2) {
          setError(formatAuthError(err2))
          return
        }
      }
      setError(formatAuthError(e))
    }
  }

  return (
    <main className="auth">
      <section className="card authCard">
        <h2>Create your account</h2>
        <p className="muted">A calm training hub connected to Strava.</p>

        <div className="stack" style={{ marginTop: 14 }}>
          <button
            type="button"
            className="primary"
            onClick={() => void signupGoogle()}
          >
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
              autoComplete="new-password"
              minLength={6}
            />
          </label>
          <button type="button" onClick={() => void signupEmail()}>
            Create account
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
