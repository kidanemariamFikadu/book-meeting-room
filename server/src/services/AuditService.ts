/**
 * The audit log.
 *
 * Append-only: nothing in this file updates or deletes a row, and no other
 * module is allowed to write to the table. `actorLabel` captures the name and
 * email at the time of the action, so the history stays readable after a user
 * is removed or renamed.
 *
 * Every write accepts a transaction client, because an audit row must be
 * written in the SAME transaction as the change it records. An audit log that
 * can disagree with the data it describes is worse than none.
 *
 * Specification: docs/01-requirements.md FR-6, docs/03-data-model.md.
 */

import type { Prisma, PrismaClient } from '@prisma/client'
import type { AuditEventType } from '@prisma/client'

import { prisma } from '../db.js'

/** Accepts either the client or an interactive-transaction client. */
export type Db = PrismaClient | Prisma.TransactionClient

export interface AuditActor {
  id?: string | null
  fullName?: string
  email?: string
  organizationId: string
}

export interface AuditInput {
  actor: AuditActor
  eventType: AuditEventType
  entityType: 'booking' | 'series' | 'room' | 'location' | 'user' | 'session' | 'display'
  entityId: string
  locationId?: string | null
  before?: unknown
  after?: unknown
  reason?: string | null
  ip?: string | null
  source?: 'USER' | 'ADMIN' | 'SYSTEM' | 'CALENDAR_SYNC'
}

function label(actor: AuditActor): string {
  if (!actor.id) return 'System'
  const name = actor.fullName?.trim()
  return name && actor.email ? `${name} <${actor.email}>` : (actor.email ?? actor.id)
}

export async function record(input: AuditInput, db: Db = prisma): Promise<void> {
  await db.auditEvent.create({
    data: {
      organizationId: input.actor.organizationId,
      actorId: input.actor.id ?? null,
      actorLabel: label(input.actor),
      actorSource: input.source ?? (input.actor.id ? 'USER' : 'SYSTEM'),
      eventType: input.eventType,
      entityType: input.entityType,
      entityId: input.entityId,
      locationId: input.locationId ?? null,
      before: (input.before ?? null) as Prisma.InputJsonValue,
      after: (input.after ?? null) as Prisma.InputJsonValue,
      reason: input.reason ?? null,
      ip: input.ip ?? null,
    },
  })
}

/**
 * Snapshots only the fields that differ, rather than whole rows.
 *
 * A diff of two 30-column rows is unreadable and makes the log expensive to
 * store; what a reviewer wants to know is what changed.
 */
export function diff<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
): { before: Partial<T>; after: Partial<T> } | null {
  const b: Partial<T> = {}
  const a: Partial<T> = {}
  let changed = false

  for (const key of Object.keys(after) as Array<keyof T>) {
    const next = after[key]
    if (next === undefined) continue
    const prev = before[key]
    // Dates and arrays need value comparison, not reference comparison.
    const same =
      prev instanceof Date && next instanceof Date
        ? prev.getTime() === next.getTime()
        : Array.isArray(prev) && Array.isArray(next)
          ? JSON.stringify([...prev].sort()) === JSON.stringify([...next].sort())
          : prev === next
    if (!same) {
      b[key] = prev
      a[key] = next as T[keyof T]
      changed = true
    }
  }

  return changed ? { before: b, after: a } : null
}
