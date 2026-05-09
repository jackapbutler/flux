import { onAuthStateChanged, type User } from 'firebase/auth'
import { doc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore'
import React, { useEffect, useMemo, useState } from 'react'
import { auth, db } from './firebase'
import type { AuthState } from './authContextValue'
import { AuthContext } from './authContextValue'
import type { UserProfile } from './types'

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false)
  const [user, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<UserProfile | null>(null)

  const profileRef = useMemo(() => {
    if (!user) return null
    return doc(db, 'users', user.uid)
  }, [user])

  useEffect(() => {
    return onAuthStateChanged(auth, (u) => {
      setUser(u)
      if (!u) setProfile(null)
      setReady(true)
    })
  }, [])

  useEffect(() => {
    if (!profileRef) return

    // Ensure profile exists
    void setDoc(
      profileRef,
      { createdAt: serverTimestamp(), updatedAt: serverTimestamp() },
      { merge: true },
    )

    return onSnapshot(profileRef, (snap) => {
      setProfile((snap.data() as UserProfile | undefined) ?? {})
    })
  }, [profileRef])

  const value = useMemo<AuthState>(
    () => ({ ready, user, profile, profileRef }),
    [ready, user, profile, profileRef],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
