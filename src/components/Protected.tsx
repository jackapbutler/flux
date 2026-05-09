import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '../lib/useAuth'

export function Protected() {
  const { ready, user } = useAuth()
  if (!ready) return <div className="page"><p>Loading…</p></div>
  if (!user) return <Navigate to="/login" replace />
  return <Outlet />
}
