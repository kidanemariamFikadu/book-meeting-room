/**
 * Routing.
 *
 * Route guards redirect rather than rendering a forbidden screen — a control
 * the user cannot use should not have been linked to. They are a convenience;
 * every endpoint re-checks permission independently.
 *
 * Specification: docs/05-api-spec.md section 9.
 */

import { Navigate, Route, Routes } from 'react-router-dom'

import { RedirectIfSignedIn, RequireAuth, RequireRole } from './auth/AuthProvider.js'
import { AppShell, CentredLayout } from './components/layout/AppShell.js'
import { AccountPage, FeaturesPage } from './pages/AccountPage.js'
import { BookingDetailPage, FindRoomPage, MyBookingsPage } from './pages/BookingsPage.js'
import { CalendarPage } from './pages/CalendarPage.js'
import { NotFoundPage } from './pages/PlaceholderPage.js'
import {
  AcceptInvitePage,
  ForgotPasswordPage,
  ResetPasswordPage,
} from './pages/auth/AcceptInvitePage.js'
import { LoginPage } from './pages/auth/LoginPage.js'
import { ApprovalsPage } from './pages/admin/ApprovalsPage.js'
import { DevMailboxPage, EmailLogPage } from './pages/admin/EmailLogPage.js'
import { LocationDetailPage } from './pages/admin/LocationDetailPage.js'
import { LocationsPage } from './pages/admin/LocationsPage.js'
import { RoomEditorPage } from './pages/admin/RoomEditorPage.js'
import { RoomsPage } from './pages/admin/RoomsPage.js'
import { SettingsPage } from './pages/admin/SettingsPage.js'
import { UsersPage } from './pages/admin/UsersPage.js'

const authScreen = (element: React.ReactNode) => (
  <RedirectIfSignedIn>
    <CentredLayout>{element}</CentredLayout>
  </RedirectIfSignedIn>
)

export function App() {
  return (
    <Routes>
      {/* Public. An already-signed-in user is sent home instead. */}
      <Route path="/login" element={authScreen(<LoginPage />)} />
      <Route path="/forgot-password" element={authScreen(<ForgotPasswordPage />)} />
      <Route path="/reset-password" element={authScreen(<ResetPasswordPage />)} />
      <Route path="/accept-invite" element={authScreen(<AcceptInvitePage />)} />

      {/* Everything below requires a session. */}
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route path="/" element={<CalendarPage />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/find" element={<FindRoomPage />} />
        <Route path="/bookings" element={<MyBookingsPage />} />
        <Route path="/bookings/:id" element={<BookingDetailPage />} />
        <Route path="/account" element={<AccountPage />} />



        {/* Admin: rooms and equipment need only the ADMIN role, scoped per
            location inside each screen (BR-L1). */}
        <Route
          path="/admin/rooms"
          element={
            <RequireRole minimum="ADMIN">
              <RoomsPage />
            </RequireRole>
          }
        />
        <Route
          path="/admin/rooms/new"
          element={
            <RequireRole minimum="ADMIN">
              <RoomEditorPage />
            </RequireRole>
          }
        />
        <Route
          path="/admin/rooms/:id"
          element={
            <RequireRole minimum="ADMIN">
              <RoomEditorPage />
            </RequireRole>
          }
        />
        <Route
          path="/admin/equipment"
          element={
            <RequireRole minimum="ADMIN">
              <FeaturesPage />
            </RequireRole>
          }
        />

        {/* Owner only: locations, users, settings (BR-L3, BR-U6). */}
        <Route
          path="/admin/locations"
          element={
            <RequireRole minimum="OWNER">
              <LocationsPage />
            </RequireRole>
          }
        />
        <Route
          path="/admin/locations/:id"
          element={
            <RequireRole minimum="OWNER">
              <LocationDetailPage />
            </RequireRole>
          }
        />
        <Route
          path="/admin/users"
          element={
            <RequireRole minimum="OWNER">
              <UsersPage />
            </RequireRole>
          }
        />
        <Route
          path="/admin/settings"
          element={
            <RequireRole minimum="OWNER">
              <SettingsPage />
            </RequireRole>
          }
        />

        <Route
          path="/admin/approvals"
          element={
            <RequireRole minimum="ADMIN">
              <ApprovalsPage />
            </RequireRole>
          }
        />
        <Route
          path="/admin/emails"
          element={
            <RequireRole minimum="ADMIN">
              <EmailLogPage />
            </RequireRole>
          }
        />
        <Route path="/dev/emails" element={<DevMailboxPage />} />

        <Route path="/admin" element={<Navigate to="/admin/rooms" replace />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}
