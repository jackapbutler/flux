import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '../lib/useAuth'

export function Protected() {
  const { ready, user, profile } = useAuth()

  if (!ready || (user && !profile)) {
    return <div className="page"><p>Loading…</p></div>
  }

  if (!user) return <Navigate to="/login" replace />

  return <Outlet />
}
