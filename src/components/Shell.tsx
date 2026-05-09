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
            <div className="brandTitle">Flux</div>
          </Link>
          <p className="brandTagline">Calm, personalized training for all fitness — strength, cardio, classes, and more.</p>
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
