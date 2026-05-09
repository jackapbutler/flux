import { Routes, Route, Navigate } from 'react-router-dom'
import { useEffect } from 'react'
import './App.css'
import { initAnalytics } from './lib/firebase'
import { Login } from './pages/Login'
import { Signup } from './pages/Signup'
import { Onboarding } from './pages/Onboarding'
import { Hub } from './pages/Hub'
import { Protected } from './components/Protected'
import { Shell } from './components/Shell'

export default function App() {
  useEffect(() => {
    void initAnalytics()
  }, [])

  return (
    <Routes>
      <Route element={<Shell />}>
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />

        <Route element={<Protected />}>
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="/app" element={<Hub />} />
        </Route>

        <Route path="/" element={<Navigate to="/app" replace />} />
        <Route path="*" element={<Navigate to="/app" replace />} />
      </Route>
    </Routes>
  )
}
