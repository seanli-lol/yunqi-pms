import { Navigate, Route, Routes } from 'react-router-dom'
import AppShell from './AppShell'
import { useAuth } from './auth'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Rooms from './pages/Rooms'
import Reservations from './pages/Reservations'
import FrontDesk from './pages/FrontDesk'
import Billing from './pages/Billing'
import Guests from './pages/Guests'
import Housekeeping from './pages/Housekeeping'
import Reports from './pages/Reports'
import Settings from './pages/Settings'

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  return <>{children}</>
}

export default function App() {
  const { user } = useAuth()
  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />
      <Route element={<RequireAuth><AppShell /></RequireAuth>}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/rooms" element={<Rooms />} />
        <Route path="/reservations" element={<Reservations />} />
        <Route path="/front-desk" element={<FrontDesk />} />
        <Route path="/billing" element={<Billing />} />
        <Route path="/guests" element={<Guests />} />
        <Route path="/housekeeping" element={<Housekeeping />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
