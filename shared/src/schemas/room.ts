/**
 * Room, location, closure and display schemas
 * (docs/05-api-spec.md sections 3 and 5d, docs/14-multi-location.md).
 */

import { z } from 'zod'
import { isoInstant, localDate, reason, uuid } from './booking.js'

/**
 * `null` means "inherit from the level above"; an explicit `0` is a real value
 * and must not fall through. That distinction is the commonest configuration
 * bug in this system, which is why resolution lives in one shared helper
 * (`resolveSetting`) and is tested directly (T-166).
 */
const inheritableInt = (min: number, max: number) =>
  z.number().int().min(min).max(max).nullable().optional()

const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm')

export const roomLimitsSchema = z
  .object({
    minBookingMinutes: inheritableInt(5, 1440),
    maxBookingMinutes: inheritableInt(5, 10080),
    maxAdvanceDays: inheritableInt(0, 3650),
    minNoticeMinutes: inheritableInt(0, 100000),
  })
  .strict()

export const roomHoursSchema = z
  .array(
    z
      .object({
        weekday: z.number().int().min(1).max(7), // ISO, Monday = 1
        startLocal: localTime,
        endLocal: localTime,
      })
      .strict()
      .refine(h => h.startLocal < h.endLocal, {
        message: 'The closing time must be after the opening time',
        path: ['endLocal'],
      }),
  )
  .max(28) // allows up to four windows per weekday, e.g. a lunch break

export const createRoomSchema = z
  .object({
    locationId: uuid,
    name: z.string().trim().min(1, 'A room name is required').max(120),
    capacity: z.number().int().min(1, 'Capacity must be at least 1').max(10000),
    floor: z.string().trim().max(60).optional(),
    description: z.string().trim().max(2000).optional(),
    colour: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, 'Expected a hex colour such as #2563eb')
      .optional(),
    featureIds: z.array(uuid).max(50).default([]),
    requiresApproval: z.boolean().default(false),
    approverUserId: uuid.nullable().optional(),
    approvalWindowHours: inheritableInt(1, 720),
    providerResourceEmail: z.string().trim().email().nullable().optional(),
    limits: roomLimitsSchema.optional(),
    hours: roomHoursSchema.optional(),
  })
  .strict()

export type CreateRoomInput = z.infer<typeof createRoomSchema>

export const updateRoomSchema = createRoomSchema.partial().strict()

export const deactivateRoomSchema = z
  .object({
    /**
     * Without `force`, a room with future bookings returns 409 listing them, so
     * the admin resolves them first (BR-R4).
     */
    force: z.boolean().default(false),
  })
  .strict()

export const createClosureSchema = z
  .object({ startsAt: isoInstant, endsAt: isoInstant, reason })
  .strict()
  .refine(c => new Date(c.startsAt).getTime() < new Date(c.endsAt).getTime(), {
    message: 'The closure must end after it starts',
    path: ['endsAt'],
  })

export const createLocationSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    code: z.string().trim().max(12).optional(),
    address: z.string().trim().max(500).optional(),
    /** IANA zone, authoritative for every room in this location (BR-T4). */
    timezone: z.string().min(1, 'Choose a timezone'),
    /** ISO 3166-1 alpha-2, used to seed the holiday calendar (D18). */
    country: z.string().trim().length(2).optional(),
    businessHoursStart: localTime.nullable().optional(),
    businessHoursEnd: localTime.nullable().optional(),
    /** ISO weekdays. A Dubai office working Sun-Thu is [7,1,2,3,4] (US-L5). */
    businessDays: z.array(z.number().int().min(1).max(7)).max(7).optional(),
    minBookingMinutes: inheritableInt(5, 1440),
    maxBookingMinutes: inheritableInt(5, 10080),
    maxAdvanceDays: inheritableInt(0, 3650),
    minNoticeMinutes: inheritableInt(0, 100000),
    reminderLeadMinutes: inheritableInt(0, 10080),
    sortOrder: z.number().int().min(0).max(9999).optional(),
  })
  .strict()

export const updateLocationSchema = createLocationSchema.partial().strict()

export const holidaySchema = z
  .object({ date: localDate, name: z.string().trim().min(1).max(200) })
  .strict()

export const createFeatureSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    icon: z.string().trim().max(60).optional(),
    sortOrder: z.number().int().min(0).max(999).optional(),
  })
  .strict()

/**
 * A door or lobby screen (D11, D21 — docs/07-ui-screens.md section 8).
 * `showTitles` defaults to false because a screen in a public area displaying
 * "Exit interview - J. Smith" is a real incident, so the safe default is not
 * optional.
 */
export const createDisplaySchema = z
  .object({
    label: z.string().trim().min(1).max(120),
    locationId: uuid.optional(),
    roomId: uuid.optional(),
    showTitles: z.boolean().default(false),
  })
  .strict()
  .refine(d => (d.locationId === undefined) !== (d.roomId === undefined), {
    message: 'A display shows either one location or one room, not both',
  })

export type CreateDisplayInput = z.infer<typeof createDisplaySchema>
