import { signOut } from 'firebase/auth'
import { Link, Outlet } from 'react-router-dom'
import { auth } from '../lib/firebase'
import { useAuth } from '../lib/useAuth'

export function Shell() {
  const { user } = useAuth()

  return (
    <div className="page">
      <header className="header">
        <div className="brand">
          <Link to={user ? '/app' : '/login'} className="brandLink">
            <div className="logo">
              FLUX<span>.</span>
            </div>
          </Link>
          <p className="brandTagline">
            Thoughtful, personalized training guidance.
          </p>
        </div>

        <nav className="nav">
          {user ? (
            <>
              <Link to="/app" className="link">
                Hub
              </Link>
              <Link to="/onboarding" className="link">
                Settings
              </Link>
              <button
                type="button"
                className="secondary"
                style={{ minHeight: 'auto', padding: '6px 14px', fontSize: '13px' }}
                onClick={() => void signOut(auth)}
              >
                Sign out
              </button>
            </>
          ) : (
            <>
              <Link to="/login" className="link">
                Sign in
              </Link>
              <Link to="/signup" className="link">
                Create account
              </Link>
            </>
          )}
        </nav>
      </header>
      <Outlet />
    </div>
  )
}
