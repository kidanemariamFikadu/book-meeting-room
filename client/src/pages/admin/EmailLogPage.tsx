/**
 * Admin: the email log (S-18), and the development mailbox (S-21).
 *
 * The log exists to answer one question that comes up on the first day of real
 * use: "did Bob actually get told?" Answering it without access to a mail
 * server is why this is part of the product (US-N6).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Clock, Inbox, Mail, RefreshCw, Send } from 'lucide-react'
import { useState } from 'react'

import { ApiError, api } from '../../api/client.js'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  InfoNotice,
  Modal,
  PageHeader,
  Select,
  Skeleton,
  useToast,
} from '../../components/ui/index.js'
import s from './admin.module.css'

type Status = 'QUEUED' | 'SENDING' | 'SENT' | 'FAILED' | 'CANCELLED'

interface EmailRow {
  id: string
  template: string
  toEmail: string
  toName: string | null
  subject: string
  status: Status
  attempts: number
  lastError: string | null
  scheduledAt: string
  sentAt: string | null
  createdAt: string
  bookingId: string | null
  booking: { title: string; room: { name: string } } | null
}

interface EmailDetail extends EmailRow {
  bodyHtml: string | null
  bodyText: string | null
  payload: unknown
}

const STATUS_TONE: Record<Status, 'success' | 'warning' | 'danger' | 'neutral' | 'pending'> = {
  SENT: 'success',
  QUEUED: 'warning',
  SENDING: 'pending',
  FAILED: 'danger',
  CANCELLED: 'neutral',
}

export function EmailLogPage() {
  const toast = useToast()
  const qc = useQueryClient()
  const [status, setStatus] = useState<string>('')
  const [openId, setOpenId] = useState<string | null>(null)

  const list = useQuery({
    queryKey: ['admin-emails', status],
    queryFn: () =>
      api.get<{
        data: EmailRow[]
        meta: { total: number; counts: Partial<Record<Status, number>>; maxAttempts: number }
      }>(`/admin/emails${status ? `?status=${status}` : ''}`),
    // Queued messages move through states on their own, so the list refreshes.
    refetchInterval: 15_000,
  })

  const detail = useQuery({
    queryKey: ['admin-email', openId],
    queryFn: () => api.get<{ data: EmailDetail }>(`/admin/emails/${openId}`).then(r => r.data),
    enabled: Boolean(openId),
  })

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['admin-emails'] })

  const resend = useMutation({
    mutationFn: (id: string) => api.post(`/admin/emails/${id}/resend`),
    onSuccess: invalidate,
  })

  const flush = useMutation({
    mutationFn: () => api.post<{ sent: number; failed: number }>('/admin/emails/flush'),
    onSuccess: invalidate,
  })

  if (list.error) {
    return <ErrorNotice title="Could not load the email log" error={list.error} onRetry={() => void list.refetch()} />
  }

  const counts = list.data?.meta.counts ?? {}
  const failed = counts.FAILED ?? 0

  return (
    <>
      <PageHeader
        title="Email log"
        description="Every message the system has queued, with what was sent and whether it arrived."
        actions={
          <Button
            loading={flush.isPending}
            onClick={async () => {
              const result = await flush.mutateAsync()
              toast.show(
                result.sent === 0 && result.failed === 0
                  ? 'Nothing waiting to send'
                  : `Sent ${result.sent}${result.failed ? `, ${result.failed} failed` : ''}`,
              )
            }}
          >
            <Send size={15} aria-hidden /> Send queued now
          </Button>
        }
      />

      {/* Lead with the number that needs action, rather than making an admin
          scan the list to discover it. */}
      {failed > 0 && (
        <div className={s.spacedBottom}>
          <ErrorNotice
            title={`${failed} message${failed === 1 ? '' : 's'} could not be delivered`}
            error={new Error('Open a row to see the error, then resend once the cause is fixed.')}
          />
        </div>
      )}

      <div className={s.toolbarRow}>
        <div className={s.statusChips}>
          {(['SENT', 'QUEUED', 'FAILED', 'CANCELLED'] as Status[]).map(st => (
            <span key={st} className={s.statusChip}>
              <Badge tone={STATUS_TONE[st]}>{st.toLowerCase()}</Badge>
              <strong>{counts[st] ?? 0}</strong>
            </span>
          ))}
        </div>

        <Select
          aria-label="Filter by status"
          value={status}
          onChange={e => setStatus(e.target.value)}
        >
          <option value="">All statuses</option>
          <option value="SENT">Sent</option>
          <option value="QUEUED">Queued</option>
          <option value="FAILED">Failed</option>
          <option value="CANCELLED">Cancelled</option>
        </Select>
      </div>

      {list.isPending && <Skeleton rows={5} />}

      {list.data && list.data.data.length === 0 && (
        <Card>
          <EmptyState
            title="No messages yet"
            description="Email is queued when a booking is made, moved or cancelled. Nothing has happened yet."
          />
        </Card>
      )}

      {list.data && list.data.data.length > 0 && (
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th scope="col">Subject</th>
                <th scope="col">To</th>
                <th scope="col">Status</th>
                <th scope="col">When</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.data.data.map(row => (
                <tr key={row.id}>
                  <th scope="row">
                    {row.subject}
                    <p className={s.subtle}>
                      {row.template}
                      {row.booking ? ` · ${row.booking.room.name}` : ''}
                    </p>
                  </th>
                  <td className={s.muted}>
                    {row.toName ?? row.toEmail}
                    {row.toName && <p className={s.subtle}>{row.toEmail}</p>}
                  </td>
                  <td>
                    <Badge tone={STATUS_TONE[row.status]}>{row.status.toLowerCase()}</Badge>
                    {row.attempts > 1 && (
                      <p className={s.subtle}>
                        {row.attempts} of {list.data!.meta.maxAttempts} attempts
                      </p>
                    )}
                    {row.lastError && <p className={s.subtle}>{truncate(row.lastError, 60)}</p>}
                  </td>
                  <td className={s.muted}>
                    {row.sentAt ? (
                      new Date(row.sentAt).toLocaleString()
                    ) : row.status === 'QUEUED' ? (
                      <>
                        <Clock size={11} aria-hidden /> due {new Date(row.scheduledAt).toLocaleTimeString()}
                      </>
                    ) : (
                      new Date(row.createdAt).toLocaleString()
                    )}
                  </td>
                  <td className={s.actions}>
                    <Button size="sm" onClick={() => setOpenId(row.id)}>
                      <Mail size={13} aria-hidden /> View
                    </Button>
                    {(row.status === 'FAILED' || row.status === 'CANCELLED') && (
                      <Button
                        size="sm"
                        loading={resend.isPending}
                        onClick={async () => {
                          try {
                            await resend.mutateAsync(row.id)
                            toast.show('Queued to send again')
                          } catch (err) {
                            toast.show(
                              err instanceof ApiError ? err.message : 'Could not resend',
                              'error',
                            )
                          }
                        }}
                      >
                        <RefreshCw size={13} aria-hidden /> Resend
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {openId && (
        <Modal open onOpenChange={open => !open && setOpenId(null)} title="Message" wide>
          {detail.isPending && <Skeleton rows={3} />}
          {detail.data && (
            <>
              <dl className={s.detailList}>
                <dt>Subject</dt>
                <dd>{detail.data.subject}</dd>
                <dt>To</dt>
                <dd>{detail.data.toEmail}</dd>
                <dt>Template</dt>
                <dd className={s.mono}>{detail.data.template}</dd>
                <dt>Status</dt>
                <dd>
                  <Badge tone={STATUS_TONE[detail.data.status]}>
                    {detail.data.status.toLowerCase()}
                  </Badge>
                </dd>
                {detail.data.lastError && (
                  <>
                    <dt>Last error</dt>
                    <dd className={s.mono}>{detail.data.lastError}</dd>
                  </>
                )}
              </dl>

              {detail.data.bodyText ? (
                <>
                  <h3 className={s.sectionTitle}>Plain text, as delivered</h3>
                  <pre className={s.pre}>{detail.data.bodyText}</pre>
                </>
              ) : (
                <InfoNotice>
                  This message has not been sent yet, so there is no rendered body to show.
                </InfoNotice>
              )}
            </>
          )}
        </Modal>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------

interface Captured {
  to: string
  subject: string
  text: string
  sentAt: string
}

/**
 * The development mailbox (S-21).
 *
 * This is what lets the whole notification system be built and demonstrated
 * with no SMTP credentials at all (D2).
 */
export function DevMailboxPage() {
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['dev-emails'],
    queryFn: () =>
      api.get<{ transport: string; captured: Captured[]; note?: string }>('/dev/emails'),
    refetchInterval: 5_000,
  })

  if (error) return <ErrorNotice title="Not available" error={error} onRetry={() => void refetch()} />

  return (
    <>
      <PageHeader
        title="Captured email"
        description="Development only. Everything the system would have sent, without needing a mail server."
      />

      {isPending && <Skeleton rows={3} />}

      {data?.note && (
        <div className={s.spacedBottom}>
          <InfoNotice>
            <strong>Transport: {data.transport}</strong>
            <p>{data.note}</p>
          </InfoNotice>
        </div>
      )}

      {data && data.captured.length === 0 && !data.note && (
        <Card>
          <EmptyState
            title="Nothing captured yet"
            description="Make, move or cancel a booking and the message will appear here."
          />
        </Card>
      )}

      <div className={s.list}>
        {(data?.captured ?? []).map((m, i) => (
          <Card key={i}>
            <div className={s.mailHead}>
              <Inbox size={14} aria-hidden />
              <strong>{m.subject}</strong>
              <span className={s.subtle}>{new Date(m.sentAt).toLocaleTimeString()}</span>
            </div>
            <p className={s.subtle}>To {m.to}</p>
            <pre className={s.pre}>{m.text}</pre>
          </Card>
        ))}
      </div>

      {(data?.captured.length ?? 0) > 0 && (
        <p className={s.footnote}>
          <AlertCircle size={13} aria-hidden /> Held in memory only, so they disappear when the
          server restarts.
        </p>
      )}
    </>
  )
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}
