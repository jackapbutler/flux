import { signOut } from 'firebase/auth'
import { useState } from 'react'
import { Link, Outlet } from 'react-router-dom'
import { auth } from '../lib/firebase'
import { useAuth } from '../lib/useAuth'

export function Shell() {
  const { user } = useAuth()
  const [navOpen, setNavOpen] = useState(false)

  const closeNav = () => setNavOpen(false)

  return (
    <div className="page">
      <header className="header">
        <button
          type="button"
          className="menuToggle"
          aria-label={navOpen ? 'Close navigation menu' : 'Open navigation menu'}
          aria-expanded={navOpen}
          onClick={() => setNavOpen((open) => !open)}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
            <path
              d="M4 6h16M4 12h16M4 18h16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>

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

        <nav className={`menuPanel ${navOpen ? 'open' : ''}`}>
          {user ? (
            <>
              <Link to="/app" className="link" onClick={closeNav}>
                Hub
              </Link>
              <Link to="/onboarding" className="link" onClick={closeNav}>
                Settings
              </Link>
              <button
                type="button"
                className="secondary"
                style={{ minHeight: 'auto', padding: '6px 14px', fontSize: '13px' }}
                onClick={() => {
                  closeNav()
                  void signOut(auth)
                }}
              >
                Sign out
              </button>
            </>
          ) : (
            <>
              <Link to="/login" className="link" onClick={closeNav}>
                Sign in
              </Link>
              <Link to="/signup" className="link" onClick={closeNav}>
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
