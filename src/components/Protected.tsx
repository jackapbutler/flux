import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../lib/useAuth'

export function Protected() {
  const { ready, user, profile } = useAuth()
  const loc = useLocation()

  if (!ready || (user && !profile)) {
    return <div className="page"><p>Loading…</p></div>
  }

  if (!user) return <Navigate to="/login" replace />

  // If not connected and not on onboarding page, force onboarding
  const connected = Boolean(profile?.strava?.connected)
  if (!connected && loc.pathname !== '/onboarding') {
    return <Navigate to="/onboarding" replace />
  }

  return <Outlet />
}
