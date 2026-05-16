import { createUserWithEmailAndPassword, signInWithPopup } from 'firebase/auth'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { auth, googleProvider } from '../lib/firebase'

type MaybeAuthError = { code?: string; message?: string }

function formatAuthError(err: unknown): string {
  const e = err as MaybeAuthError
  const code = typeof e?.code === 'string' ? e.code : ''
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
      setLoading(true); setError(null)
      await createUserWithEmailAndPassword(auth, email.trim(), password)
      nav('/app', { replace: true })
    } catch (e) { setError(formatAuthError(e)) } finally { setLoading(false) }
  }

  const signupGoogle = async () => {
    try {
      setLoading(true); setError(null)
      await signInWithPopup(auth, googleProvider)
      nav('/app', { replace: true })
    } catch (e) { setError(formatAuthError(e)) } finally { setLoading(false) }
  }

  return (
    <div className="stack" style={{ paddingTop: '40px' }}>
      <section className="card stack" style={{ maxWidth: '400px', margin: '0 auto', width: '100%' }}>
        <h2 style={{ textAlign: 'center' }}>Create Account</h2>
        <p className="muted" style={{ textAlign: 'center' }}>Unlock your personal performance companion.</p>

        <div className="stack" style={{ marginTop: '14px' }}>
          <button className="secondary" onClick={() => void signupGoogle()} disabled={loading} style={{ width: '100%', gap: '12px' }}>
            Continue with Google
          </button>

          <div className="dividerText"><span>or</span></div>

          <label className="field">
            <span>Email</span>
            <input value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" disabled={loading} />
          </label>
          <label className="field">
            <span>Password</span>
            <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" minLength={6} disabled={loading} />
          </label>
          <button className="primary" onClick={() => void signupEmail()} disabled={loading} style={{ width: '100%' }}>
            {loading ? '...' : 'Create Account'}
          </button>

          {error && <div className="errorBox"><div className="error">{error}</div></div>}

          <p className="muted" style={{ textAlign: 'center', fontSize: '13px' }}>
            Already have an account? <Link to="/login" style={{ color: 'var(--accent)', fontWeight: 600 }}>Sign in</Link>
          </p>
        </div>
      </section>
    </div>
  )
}
