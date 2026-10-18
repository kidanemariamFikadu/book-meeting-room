/**
 * The application shell: navigation, location switcher, user menu.
 *
 * Admin entries are rendered only for those who have the role, which is a
 * convenience — the server re-checks every request regardless.
 *
 * Specification: docs/07-ui-screens.md section 3, docs/14-multi-location.md section 7.
 */

import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Building2, Check, ChevronDown, LogOut, MapPin, Menu, User } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'

import { useAuth, usePermissions } from '../../auth/AuthProvider.js'
import { useLocationScope } from '../../hooks/useLocationScope.js'
import { Button } from '../ui/index.js'
import s from './AppShell.module.css'

export function AppShell() {
  const { user, signOut } = useAuth()
  const perms = usePermissions()
  const [mobileOpen, setMobileOpen] = useState(false)
  const navigate = useNavigate()

  if (!user) return null

  const close = () => setMobileOpen(false)

  return (
    <div className={s.shell}>
      <a href="#main" className={s.skipLink}>
        Skip to content
      </a>

      <header className={s.bar}>
        <div className={s.barInner}>
          <button
            className={s.menuButton}
            onClick={() => setMobileOpen(o => !o)}
            aria-expanded={mobileOpen}
            aria-label="Main menu"
          >
            <Menu size={18} aria-hidden />
          </button>

          <button className={s.brand} onClick={() => navigate('/')}>
            <Building2 size={17} aria-hidden />
            <span>{user.organization.name}</span>
          </button>

          <nav className={s.nav} aria-label="Main">
            <Tab to="/" label="Calendar" />
            <Tab to="/find" label="Find a room" />
            <Tab to="/bookings" label="My bookings" />
          </nav>

          <div className={s.spacer} />

          <LocationSwitcher />

          {perms.isAdmin && <AdminMenu isOwner={perms.isOwner} />}

          <UserMenu
            name={user.fullName}
            email={user.email}
            role={user.role}
            onSignOut={() => void signOut()}
          />
        </div>

        {mobileOpen && (
          <nav className={s.mobileNav} aria-label="Main">
            <MobileLink to="/" label="Calendar" onClick={close} />
            <MobileLink to="/find" label="Find a room" onClick={close} />
            <MobileLink to="/bookings" label="My bookings" onClick={close} />
            {perms.isAdmin && (
              <>
                <p className={s.mobileHeading}>Admin</p>
                <MobileLink to="/admin/rooms" label="Rooms" onClick={close} />
                {perms.isOwner && <MobileLink to="/admin/locations" label="Locations" onClick={close} />}
                {perms.isOwner && <MobileLink to="/admin/users" label="Users" onClick={close} />}
                {perms.isOwner && <MobileLink to="/admin/settings" label="Settings" onClick={close} />}
              </>
            )}
            <p className={s.mobileHeading}>You</p>
            <MobileLink to="/account" label="Account" onClick={close} />
          </nav>
        )}
      </header>

      <main className={s.main} id="main">
        <Outlet />
      </main>
    </div>
  )
}

function Tab({ to, label }: { to: string; label: string }) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className={({ isActive }) => (isActive ? `${s.tab} ${s.tabActive}` : s.tab)}
    >
      {label}
    </NavLink>
  )
}

function MobileLink({ to, label, onClick }: { to: string; label: string; onClick: () => void }) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      onClick={onClick}
      className={({ isActive }) => (isActive ? `${s.mobileLink} ${s.mobileLinkActive}` : s.mobileLink)}
    >
      {label}
    </NavLink>
  )
}

/**
 * The location switcher.
 *
 * Shows each site's CURRENT LOCAL TIME, which is not decoration: in a
 * multi-timezone organization it is the fastest way to see that London is
 * three hours behind before booking something there.
 */
function LocationSwitcher() {
  const { locations, selectedId, select, isLoading } = useLocationScope()
  const navigate = useNavigate()
  const navigateToFind = () => navigate('/find?allLocations=true')

  if (isLoading || locations.length === 0) return null

  // With a single site there is nothing to switch between, so the control would
  // be noise. The name still appears, for context.
  if (locations.length === 1) {
    return (
      <span className={s.singleLocation}>
        <MapPin size={14} aria-hidden /> {locations[0]!.name}
      </span>
    )
  }

  const selected = locations.find(l => l.id === selectedId)

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className={s.switcher} aria-label="Change location">
          <MapPin size={14} aria-hidden />
          <span className={s.switcherName}>{selected?.name ?? 'All locations'}</span>
          <ChevronDown size={14} aria-hidden />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={s.menu} align="end" sideOffset={6}>
          <DropdownMenu.Label className={s.menuLabel}>Location</DropdownMenu.Label>
          {locations.map(l => (
            <DropdownMenu.Item key={l.id} className={s.menuItem} onSelect={() => select(l.id)}>
              <span className={s.menuCheck}>
                {l.id === selectedId && <Check size={13} aria-hidden />}
              </span>
              <span className={s.menuItemName}>{l.name}</span>
              {/* The live local time is why this control earns its place: it is
                  how someone notices London is three hours behind before
                  booking there (docs/14 section 7). */}
              <span className={s.menuItemMeta}>{l.currentLocalTime}</span>
            </DropdownMenu.Item>
          ))}

          <DropdownMenu.Separator className={s.menuSeparator} />
          {/*
            Deliberately not an "all locations" option. A day grid spanning
            three timezones has no coherent time axis, so the cross-location
            view lives in the room finder instead (T-171).
          */}
          <DropdownMenu.Item className={s.menuItem} onSelect={() => navigateToFind()}>
            <span className={s.menuCheck} />
            <span className={s.menuItemName}>Search all locations…</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

function AdminMenu({ isOwner }: { isOwner: boolean }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className={s.switcher}>
          Admin
          <ChevronDown size={14} aria-hidden />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={s.menu} align="end" sideOffset={6}>
          <MenuLink to="/admin/rooms" label="Rooms" />
          {isOwner && <MenuLink to="/admin/locations" label="Locations" />}
          {isOwner && <MenuLink to="/admin/users" label="Users" />}
          {isOwner && <MenuLink to="/admin/settings" label="Organization settings" />}
          <MenuLink to="/admin/approvals" label="Pending approvals" />
          <MenuLink to="/admin/emails" label="Email log" />
          <DropdownMenu.Separator className={s.menuSeparator} />
          <DropdownMenu.Label className={s.menuLabel}>Coming later</DropdownMenu.Label>
          <DropdownMenu.Item className={s.menuItemDisabled} disabled>
            All bookings
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

function MenuLink({ to, label }: { to: string; label: string }) {
  const navigate = useNavigate()
  return (
    <DropdownMenu.Item className={s.menuItem} onSelect={() => navigate(to)}>
      <span className={s.menuCheck} />
      <span className={s.menuItemName}>{label}</span>
    </DropdownMenu.Item>
  )
}

function UserMenu({
  name,
  email,
  role,
  onSignOut,
}: {
  name: string
  email: string
  role: string
  onSignOut: () => void
}) {
  const navigate = useNavigate()
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map(part => part[0] ?? '')
    .join('')
    .toUpperCase()

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className={s.avatar} aria-label={`Account menu for ${name}`}>
          {initials || <User size={15} aria-hidden />}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={s.menu} align="end" sideOffset={6}>
          <div className={s.menuHeader}>
            <strong>{name}</strong>
            <span>{email}</span>
            <span className={s.menuRole}>{role.toLowerCase()}</span>
          </div>
          <DropdownMenu.Separator className={s.menuSeparator} />
          <DropdownMenu.Item className={s.menuItem} onSelect={() => navigate('/account')}>
            <span className={s.menuCheck} />
            <span className={s.menuItemName}>Account</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item className={s.menuItem} onSelect={onSignOut}>
            <span className={s.menuCheck}>
              <LogOut size={13} aria-hidden />
            </span>
            <span className={s.menuItemName}>Sign out</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

/** A centred container for the auth screens, which have no shell. */
export function CentredLayout({ children }: { children: ReactNode }) {
  return (
    <div className={s.centred}>
      <div className={s.centredInner}>{children}</div>
    </div>
  )
}

export { Button }
