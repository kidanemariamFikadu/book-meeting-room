/**
 * Public holiday seeding.
 *
 * A static dataset, deliberately — a booking system must not fail to validate
 * a booking because a holiday API is down (D18). An owner edits the list
 * afterwards, which is the authoritative source; this only saves them typing
 * the obvious ones.
 *
 * Coverage is intentionally modest and honest about it: fixed-date holidays
 * for the supported countries, plus the Easter-derived ones where they matter.
 * Anything missing is added by hand on the location screen.
 *
 * Specification: docs/14-multi-location.md section 6.
 */

export interface Holiday {
  date: string // YYYY-MM-DD
  name: string
}

const pad = (n: number) => String(n).padStart(2, '0')
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`

/**
 * Easter Sunday by the Anonymous Gregorian algorithm.
 *
 * Needed because Good Friday, Easter Monday and the spring bank holidays in
 * several countries are all defined relative to it, and they move every year.
 */
function easterSunday(year: number): Date {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return new Date(Date.UTC(year, month - 1, day))
}

const offsetFrom = (base: Date, days: number): string => {
  const d = new Date(base.getTime() + days * 86_400_000)
  return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
}

/** The nth given weekday of a month; `nth` of -1 means the last. */
function nthWeekday(year: number, month: number, weekday: number, nth: number): string {
  if (nth > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1))
    const shift = (weekday - first.getUTCDay() + 7) % 7
    return iso(year, month, 1 + shift + (nth - 1) * 7)
  }
  const last = new Date(Date.UTC(year, month, 0))
  const shift = (last.getUTCDay() - weekday + 7) % 7
  return iso(year, month, last.getUTCDate() - shift)
}

/** Moves a date to the following Monday when it falls at a weekend. */
function observedMonday(date: string, name: string): Holiday {
  const [y, m, d] = date.split('-').map(Number)
  const dt = new Date(Date.UTC(y!, m! - 1, d!))
  const day = dt.getUTCDay()
  if (day === 6) return { date: offsetFrom(dt, 2), name: `${name} (observed)` }
  if (day === 0) return { date: offsetFrom(dt, 1), name: `${name} (observed)` }
  return { date, name }
}

type Generator = (year: number) => Holiday[]

/**
 * Ethiopia uses its own calendar, so the Gregorian dates of its civil holidays
 * shift by a day around leap years, and the religious ones are not fixed at
 * all. Only the reliably fixed civil dates are listed; the rest are left for
 * the owner, which is more honest than seeding dates that are often wrong.
 */
const ET: Generator = y => [
  { date: iso(y, 1, 7), name: 'Genna (Christmas)' },
  { date: iso(y, 1, 19), name: 'Timkat' },
  { date: iso(y, 3, 2), name: 'Adwa Victory Day' },
  { date: iso(y, 5, 1), name: 'International Labour Day' },
  { date: iso(y, 5, 5), name: 'Patriots Day' },
  { date: iso(y, 5, 28), name: 'Derg Downfall Day' },
  { date: iso(y, 9, 11), name: 'Enkutatash (New Year)' },
  { date: iso(y, 9, 27), name: 'Meskel' },
]

const GB: Generator = y => {
  const easter = easterSunday(y)
  return [
    observedMonday(iso(y, 1, 1), 'New Year'),
    { date: offsetFrom(easter, -2), name: 'Good Friday' },
    { date: offsetFrom(easter, 1), name: 'Easter Monday' },
    { date: nthWeekday(y, 5, 1, 1), name: 'Early May bank holiday' },
    { date: nthWeekday(y, 5, 1, -1), name: 'Spring bank holiday' },
    { date: nthWeekday(y, 8, 1, -1), name: 'Summer bank holiday' },
    observedMonday(iso(y, 12, 25), 'Christmas Day'),
    observedMonday(iso(y, 12, 26), 'Boxing Day'),
  ]
}

const US: Generator = y => [
  { date: iso(y, 1, 1), name: 'New Year' },
  { date: nthWeekday(y, 1, 1, 3), name: 'Martin Luther King Jr. Day' },
  { date: nthWeekday(y, 2, 1, 3), name: 'Presidents Day' },
  { date: nthWeekday(y, 5, 1, -1), name: 'Memorial Day' },
  { date: iso(y, 6, 19), name: 'Juneteenth' },
  { date: iso(y, 7, 4), name: 'Independence Day' },
  { date: nthWeekday(y, 9, 1, 1), name: 'Labor Day' },
  { date: nthWeekday(y, 11, 4, 4), name: 'Thanksgiving' },
  { date: iso(y, 12, 25), name: 'Christmas Day' },
]

const KE: Generator = y => [
  { date: iso(y, 1, 1), name: 'New Year' },
  { date: offsetFrom(easterSunday(y), -2), name: 'Good Friday' },
  { date: offsetFrom(easterSunday(y), 1), name: 'Easter Monday' },
  { date: iso(y, 5, 1), name: 'Labour Day' },
  { date: iso(y, 6, 1), name: 'Madaraka Day' },
  { date: iso(y, 10, 20), name: 'Mashujaa Day' },
  { date: iso(y, 12, 12), name: 'Jamhuri Day' },
  { date: iso(y, 12, 25), name: 'Christmas Day' },
  { date: iso(y, 12, 26), name: 'Boxing Day' },
]

/**
 * The UAE weekend is Saturday-Sunday but the working week runs Monday to
 * Friday with a half-day; Islamic holidays follow the lunar calendar and are
 * announced rather than computed, so only the fixed civil dates are seeded.
 */
const AE: Generator = y => [
  { date: iso(y, 1, 1), name: 'New Year' },
  { date: iso(y, 12, 1), name: 'Commemoration Day' },
  { date: iso(y, 12, 2), name: 'National Day' },
  { date: iso(y, 12, 3), name: 'National Day holiday' },
]

const DE: Generator = y => {
  const easter = easterSunday(y)
  return [
    { date: iso(y, 1, 1), name: 'Neujahr' },
    { date: offsetFrom(easter, -2), name: 'Karfreitag' },
    { date: offsetFrom(easter, 1), name: 'Ostermontag' },
    { date: iso(y, 5, 1), name: 'Tag der Arbeit' },
    { date: offsetFrom(easter, 39), name: 'Christi Himmelfahrt' },
    { date: offsetFrom(easter, 50), name: 'Pfingstmontag' },
    { date: iso(y, 10, 3), name: 'Tag der Deutschen Einheit' },
    { date: iso(y, 12, 25), name: 'Erster Weihnachtstag' },
    { date: iso(y, 12, 26), name: 'Zweiter Weihnachtstag' },
  ]
}

const FR: Generator = y => {
  const easter = easterSunday(y)
  return [
    { date: iso(y, 1, 1), name: 'Jour de l An' },
    { date: offsetFrom(easter, 1), name: 'Lundi de Paques' },
    { date: iso(y, 5, 1), name: 'Fete du Travail' },
    { date: iso(y, 5, 8), name: 'Victoire 1945' },
    { date: offsetFrom(easter, 39), name: 'Ascension' },
    { date: iso(y, 7, 14), name: 'Fete nationale' },
    { date: iso(y, 8, 15), name: 'Assomption' },
    { date: iso(y, 11, 1), name: 'Toussaint' },
    { date: iso(y, 11, 11), name: 'Armistice 1918' },
    { date: iso(y, 12, 25), name: 'Noel' },
  ]
}

const GENERATORS: Record<string, Generator> = { ET, GB, US, KE, AE, DE, FR }

export const SUPPORTED_COUNTRIES = Object.keys(GENERATORS).sort()

export function supportsCountry(code: string | null | undefined): boolean {
  return Boolean(code && code.toUpperCase() in GENERATORS)
}

/**
 * Holidays for a country across a span of years.
 *
 * Returns an empty list for an unsupported country rather than throwing: a
 * location in a country we have no data for is perfectly valid, it just gets
 * no suggestions.
 */
export function holidaysFor(countryCode: string, fromYear: number, years = 2): Holiday[] {
  const generator = GENERATORS[countryCode.toUpperCase()]
  if (!generator) return []

  const all: Holiday[] = []
  for (let y = fromYear; y < fromYear + years; y++) all.push(...generator(y))

  // Deduplicate by date: an observed-shift can collide with the next holiday,
  // and two rows for one date would violate the unique constraint.
  const byDate = new Map<string, Holiday>()
  for (const h of all) if (!byDate.has(h.date)) byDate.set(h.date, h)

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}
