import { signOut } from 'firebase/auth'
import { Link, Outlet, useLocation } from 'react-router-dom'
import { auth } from '../lib/firebase'
import { useAuth } from '../lib/useAuth'

export function Shell() {
  const { user } = useAuth()
  const { pathname } = useLocation()

  return (
    <div className="app-container">
      {/* Global Header (Mobile Optimized) */}
      <header className="row" style={{ justifyContent: 'space-between', padding: '24px 0 16px' }}>
        <Link to="/" style={{ textDecoration: 'none' }}>
          <h1 style={{ fontSize: '1.25rem', letterSpacing: '-0.04em' }}>FLUX✦</h1>
        </Link>
        {user && (
          <button 
            className="secondary small" 
            style={{ padding: '6px 12px', fontSize: '0.7rem' }}
            onClick={() => void signOut(auth)}
          >
            Sign Out
          </button>
        )}
      </header>

      <Outlet />

      {/* Global Bottom Navigation for Logged-in Users */}
      {user && (
        <nav className="bottom-nav">
          <Link to="/app" className={`nav-item ${pathname === '/app' ? 'active' : ''}`}>
            <span style={{ fontSize: '1.2rem' }}>✦</span>
            <span>Hub</span>
          </Link>
          <Link to="/log" className={`nav-item ${pathname === '/log' ? 'active' : ''}`}>
            <span style={{ fontSize: '1.2rem' }}>▤</span>
            <span>Log</span>
          </Link>
          <Link to="/plans" className={`nav-item ${pathname === '/plans' ? 'active' : ''}`}>
            <span style={{ fontSize: '1.2rem' }}>🗓</span>
            <span>Plan</span>
          </Link>
          <Link to="/onboarding" className={`nav-item ${pathname === '/onboarding' ? 'active' : ''}`}>
            <span style={{ fontSize: '1.2rem' }}>⚙</span>
            <span>Settings</span>
          </Link>
        </nav>
      )}
    </div>
  )
}
