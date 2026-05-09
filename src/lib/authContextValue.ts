import { createContext } from 'react'
import type { User } from 'firebase/auth'
import type { DocumentReference } from 'firebase/firestore'
import type { UserProfile } from './types'

type AuthState = {
  ready: boolean
  user: User | null
  profile: UserProfile | null
  profileRef: DocumentReference | null
}

export const AuthContext = createContext<AuthState | null>(null)
export type { AuthState }
