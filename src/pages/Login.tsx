import { signInWithEmailAndPassword, signInWithPopup } from 'firebase/auth'
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

export function Login() {
  const nav = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loginEmail = async () => {
    try {
      setLoading(true); setError(null)
      await signInWithEmailAndPassword(auth, email.trim(), password)
      nav('/app', { replace: true })
    } catch (e) { setError(formatAuthError(e)) } finally { setLoading(false) }
  }

  const loginGoogle = async () => {
    try {
      setLoading(true); setError(null)
      await signInWithPopup(auth, googleProvider)
      nav('/app', { replace: true })
    } catch (e) { setError(formatAuthError(e)) } finally { setLoading(false) }
  }

  return (
    <div className="stack" style={{ paddingTop: '40px' }}>
      <section className="card stack" style={{ maxWidth: '400px', margin: '0 auto', width: '100%' }}>
        <h2 style={{ textAlign: 'center' }}>Welcome Back</h2>
        <p className="muted" style={{ textAlign: 'center' }}>Sign in to access your proactive coach.</p>

        <div className="stack" style={{ marginTop: '14px' }}>
          <button className="secondary" onClick={() => void loginGoogle()} disabled={loading} style={{ width: '100%', gap: '12px' }}>
            Continue with Google
          </button>

          <div className="dividerText"><span>or</span></div>

          <label className="field">
            <span>Email</span>
            <input value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" disabled={loading} />
          </label>
          <label className="field">
            <span>Password</span>
            <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" disabled={loading} />
          </label>
          <button className="primary" onClick={() => void loginEmail()} disabled={loading} style={{ width: '100%' }}>
            {loading ? '...' : 'Sign In'}
          </button>

          {error && <div className="errorBox"><div className="error">{error}</div></div>}

          <p className="muted" style={{ textAlign: 'center', fontSize: '13px' }}>
            New here? <Link to="/signup" style={{ color: 'var(--accent)', fontWeight: 600 }}>Create account</Link>
          </p>
        </div>
      </section>
    </div>
  )
}
