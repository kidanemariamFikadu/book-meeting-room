-- CreateEnum
CREATE TYPE "Role" AS ENUM ('EMPLOYEE', 'ADMIN', 'OWNER');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('INVITED', 'ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('PENDING_APPROVAL', 'CONFIRMED', 'ENDED_EARLY', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SeriesStatus" AS ENUM ('ACTIVE', 'ENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TokenPurpose" AS ENUM ('INVITE', 'PASSWORD_RESET', 'EMAIL_CHANGE');

-- CreateEnum
CREATE TYPE "AttendeeResponse" AS ENUM ('NEEDS_ACTION', 'ACCEPTED', 'DECLINED', 'TENTATIVE');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CalendarProvider" AS ENUM ('GOOGLE', 'MICROSOFT');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('ACTIVE', 'NEEDS_REAUTH', 'REVOKED', 'ERROR');

-- CreateEnum
CREATE TYPE "SyncState" AS ENUM ('PENDING', 'SYNCED', 'FAILED', 'DETACHED');

-- CreateEnum
CREATE TYPE "SyncJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "AuditEventType" AS ENUM ('BOOKING_CREATED', 'BOOKING_UPDATED', 'BOOKING_MOVED', 'BOOKING_CANCELLED', 'BOOKING_ENDED_EARLY', 'BOOKING_APPROVED', 'BOOKING_REJECTED', 'BOOKING_EXPIRED', 'BOOKING_TRANSFERRED', 'SERIES_CREATED', 'SERIES_UPDATED', 'SERIES_CANCELLED', 'ROOM_CREATED', 'ROOM_UPDATED', 'ROOM_DEACTIVATED', 'LOCATION_CREATED', 'LOCATION_UPDATED', 'LOCATION_DEACTIVATED', 'USER_INVITED', 'USER_ROLE_CHANGED', 'USER_LOCATION_ACCESS_CHANGED', 'USER_DEACTIVATED', 'LOGIN_SUCCEEDED', 'LOGIN_FAILED', 'CALENDAR_CONNECTED', 'CALENDAR_DISCONNECTED', 'CALENDAR_CHANGE_REJECTED', 'DISPLAY_TOKEN_CREATED', 'DISPLAY_TOKEN_REVOKED');

-- CreateEnum
CREATE TYPE "ActorSource" AS ENUM ('USER', 'ADMIN', 'SYSTEM', 'CALENDAR_SYNC');

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "defaultTimezone" TEXT NOT NULL DEFAULT 'UTC',
    "logoUrl" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_settings" (
    "organizationId" TEXT NOT NULL,
    "businessHoursStart" TEXT NOT NULL DEFAULT '08:00',
    "businessHoursEnd" TEXT NOT NULL DEFAULT '18:00',
    "businessDays" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5]::INTEGER[],
    "slotGranularityMinutes" INTEGER NOT NULL DEFAULT 15,
    "minBookingMinutes" INTEGER NOT NULL DEFAULT 15,
    "maxBookingMinutes" INTEGER NOT NULL DEFAULT 480,
    "maxAdvanceDays" INTEGER NOT NULL DEFAULT 90,
    "minNoticeMinutes" INTEGER NOT NULL DEFAULT 0,
    "reminderLeadMinutes" INTEGER NOT NULL DEFAULT 15,
    "notifyAttendees" BOOLEAN NOT NULL DEFAULT false,
    "allowExternalAttendees" BOOLEAN NOT NULL DEFAULT true,
    "bookingRetentionMonths" INTEGER NOT NULL DEFAULT 24,
    "recurrenceHorizonDays" INTEGER NOT NULL DEFAULT 365,
    "maxOccurrencesPerSeries" INTEGER NOT NULL DEFAULT 500,
    "approvalWindowHours" INTEGER NOT NULL DEFAULT 24,
    "emailFromName" TEXT NOT NULL DEFAULT 'RoomBook',
    "emailFromAddress" TEXT NOT NULL DEFAULT 'rooms@example.com',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "org_settings_pkey" PRIMARY KEY ("organizationId")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "fullName" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'EMPLOYEE',
    "status" "UserStatus" NOT NULL DEFAULT 'INVITED',
    "timezone" TEXT,
    "homeLocationId" TEXT,
    "emailOptOutReminders" BOOLEAN NOT NULL DEFAULT false,
    "lastLoginAt" TIMESTAMPTZ(3),
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" "TokenPurpose" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "newEmail" TEXT,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_location_access" (
    "userId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_location_access_pkey" PRIMARY KEY ("userId","locationId")
);

-- CreateTable
CREATE TABLE "locations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "address" TEXT,
    "timezone" TEXT NOT NULL,
    "country" TEXT,
    "businessHoursStart" TEXT,
    "businessHoursEnd" TEXT,
    "businessDays" INTEGER[],
    "minBookingMinutes" INTEGER,
    "maxBookingMinutes" INTEGER,
    "maxAdvanceDays" INTEGER,
    "minNoticeMinutes" INTEGER,
    "reminderLeadMinutes" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "location_holidays" (
    "id" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "location_holidays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rooms" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL,
    "floor" TEXT,
    "description" TEXT,
    "photoUrl" TEXT,
    "colour" TEXT NOT NULL DEFAULT '#2563eb',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "approverUserId" TEXT,
    "approvalWindowHours" INTEGER,
    "minBookingMinutes" INTEGER,
    "maxBookingMinutes" INTEGER,
    "maxAdvanceDays" INTEGER,
    "minNoticeMinutes" INTEGER,
    "providerResourceEmail" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_features" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "room_features_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_feature_assignments" (
    "roomId" TEXT NOT NULL,
    "featureId" TEXT NOT NULL,

    CONSTRAINT "room_feature_assignments_pkey" PRIMARY KEY ("roomId","featureId")
);

-- CreateTable
CREATE TABLE "room_hours" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "startLocal" TEXT NOT NULL,
    "endLocal" TEXT NOT NULL,

    CONSTRAINT "room_hours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_closures" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "room_closures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_series" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "organizerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "isPrivate" BOOLEAN NOT NULL DEFAULT false,
    "rrule" TEXT NOT NULL,
    "dtstartLocal" TEXT NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "timezone" TEXT NOT NULL,
    "horizonUntil" TIMESTAMPTZ(3) NOT NULL,
    "status" "SeriesStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "booking_series_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bookings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "organizerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'CONFIRMED',
    "isPrivate" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelledById" TEXT,
    "cancellationReason" TEXT,
    "endedEarlyAt" TIMESTAMPTZ(3),
    "endedEarlyById" TEXT,
    "approvalNote" TEXT,
    "approvalExpiresAt" TIMESTAMPTZ(3),
    "approvedAt" TIMESTAMPTZ(3),
    "approvedById" TEXT,
    "rejectedAt" TIMESTAMPTZ(3),
    "rejectedById" TEXT,
    "rejectionReason" TEXT,
    "seriesId" TEXT,
    "occurrenceStartLocal" TEXT,
    "isException" BOOLEAN NOT NULL DEFAULT false,
    "exceptionFields" TEXT[],
    "icsUid" TEXT NOT NULL,
    "icsSequence" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_attendees" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "userId" TEXT,
    "email" TEXT NOT NULL,
    "displayName" TEXT,
    "response" "AttendeeResponse" NOT NULL DEFAULT 'NEEDS_ACTION',
    "respondedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_attendees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "actorId" TEXT,
    "actorLabel" TEXT NOT NULL,
    "actorSource" "ActorSource" NOT NULL DEFAULT 'USER',
    "eventType" "AuditEventType" NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "locationId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_outbox" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "bookingId" TEXT,
    "seriesId" TEXT,
    "template" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "toName" TEXT,
    "subject" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "bodyHtml" TEXT,
    "bodyText" TEXT,
    "icsMethod" TEXT,
    "status" "OutboxStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "scheduledAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_connections" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "CalendarProvider" NOT NULL,
    "providerAccountEmail" TEXT NOT NULL,
    "accessTokenEncrypted" BYTEA NOT NULL,
    "refreshTokenEncrypted" BYTEA NOT NULL,
    "tokenExpiresAt" TIMESTAMPTZ(3) NOT NULL,
    "scopes" TEXT NOT NULL,
    "calendarId" TEXT NOT NULL DEFAULT 'primary',
    "syncToken" TEXT,
    "webhookChannelId" TEXT,
    "webhookResourceId" TEXT,
    "webhookExpiresAt" TIMESTAMPTZ(3),
    "status" "ConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastSyncAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "calendar_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_calendar_links" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT,
    "seriesId" TEXT,
    "connectionId" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "providerInstanceId" TEXT,
    "providerEtag" TEXT,
    "lastPushedHash" TEXT,
    "syncState" "SyncState" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "booking_calendar_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_sync_jobs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "bookingId" TEXT,
    "seriesId" TEXT,
    "operation" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "SyncJobStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "scheduledAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calendar_sync_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "display_tokens" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "locationId" TEXT,
    "roomId" TEXT,
    "showTitles" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "display_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE INDEX "users_organizationId_status_idx" ON "users"("organizationId", "status");

-- CreateIndex
CREATE INDEX "users_homeLocationId_idx" ON "users"("homeLocationId");

-- CreateIndex
CREATE UNIQUE INDEX "users_organizationId_email_key" ON "users"("organizationId", "email");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "auth_tokens_tokenHash_key" ON "auth_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "auth_tokens_userId_purpose_idx" ON "auth_tokens"("userId", "purpose");

-- CreateIndex
CREATE INDEX "auth_tokens_expiresAt_idx" ON "auth_tokens"("expiresAt");

-- CreateIndex
CREATE INDEX "user_location_access_userId_idx" ON "user_location_access"("userId");

-- CreateIndex
CREATE INDEX "locations_organizationId_isActive_idx" ON "locations"("organizationId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "locations_organizationId_name_key" ON "locations"("organizationId", "name");

-- CreateIndex
CREATE INDEX "location_holidays_locationId_idx" ON "location_holidays"("locationId");

-- CreateIndex
CREATE UNIQUE INDEX "location_holidays_locationId_date_key" ON "location_holidays"("locationId", "date");

-- CreateIndex
CREATE INDEX "rooms_organizationId_isActive_idx" ON "rooms"("organizationId", "isActive");

-- CreateIndex
CREATE INDEX "rooms_locationId_isActive_idx" ON "rooms"("locationId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "rooms_locationId_name_key" ON "rooms"("locationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "room_features_organizationId_name_key" ON "room_features"("organizationId", "name");

-- CreateIndex
CREATE INDEX "room_feature_assignments_featureId_idx" ON "room_feature_assignments"("featureId");

-- CreateIndex
CREATE INDEX "room_hours_roomId_idx" ON "room_hours"("roomId");

-- CreateIndex
CREATE UNIQUE INDEX "room_hours_roomId_weekday_startLocal_key" ON "room_hours"("roomId", "weekday", "startLocal");

-- CreateIndex
CREATE INDEX "room_closures_roomId_startsAt_endsAt_idx" ON "room_closures"("roomId", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "booking_series_organizationId_status_idx" ON "booking_series"("organizationId", "status");

-- CreateIndex
CREATE INDEX "booking_series_status_horizonUntil_idx" ON "booking_series"("status", "horizonUntil");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_icsUid_key" ON "bookings"("icsUid");

-- CreateIndex
CREATE INDEX "bookings_roomId_startsAt_endsAt_idx" ON "bookings"("roomId", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "bookings_organizationId_startsAt_idx" ON "bookings"("organizationId", "startsAt");

-- CreateIndex
CREATE INDEX "bookings_organizerId_startsAt_idx" ON "bookings"("organizerId", "startsAt");

-- CreateIndex
CREATE INDEX "bookings_seriesId_startsAt_idx" ON "bookings"("seriesId", "startsAt");

-- CreateIndex
CREATE INDEX "bookings_status_approvalExpiresAt_idx" ON "bookings"("status", "approvalExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_seriesId_occurrenceStartLocal_key" ON "bookings"("seriesId", "occurrenceStartLocal");

-- CreateIndex
CREATE INDEX "booking_attendees_userId_idx" ON "booking_attendees"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "booking_attendees_bookingId_email_key" ON "booking_attendees"("bookingId", "email");

-- CreateIndex
CREATE INDEX "audit_events_entityType_entityId_createdAt_idx" ON "audit_events"("entityType", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_events_organizationId_createdAt_idx" ON "audit_events"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_events_actorId_createdAt_idx" ON "audit_events"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "email_outbox_status_scheduledAt_idx" ON "email_outbox"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "email_outbox_bookingId_idx" ON "email_outbox"("bookingId");

-- CreateIndex
CREATE INDEX "email_outbox_organizationId_createdAt_idx" ON "email_outbox"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_connections_userId_key" ON "calendar_connections"("userId");

-- CreateIndex
CREATE INDEX "calendar_connections_status_webhookExpiresAt_idx" ON "calendar_connections"("status", "webhookExpiresAt");

-- CreateIndex
CREATE INDEX "booking_calendar_links_bookingId_idx" ON "booking_calendar_links"("bookingId");

-- CreateIndex
CREATE INDEX "booking_calendar_links_seriesId_idx" ON "booking_calendar_links"("seriesId");

-- CreateIndex
CREATE UNIQUE INDEX "booking_calendar_links_connectionId_providerEventId_provide_key" ON "booking_calendar_links"("connectionId", "providerEventId", "providerInstanceId");

-- CreateIndex
CREATE INDEX "calendar_sync_jobs_status_scheduledAt_idx" ON "calendar_sync_jobs"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "calendar_sync_jobs_bookingId_idx" ON "calendar_sync_jobs"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "display_tokens_tokenHash_key" ON "display_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "display_tokens_organizationId_idx" ON "display_tokens"("organizationId");

-- AddForeignKey
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_homeLocationId_fkey" FOREIGN KEY ("homeLocationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_location_access" ADD CONSTRAINT "user_location_access_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_location_access" ADD CONSTRAINT "user_location_access_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_holidays" ADD CONSTRAINT "location_holidays_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_approverUserId_fkey" FOREIGN KEY ("approverUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_features" ADD CONSTRAINT "room_features_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_feature_assignments" ADD CONSTRAINT "room_feature_assignments_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_feature_assignments" ADD CONSTRAINT "room_feature_assignments_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "room_features"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_hours" ADD CONSTRAINT "room_hours_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_closures" ADD CONSTRAINT "room_closures_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_closures" ADD CONSTRAINT "room_closures_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_series" ADD CONSTRAINT "booking_series_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_series" ADD CONSTRAINT "booking_series_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_series" ADD CONSTRAINT "booking_series_organizerId_fkey" FOREIGN KEY ("organizerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_organizerId_fkey" FOREIGN KEY ("organizerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_endedEarlyById_fkey" FOREIGN KEY ("endedEarlyById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_rejectedById_fkey" FOREIGN KEY ("rejectedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "booking_series"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_attendees" ADD CONSTRAINT "booking_attendees_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_attendees" ADD CONSTRAINT "booking_attendees_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_calendar_links" ADD CONSTRAINT "booking_calendar_links_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_calendar_links" ADD CONSTRAINT "booking_calendar_links_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "booking_series"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_calendar_links" ADD CONSTRAINT "booking_calendar_links_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "calendar_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_sync_jobs" ADD CONSTRAINT "calendar_sync_jobs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_sync_jobs" ADD CONSTRAINT "calendar_sync_jobs_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "display_tokens" ADD CONSTRAINT "display_tokens_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "display_tokens" ADD CONSTRAINT "display_tokens_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "display_tokens" ADD CONSTRAINT "display_tokens_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "display_tokens" ADD CONSTRAINT "display_tokens_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
