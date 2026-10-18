/**
 * User and organization-settings schemas
 * (docs/05-api-spec.md sections 6 and 7).
 */

import { z } from 'zod'
import { ROLES } from '../enums.js'
import { email } from './auth.js'
import { uuid } from './booking.js'

/**
 * Location grants (D17). This is part of the same form that sets the role, so
 * appointing an admin and scoping them is one action rather than two.
 *
 * An empty `locationIds` with `allLocations: false` means an ADMIN is
 * organization-wide, which keeps single-site installations behaving exactly as
 * they did before locations became first-class.
 */
export const locationAccessSchema = z
  .object({
    locationIds: z.array(uuid).max(200).default([]),
    /**
     * A standing grant. Differs from ticking every box: a location created next
     * year is included automatically, which is what an operations lead wants.
     */
    allLocations: z.boolean().default(false),
  })
  .strict()

export type LocationAccessInput = z.infer<typeof locationAccessSchema>

export const inviteUserSchema = z
  .object({
    email,
    fullName: z.string().trim().min(1).max(120),
    role: z.enum(ROLES).default('EMPLOYEE'),
    homeLocationId: uuid.optional(),
    locationAccess: locationAccessSchema.optional(),
  })
  .strict()

export type InviteUserInput = z.infer<typeof inviteUserSchema>

export const updateUserSchema = z
  .object({
    fullName: z.string().trim().min(1).max(120).optional(),
    role: z.enum(ROLES).optional(),
    timezone: z.string().min(1).nullable().optional(),
    homeLocationId: uuid.nullable().optional(),
    locationAccess: locationAccessSchema.optional(),
    emailOptOutReminders: z.boolean().optional(),
  })
  .strict()

/**
 * What a user may change about themselves. Notably excludes `role` and
 * `locationAccess` — nobody escalates their own privileges (BR-U7).
 */
export const updateOwnProfileSchema = updateUserSchema
  .omit({ role: true, locationAccess: true })
  .strict()

export const deactivateUserSchema = z.object({ force: z.boolean().default(false) }).strict()

export const orgSettingsSchema = z
  .object({
    businessHoursStart: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .optional(),
    businessHoursEnd: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .optional(),
    businessDays: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
    slotGranularityMinutes: z
      .union([z.literal(5), z.literal(10), z.literal(15), z.literal(30)])
      .optional(),
    minBookingMinutes: z.number().int().min(5).max(1440).optional(),
    maxBookingMinutes: z.number().int().min(5).max(10080).optional(),
    maxAdvanceDays: z.number().int().min(0).max(3650).optional(),
    minNoticeMinutes: z.number().int().min(0).max(100000).optional(),
    reminderLeadMinutes: z.number().int().min(0).max(10080).optional(),
    /**
     * D6: ships `false` — only organizers receive RoomBook email in v1.
     * Flipping this to true is how attendee email gets enabled later, with no
     * build required because the templates already exist and are tested.
     */
    notifyAttendees: z.boolean().optional(),
    allowExternalAttendees: z.boolean().optional(),
    bookingRetentionMonths: z.number().int().min(1).max(240).optional(),
    recurrenceHorizonDays: z.number().int().min(30).max(1095).optional(),
    maxOccurrencesPerSeries: z.number().int().min(10).max(1000).optional(),
    approvalWindowHours: z.number().int().min(1).max(720).optional(),
    emailFromName: z.string().trim().min(1).max(120).optional(),
    emailFromAddress: z.string().trim().email().optional(),
  })
  .strict()

export type OrgSettingsInput = z.infer<typeof orgSettingsSchema>
