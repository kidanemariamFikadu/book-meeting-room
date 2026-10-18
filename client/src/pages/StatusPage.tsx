/**
 * M0 placeholder.
 *
 * It exists to prove the whole chain works end to end: React renders, the
 * shared package is importable in the browser, the dev proxy reaches Express,
 * and the design tokens apply in both colour schemes. It is replaced by the
 * calendar in M3.
 */

import { useQuery } from '@tanstack/react-query'

import { OCCUPYING_BOOKING_STATUSES, overlaps } from '@roombook/shared'

import styles from './StatusPage.module.css'

interface ApiInfo {
  name: string
  version: string
  milestone: string
  routers: Record<string, string>
}

export function StatusPage({ notFound = false }: { notFound?: boolean }) {
  const { data, isPending, error } = useQuery<ApiInfo>({
    queryKey: ['api', 'info'],
    queryFn: async () => {
      const res = await fetch('/api/v1', { credentials: 'same-origin' })
      if (!res.ok) throw Object.assign(new Error('API unreachable'), { status: res.status })
      return res.json() as Promise<ApiInfo>
    },
  })

  /*
   * Proves the shared package runs unchanged in the browser: the same overlap
   * function the server uses for conflict detection, imported here.
   * 09:00-10:00 and 10:00-11:00 must NOT overlap (BR-T2).
   */
  const halfOpenHolds =
    overlaps(
      { start: new Date('2026-11-04T09:00:00Z'), end: new Date('2026-11-04T10:00:00Z') },
      { start: new Date('2026-11-04T10:00:00Z'), end: new Date('2026-11-04T11:00:00Z') },
    ) === false

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <p className={styles.eyebrow}>M0 · Foundations</p>
        <h1 className={styles.title}>RoomBook</h1>
        <p className={styles.lede}>
          Meeting room booking. The scaffold is up; the calendar arrives in M3.
        </p>

        {notFound && (
          <p className={styles.notice} role="status">
            That route does not exist yet — the SPA fallback caught it.
          </p>
        )}

        <dl className={styles.checks}>
          <Check label="React + Vite" ok detail="rendering" />
          <Check
            label="Express API"
            ok={!error && !isPending}
            detail={isPending ? 'checking…' : error ? 'unreachable' : (data?.milestone ?? 'ok')}
          />
          <Check
            label="@roombook/shared"
            ok={halfOpenHolds}
            detail={halfOpenHolds ? 'half-open intervals correct' : 'OVERLAP LOGIC WRONG'}
          />
          <Check
            label="Occupying statuses"
            ok
            detail={OCCUPYING_BOOKING_STATUSES.join(', ')}
          />
        </dl>

        <p className={styles.footnote}>
          Specification in <code>docs/</code> · delivery plan in{' '}
          <code>docs/11-delivery-plan.md</code>
        </p>
      </div>
    </main>
  )
}

function Check({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return (
    <div className={styles.check}>
      <dt className={styles.checkLabel}>
        {/* The word, not just the colour, carries the meaning (NFR-5). */}
        <span className={ok ? styles.badgeOk : styles.badgeBad}>{ok ? 'OK' : 'FAIL'}</span>
        {label}
      </dt>
      <dd className={styles.checkDetail}>{detail}</dd>
    </div>
  )
}
