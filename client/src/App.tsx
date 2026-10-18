/**
 * Application shell and routing.
 *
 * Routes are added as each milestone lands; the table below mirrors
 * docs/05-api-spec.md section 9. Route guards (RequireAuth / RequireRole)
 * arrive with authentication in M1.
 */

import { Route, Routes } from 'react-router-dom'

import { StatusPage } from './pages/StatusPage.js'

export function App() {
  return (
    <Routes>
      <Route path="/" element={<StatusPage />} />
      {/*
        M1  /login /forgot-password /reset-password /accept-invite /account
        M2  /admin/rooms /admin/rooms/:id
        M3  /calendar /find /bookings /bookings/new /bookings/:id /admin/bookings
        M3b /admin/locations
        M4b /series/:id
        M4c /account/calendar /admin/integrations
      */}
      <Route path="*" element={<StatusPage notFound />} />
    </Routes>
  )
}
