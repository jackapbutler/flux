import { useContext } from 'react'
import { AuthContext } from './authContextValue'

export function useAuth() {
  const v = useContext(AuthContext)
  if (!v) throw new Error('useAuth must be used inside AuthProvider')
  return v
}
