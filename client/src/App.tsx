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
import { AccountPage, FeaturesPage, HomePage } from './pages/AccountPage.js'
import { NotFoundPage, PlaceholderPage } from './pages/PlaceholderPage.js'
import {
  AcceptInvitePage,
  ForgotPasswordPage,
  ResetPasswordPage,
} from './pages/auth/AcceptInvitePage.js'
import { LoginPage } from './pages/auth/LoginPage.js'
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
        <Route path="/" element={<HomePage />} />
        <Route path="/account" element={<AccountPage />} />

        {/* M3 */}
        <Route
          path="/calendar"
          element={
            <PlaceholderPage
              title="Calendar"
              milestone="M3"
              description="The day grid showing every room against time, with click-and-drag to book."
            />
          }
        />
        <Route
          path="/find"
          element={
            <PlaceholderPage
              title="Find a room"
              milestone="M3"
              description="Search by date, time, capacity and equipment across one location or all of them."
            />
          }
        />
        <Route
          path="/bookings"
          element={
            <PlaceholderPage
              title="My bookings"
              milestone="M3"
              description="Your upcoming and past bookings, with edit and cancel."
            />
          }
        />

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

        <Route path="/admin" element={<Navigate to="/admin/rooms" replace />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}
