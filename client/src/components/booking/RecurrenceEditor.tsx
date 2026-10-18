/**
 * The recurrence editor (S-26) and the conflict preview (S-27).
 *
 * The live plain-English summary is the most valuable part: restating the rule
 * in words is the cheapest way to stop someone accidentally booking a room
 * three hundred times.
 *
 * Specification: docs/07-ui-screens.md, docs/12-recurrence.md section 4.
 */

import { AlertTriangle, CalendarX, Check, Repeat } from 'lucide-react'
import { useMemo, useState } from 'react'

import { describeRule, type RecurrenceRule, type RruleWeekday } from '@roombook/shared'

import { Button, Checkbox, Field, Input, Modal, Select, uiStyles } from '../ui/index.js'
import s from './recurrence.module.css'

const WEEKDAYS: Array<{ code: RruleWeekday; short: string }> = [
  { code: 'MO', short: 'Mon' },
  { code: 'TU', short: 'Tue' },
  { code: 'WE', short: 'Wed' },
  { code: 'TH', short: 'Thu' },
  { code: 'FR', short: 'Fri' },
  { code: 'SA', short: 'Sat' },
  { code: 'SU', short: 'Sun' },
]

type Ending = 'never' | 'until' | 'count'

export interface RecurrenceValue {
  enabled: boolean
  rule: RecurrenceRule
}

/** The weekday of a local date, as an RRULE code. */
function weekdayOf(localDate: string): RruleWeekday {
  const [y, m, d] = localDate.split('-').map(Number)
  const js = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()
  return WEEKDAYS[js === 0 ? 6 : js - 1]!.code
}

export function defaultRule(localDate: string): RecurrenceRule {
  return { freq: 'WEEKLY', interval: 1, byDay: [weekdayOf(localDate)] }
}

export function RecurrenceEditor({
  value,
  startLocalDate,
  startLocalTime,
  onChange,
}: {
  value: RecurrenceValue
  /** `YYYY-MM-DD` of the first occurrence, in the room timezone. */
  startLocalDate: string
  /** `HH:mm`, used only for the summary line. */
  startLocalTime: string
  onChange: (next: RecurrenceValue) => void
}) {
  const { enabled, rule } = value

  const [ending, setEnding] = useState<Ending>(() =>
    rule.count !== undefined ? 'count' : rule.until !== undefined ? 'until' : 'never',
  )

  const patch = (changes: Partial<RecurrenceRule>) =>
    onChange({ enabled, rule: { ...rule, ...changes } })

  /** The rule restated in words, updated as the controls change. */
  const summary = useMemo(() => {
    try {
      return describeRule(rule, `${startLocalDate}T${startLocalTime}`)
    } catch {
      return null
    }
  }, [rule, startLocalDate, startLocalTime])

  return (
    <div className={s.wrap}>
      <Checkbox
        label="Repeat this meeting"
        checked={enabled}
        onChange={e => {
          const on = e.target.checked
          onChange({ enabled: on, rule: on ? defaultRule(startLocalDate) : rule })
        }}
      />

      {enabled && (
        <div className={s.body}>
          <div className={s.row}>
            <span className={s.label}>Every</span>
            <Input
              type="number"
              min={1}
              max={52}
              className={s.interval}
              aria-label="Interval"
              value={rule.interval}
              onChange={e => patch({ interval: Math.max(1, Number(e.target.value) || 1) })}
            />
            <Select
              aria-label="Frequency"
              className={s.freq}
              value={rule.freq}
              onChange={e => {
                const freq = e.target.value as RecurrenceRule['freq']
                // Each shape needs different fields, so switching resets the
                // ones that no longer apply rather than leaving stale values.
                patch({
                  freq,
                  byDay: freq === 'WEEKLY' ? [weekdayOf(startLocalDate)] : undefined,
                  byMonthDay: undefined,
                  bySetPos: undefined,
                })
              }}
            >
              <option value="DAILY">{rule.interval === 1 ? 'day' : 'days'}</option>
              <option value="WEEKLY">{rule.interval === 1 ? 'week' : 'weeks'}</option>
              <option value="MONTHLY">{rule.interval === 1 ? 'month' : 'months'}</option>
              <option value="YEARLY">{rule.interval === 1 ? 'year' : 'years'}</option>
            </Select>
          </div>

          {rule.freq === 'WEEKLY' && (
            <div className={s.row}>
              <span className={s.label}>on</span>
              <div className={s.dayChips} role="group" aria-label="Repeat on these days">
                {WEEKDAYS.map(day => {
                  const on = rule.byDay?.includes(day.code) ?? false
                  return (
                    <button
                      key={day.code}
                      type="button"
                      aria-pressed={on}
                      className={on ? `${s.dayChip} ${s.dayChipOn}` : s.dayChip}
                      onClick={() => {
                        const current = rule.byDay ?? []
                        const next = on
                          ? current.filter(d => d !== day.code)
                          : [...current, day.code]
                        // Never leave a weekly rule with no day: it would
                        // produce nothing and the server would reject it.
                        patch({ byDay: next.length > 0 ? next : current })
                      }}
                    >
                      {day.short}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {rule.freq === 'MONTHLY' && (
            <div className={s.row}>
              <Select
                aria-label="Monthly pattern"
                value={rule.bySetPos !== undefined ? 'weekday' : 'date'}
                onChange={e =>
                  e.target.value === 'weekday'
                    ? patch({ bySetPos: 1, byDay: [weekdayOf(startLocalDate)], byMonthDay: undefined })
                    : patch({
                        bySetPos: undefined,
                        byDay: undefined,
                        byMonthDay: Number(startLocalDate.slice(8, 10)),
                      })
                }
              >
                <option value="date">On day {Number(startLocalDate.slice(8, 10))}</option>
                <option value="weekday">On a particular weekday</option>
              </Select>

              {rule.bySetPos !== undefined && (
                <>
                  <Select
                    aria-label="Which week"
                    value={rule.bySetPos}
                    onChange={e => patch({ bySetPos: Number(e.target.value) })}
                  >
                    <option value={1}>first</option>
                    <option value={2}>second</option>
                    <option value={3}>third</option>
                    <option value={4}>fourth</option>
                    <option value={-1}>last</option>
                  </Select>
                  <Select
                    aria-label="Which weekday"
                    value={rule.byDay?.[0] ?? 'MO'}
                    onChange={e => patch({ byDay: [e.target.value as RruleWeekday] })}
                  >
                    {WEEKDAYS.map(d => (
                      <option key={d.code} value={d.code}>
                        {d.short}
                      </option>
                    ))}
                  </Select>
                </>
              )}
            </div>
          )}

          <fieldset className={s.ending}>
            <legend className={s.label}>Ends</legend>

            <label className={s.radio}>
              <input
                type="radio"
                name="ending"
                checked={ending === 'never'}
                onChange={() => {
                  setEnding('never')
                  patch({ count: undefined, until: undefined })
                }}
              />
              Never
            </label>

            <label className={s.radio}>
              <input
                type="radio"
                name="ending"
                checked={ending === 'until'}
                onChange={() => {
                  setEnding('until')
                  patch({ count: undefined, until: addMonths(startLocalDate, 3) })
                }}
              />
              On
              <Input
                type="date"
                aria-label="End date"
                className={s.endDate}
                disabled={ending !== 'until'}
                value={rule.until ?? addMonths(startLocalDate, 3)}
                min={startLocalDate}
                onChange={e => patch({ until: e.target.value, count: undefined })}
              />
            </label>

            <label className={s.radio}>
              <input
                type="radio"
                name="ending"
                checked={ending === 'count'}
                onChange={() => {
                  setEnding('count')
                  patch({ until: undefined, count: 12 })
                }}
              />
              After
              <Input
                type="number"
                min={2}
                max={500}
                aria-label="Number of occurrences"
                className={s.interval}
                disabled={ending !== 'count'}
                value={rule.count ?? 12}
                onChange={e => patch({ count: Number(e.target.value) || 2, until: undefined })}
              />
              meetings
            </label>
          </fieldset>

          {/* The whole point: the rule restated in plain words, live. */}
          {summary && (
            <p className={s.summary}>
              <Repeat size={13} aria-hidden /> {summary}
            </p>
          )}

          {!rule.count && !rule.until && (
            <p className={s.openEnded}>
              An open-ended series is created about a year ahead and extended automatically.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function addMonths(localDate: string, months: number): string {
  const [y, m, d] = localDate.split('-').map(Number)
  const next = new Date(Date.UTC(y!, m! - 1 + months, d!))
  return next.toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// Conflict preview (S-27)
// ---------------------------------------------------------------------------

export interface SeriesPreviewData {
  description: string
  totalOccurrences: number
  available: number
  firstOccurrence: string | null
  lastOccurrence: string | null
  conflicts: Array<{
    occurrenceStartLocal: string
    reason: string
    detail?: string
    conflictingTitle?: string
  }>
  truncated: boolean
}

const REASON_TEXT: Record<string, string> = {
  BOOKING_CONFLICT: 'already booked',
  CLOSURE_CONFLICT: 'room closed',
  HOLIDAY: 'building closed',
  NON_EXISTENT_LOCAL_TIME: 'clocks change, this time does not exist',
  RULE_VIOLATION: 'outside bookable hours',
}

/**
 * Shown before anything is written.
 *
 * The confirm button states the real count, so nobody is surprised by what
 * they created — and a series that silently skipped three weeks is a meeting
 * people miss.
 */
export function SeriesPreviewDialog({
  preview,
  roomName,
  loading,
  onClose,
  onConfirm,
}: {
  preview: SeriesPreviewData
  roomName: string
  loading: boolean
  onClose: () => void
  onConfirm: (strategy: 'SKIP' | 'FAIL') => void
}) {
  const { available, totalOccurrences, conflicts } = preview
  const clean = conflicts.length === 0

  return (
    <Modal
      open
      onOpenChange={open => !open && onClose()}
      title={
        clean
          ? `${available} meetings are available`
          : `${available} of ${totalOccurrences} dates are free`
      }
      wide
      footer={
        <>
          <Button onClick={onClose}>Back</Button>
          {!clean && (
            <Button loading={loading} onClick={() => onConfirm('FAIL')}>
              Cancel and change the dates
            </Button>
          )}
          <Button
            variant="primary"
            loading={loading}
            disabled={available === 0}
            onClick={() => onConfirm('SKIP')}
          >
            {clean ? `Book ${available} meetings` : `Book ${available}, skip the rest`}
          </Button>
        </>
      }
    >
      <p className={s.previewPattern}>
        <Repeat size={14} aria-hidden /> {preview.description} in <strong>{roomName}</strong>
      </p>

      {clean && (
        <p className={s.previewClean}>
          <Check size={14} aria-hidden /> Every date is free.
        </p>
      )}

      {!clean && (
        <>
          <p className={s.previewWarn}>
            <AlertTriangle size={14} aria-hidden /> {conflicts.length}{' '}
            {conflicts.length === 1 ? 'date has' : 'dates have'} a problem:
          </p>

          <ul className={s.conflictList}>
            {conflicts.map(c => (
              <li key={c.occurrenceStartLocal} className={s.conflictItem}>
                <CalendarX size={13} aria-hidden />
                <span className={s.conflictDate}>
                  {formatLocalDate(c.occurrenceStartLocal)}
                </span>
                <span className={s.conflictReason}>
                  {c.conflictingTitle
                    ? `taken by "${c.conflictingTitle}"`
                    : (c.detail ?? REASON_TEXT[c.reason] ?? c.reason)}
                </span>
              </li>
            ))}
          </ul>

          <p className={uiStyles.hint}>
            Skipped dates are simply not booked. You will be told which in the confirmation email,
            and you can book them individually elsewhere.
          </p>
        </>
      )}

      {preview.truncated && (
        <p className={s.previewWarn}>
          <AlertTriangle size={14} aria-hidden /> This rule goes further than the booking horizon.
          Only the dates within it are created now; the rest follow automatically.
        </p>
      )}

      {available === 0 && (
        <p className={s.previewWarn}>
          Nothing can be booked with this rule. Try a different time or day.
        </p>
      )}
    </Modal>
  )
}

function formatLocalDate(local: string): string {
  const [y, m, d] = local.slice(0, 10).split('-').map(Number)
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y!, m! - 1, d!)))
}

// ---------------------------------------------------------------------------
// Scope chooser (S-28)
// ---------------------------------------------------------------------------

export type EditScopeChoice = 'THIS_OCCURRENCE' | 'THIS_AND_FOLLOWING' | 'ENTIRE_SERIES'

/**
 * Asked before any change to an occurrence of a series.
 *
 * The default differs by role on purpose: an admin reclaiming a room almost
 * always means today, while an organizer editing their own standup usually
 * means the series. Getting that default right saves a great many accidental
 * series-wide changes (D16).
 */
export function ScopeChooserDialog({
  title,
  action,
  defaultScope,
  loading,
  onClose,
  onChoose,
}: {
  title: string
  action: string
  defaultScope: EditScopeChoice
  loading: boolean
  onClose: () => void
  onChoose: (scope: EditScopeChoice) => void
}) {
  const [scope, setScope] = useState<EditScopeChoice>(defaultScope)

  const options: Array<{ value: EditScopeChoice; label: string; detail: string }> = [
    {
      value: 'THIS_OCCURRENCE',
      label: 'This occurrence only',
      detail: 'The rest of the series carries on unchanged.',
    },
    {
      value: 'THIS_AND_FOLLOWING',
      label: 'This and all following',
      detail: 'Earlier meetings are left alone, and the series ends here.',
    },
    {
      value: 'ENTIRE_SERIES',
      label: 'The entire series',
      detail: 'Every future meeting. Ones that already happened are never changed.',
    },
  ]

  return (
    <Modal
      open
      onOpenChange={open => !open && onClose()}
      title={`${action} "${title}"`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={loading} onClick={() => onChoose(scope)}>
            Continue
          </Button>
        </>
      }
    >
      <p>This is a repeating meeting. Apply the change to:</p>

      <div className={s.scopeOptions} role="radiogroup" aria-label="Apply to">
        {options.map(option => (
          <label
            key={option.value}
            className={scope === option.value ? `${s.scopeOption} ${s.scopeOptionOn}` : s.scopeOption}
          >
            <input
              type="radio"
              name="scope"
              checked={scope === option.value}
              onChange={() => setScope(option.value)}
            />
            <span>
              <strong>{option.label}</strong>
              <span className={s.scopeDetail}>{option.detail}</span>
            </span>
          </label>
        ))}
      </div>
    </Modal>
  )
}
