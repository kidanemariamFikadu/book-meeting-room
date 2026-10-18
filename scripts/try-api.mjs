#!/usr/bin/env node
/**
 * A guided walk through the M1 API, for checking it by hand before the admin
 * screens exist (those are M2).
 *
 *   node scripts/try-api.mjs                     # signs in as the owner
 *   node scripts/try-api.mjs london.admin        # or any seeded account
 *
 * Requires `npm run dev` to be running.
 */

const BASE = process.env.API_BASE ?? 'http://localhost:3000/api/v1'
const PASSWORD = process.env.DEV_PASSWORD ?? 'Password123!'

const who = process.argv[2] ?? 'owner'
const email = who.includes('@') ? who : `${who}@acme.test`

const dim = s => `\x1b[2m${s}\x1b[0m`
const bold = s => `\x1b[1m${s}\x1b[0m`
const green = s => `\x1b[32m${s}\x1b[0m`
const red = s => `\x1b[31m${s}\x1b[0m`

async function signIn() {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    console.error(red(`\nCould not sign in as ${email}: ${res.status}`))
    console.error(dim(JSON.stringify(body)))
    console.error(
      dim('\nIs the server running? Try: npm run dev   (and npm run seed if the database is empty)'),
    )
    process.exit(1)
  }
  const cookie = res.headers
    .getSetCookie()
    .map(c => c.split(';')[0])
    .join('; ')
  const { csrfToken } = await (await fetch(`${BASE}/auth/csrf`, { headers: { cookie } })).json()
  return { cookie, csrfToken }
}

const s = await signIn()

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      cookie: s.cookie,
      'x-csrf-token': s.csrfToken,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, body: json }
}

const report = (label, r) => {
  const ok = r.status < 400
  const mark = ok ? green('ok  ') : red('err ')
  const note = r.body?.error ? dim(`${r.body.error.code}: ${r.body.error.message}`) : ''
  console.log(`  ${mark}${String(r.status).padEnd(4)} ${label}`)
  if (note) console.log(`            ${note}`)
  return r
}

// ---------------------------------------------------------------------------

const me = (await call('GET', '/auth/me')).body.user
console.log(`\n${bold('Signed in')} as ${me.fullName} (${me.email})`)
console.log(`  role ${bold(me.role)} · ${me.administersAllLocations ? 'all locations' : `scoped to ${me.adminLocationIds.length} location(s)`}`)

console.log(`\n${bold('Locations')}`)
const locations = (await call('GET', '/locations')).body.data
for (const l of locations) {
  console.log(
    `  ${l.name.padEnd(14)} ${l.timezone.padEnd(22)} ${bold(l.currentLocalTime)} local  ${dim(`${l.roomCount} rooms`)}`,
  )
}

console.log(`\n${bold('Rooms')}`)
const rooms = (await call('GET', '/rooms')).body.data
for (const r of rooms) {
  const features = r.features.map(f => f.name).join(', ') || dim('no features')
  const approval = r.requiresApproval ? bold(' [needs approval]') : ''
  console.log(`  ${r.name.padEnd(16)} ${String(r.capacity).padStart(2)} seats  ${r.location.name.padEnd(13)}${approval}`)
  console.log(`  ${' '.repeat(16)} ${dim(features)}`)
}

// A scoped admin should be refused on a room outside their locations, which is
// the single most important permission boundary in a multi-site setup (BR-L1).
const addis = locations.find(l => l.name === 'Head Office')
const london = locations.find(l => l.name === 'London')

console.log(`\n${bold('Permission boundaries')} ${dim('(expected results depend on who you signed in as)')}`)
if (addis) {
  report(
    `create a room at Head Office`,
    await call('POST', '/rooms', {
      locationId: addis.id,
      name: `Probe HQ ${Date.now()}`,
      capacity: 4,
    }),
  )
}
if (london) {
  report(
    `create a room at London`,
    await call('POST', '/rooms', {
      locationId: london.id,
      name: `Probe LDN ${Date.now()}`,
      capacity: 4,
    }),
  )
}
report(
  'create a location (owner only)',
  await call('POST', '/locations', { name: `Probe Site ${Date.now()}`, timezone: 'Europe/Paris' }),
)
report('change a role (owner only)', await call('PATCH', `/users/${me.id}`, { role: 'OWNER' }))

console.log(`\n${bold('Delete guard')} ${dim('(a room with booking history cannot be deleted)')}`)
const used = rooms.find(r => r.name === 'Boardroom') ?? rooms[0]
if (used) report(`delete ${used.name}`, await call('DELETE', `/rooms/${used.id}`))

console.log(`\n${dim('Tidying up probe rooms and locations...')}`)
for (const r of (await call('GET', '/rooms?includeInactive=true')).body.data ?? []) {
  if (r.name.startsWith('Probe ')) await call('DELETE', `/rooms/${r.id}`)
}
for (const l of (await call('GET', '/locations?includeInactive=true')).body.data ?? []) {
  if (l.name.startsWith('Probe Site')) await call('DELETE', `/locations/${l.id}`)
}

console.log(green('\nDone.'))
console.log(dim('Try a different account:  node scripts/try-api.mjs london.admin'))
console.log(dim('                          node scripts/try-api.mjs alice\n'))
