# 08 — Security & Privacy

## 1. What this system holds

| Data | Sensitivity | Handling |
|------|-------------|----------|
| Names and work email addresses | Low–moderate (personal data) | Visible to authenticated staff only |
| Password hashes | High | Argon2id; never logged, never returned by any endpoint |
| Session identifiers | High | `HttpOnly`, `Secure`, `SameSite=Lax`; server-side storage |
| Invite and reset tokens | High | Stored hashed; single use; short-lived |
| Meeting titles and descriptions | Moderate — can reveal reorganizations, deals, dismissals | Private-booking flag (BR-P3); never exposed to unauthenticated requests |
| External attendee addresses | Moderate (third-party personal data) | Visible to organizer, attendees and admins only |
| Audit log | Moderate | Admin only; append-only |
| **OAuth calendar tokens** | **Highest in the system** | AES-256-GCM encrypted at rest with a key held separately from the database; never logged; revoked at the provider on disconnect or deactivation ([13 §8](13-calendar-sync.md#8-security)) |
| Attendee RSVP responses | Moderate | Visible to organizer, attendees and admins |

The meeting-title point is worth stating plainly to stakeholders: a room booking system is a
quiet map of what an organization is doing. "Exit interview — J. Smith" in a title that the
whole company can read is a real incident. Hence BR-P3 and the per-booking privacy flag.

## 2. Authentication

| Control | Decision |
|---------|----------|
| Password hashing | Argon2id, memory 19 MiB, iterations 2, parallelism 1 (OWASP minimum), tuned upward if the host allows |
| Password policy | Minimum 12 characters; checked against a common-password list; **no composition rules and no forced rotation** — both are known to produce weaker passwords |
| Login throttling | 5 failures per email per 15 min, 20 per IP per 15 min (FR-1.4) |
| User enumeration | Login, forgot-password and invite-acceptance return identical responses and comparable timings for existing and non-existing accounts. A dummy Argon2 verification runs when no user is found, so the response time does not leak existence |
| Session cookie | `HttpOnly`, `Secure`, `SameSite=Lax`, `__Host-` prefix, no `Domain` attribute |
| Session lifetime | 12 h idle, 30 d absolute |
| Session fixation | Identifier rotated on login and on privilege change |
| Session invalidation | All of a user's sessions are destroyed on password change, password reset, role change and deactivation |
| Token storage | Invite and reset tokens are 256-bit random, compared in constant time, stored as SHA-256, single use, expiring in 72 h and 1 h |
| Multi-factor | Not in v1. Noted as the first security item in the post-v1 backlog |

## 3. Authorization

Enforced in `shared/permissions.ts` — **one file, one function per action**, so the rules can
be read and tested in isolation rather than inferred from scattered `if` statements.

```ts
can(actor, 'booking:cancel', booking) → boolean
```

Because it lives in `shared/`, the **same function** decides what the React UI renders and what
the Express endpoint allows. They cannot disagree. But note the asymmetry that matters:

> **The client's use of `can()` is cosmetic. The server's use of it is the control.**
> A user can edit the JavaScript bundle in their own browser; they cannot edit the server. Every
> endpoint calls `can()` itself, on the server, against the session user — never trusting that
> the client already checked. Test T-60 sweeps every admin endpoint as an employee and expects
> 403 from each.

Three rules that are never broken:

1. **Every query is scoped by `organization_id`**, taken from the session, never from the
   request. A crafted ID for another organization returns 404, not 403 — existence itself is
   not disclosed.
2. **Ownership is verified against the database**, never against a hidden form field. A request
   claiming `organizerId` is ignored unless the caller is an admin.
3. **The UI hiding a control is a convenience, not a control.** Every endpoint re-checks.
4. **Redaction happens on the server.** A private booking the viewer may not see is never sent
   to the browser with its title and then hidden by a component — the API returns "Busy" and
   `organizer: null` (BR-P3, T-111). Data the client should not have must not reach the client.

### 4. Authorization matrix

| Action | Employee | Admin | Owner |
|--------|:--------:|:-----:|:-----:|
| View rooms and availability | ✅ | ✅ | ✅ |
| View own bookings | ✅ | ✅ | ✅ |
| View others' booking details | ✅¹ | ✅ | ✅ |
| Create a booking for self | ✅ | ✅ | ✅ |
| Create a booking for another user | ❌ | ✅ | ✅ |
| Edit own future booking | ✅ | ✅ | ✅ |
| Edit another user's booking | ❌ | ✅ | ✅ |
| Cancel own future booking | ✅ | ✅ | ✅ |
| Cancel another user's booking | ❌ | ✅²⁴ | ✅² |
| Move any booking | ❌ | ✅²⁴ | ✅² |
| Move or cancel **one occurrence** of a series | ❌ | ✅²⁴ | ✅² |
| Edit or cancel an **entire series** | Own only | ✅²⁴ | ✅² |
| Reassign organizer | ❌ | ✅²⁴ | ✅² |
| Create, edit, deactivate **locations** | ❌ | ❌ | ✅ |
| Grant location-scoped admin | ❌ | ❌ | ✅ |
| Connect / disconnect **own** calendar | ✅ | ✅ | ✅ |
| View another user's calendar connection status | ❌ | ✅ (health only, no tokens) | ✅ |
| Map a room to a provider resource | ❌ | ✅⁴ | ✅ |
| Modify a past booking | ❌ | ❌ | ❌ |
| Create, edit, deactivate rooms | ❌ | ✅ | ✅ |
| Manage closures, features, locations | ❌ | ✅ | ✅ |
| View audit log and email log | ❌ | ✅ | ✅ |
| Resend a failed email | ❌ | ✅ | ✅ |
| View utilization reports | ❌ | ✅ | ✅ |
| Invite, deactivate users | ❌ | ❌ | ✅ |
| Change roles | ❌ | ❌ | ✅³ |
| Change organization settings | ❌ | ❌ | ✅ |

¹ Subject to BR-P3: private bookings show as "Busy" to uninvolved employees.
² Requires a written reason, which is emailed to the organizer and stored in the audit log.
³ Cannot change own role; the last owner cannot be demoted (BR-U6, BR-U7).
⁴ **Location-scoped admins only within their assigned locations** (BR-L1, BR-L2). An admin with
no location grants is organization-wide, which keeps the single-site case unchanged.

## 5. Web application controls

| Threat | Control |
|--------|---------|
| **CSRF** | Double-submit token on every state-changing request, plus `SameSite=Lax`. The token is per-session and rotated on login |
| **XSS** | React escapes everything it renders. `dangerouslySetInnerHTML` is banned outright by an ESLint rule with no exceptions — there is no case in this product that needs it. A strict Content-Security-Policy with no `unsafe-inline` and no `unsafe-eval`, which Vite's built output satisfies. **Email templates are the separate risk** and are escaped server-side (see the two rows below) |
| **XSS via browser storage** | There is nothing to steal: the session is an `HttpOnly` cookie, and no token, credential or personal data is written to `localStorage` or `sessionStorage` |
| **SQL injection** | Prisma parameterizes everything. Raw SQL appears only in the overlap-constraint migration, which contains no user input |
| **Clickjacking** | `frame-ancestors 'none'` and `X-Frame-Options: DENY` |
| **MIME sniffing** | `X-Content-Type-Options: nosniff` |
| **Transport** | HTTPS enforced; HSTS with a 1-year max-age once the certificate is stable |
| **Open redirect** | Post-login redirect targets are validated against an allowlist of internal paths |
| **Mass assignment** | Zod schemas use `.strict()`; unknown keys are rejected rather than ignored |
| **IDOR** | Every fetch-by-ID is scoped by organization and then permission-checked (section 3) |
| **Email header injection** | Recipient names and subjects are sanitized of CR/LF before reaching nodemailer |
| **HTML injection in emails** | All template variables — especially the free-text cancellation reason — are HTML-escaped. The reason is user input that an admin types and the organizer reads; it is not trusted |
| **ICS injection** | `.ics` field values are escaped per RFC 5545 (commas, semicolons, backslashes, newlines) |
| **Denial of service** | Rate limits per IP, per session and per action; a 100 KB body limit; a 31-day cap on availability range queries |
| **OAuth token theft** | Encrypted at rest with a key outside the database; minimum scopes; redacted from logs by a tested Pino serializer; revoked at the provider on disconnect ([13 §8](13-calendar-sync.md#8-security)) |
| **Forged webhooks** | Validate Google's channel token and Microsoft's `clientState`; rate-limit and size-cap the endpoints; **never act on the payload** — always re-read state from the provider API (T-151, T-152) |
| **OAuth redirect manipulation** | Exact-match registered redirect URIs; PKCE; `state` bound to the session |
| **Sync loop / runaway writes** | Three independent defences ([13 §5](13-calendar-sync.md#loop-prevention)), each tested separately |
| **Recurrence resource exhaustion** | 500-occurrence and 365-day ceilings enforced server-side before any write (T-132) |
| **Cross-location privilege escalation** | Every admin action re-checks location scope server-side; the move dialog never lists out-of-scope rooms (T-161, T-162) |
| **Dependency risk** | `npm audit` in CI failing on high severity; Dependabot; lockfile committed |
| **Secrets** | Only from environment variables, validated at boot. `.env` is git-ignored; `.env.example` holds names and dummy values only |

## 6. Logging and privacy in logs

- Structured JSON (Pino) with a request ID, user ID, route, status and duration.
- **Never logged:** passwords, password hashes, session identifiers, invite or reset tokens,
  full email bodies.
- Email addresses in logs are partially masked (`a***e@acme.com`) outside the admin email log.
- Full stack traces go to logs only; the user sees a generic message plus the request ID.
- Default log retention 30 days; audit rows are kept far longer and are the record of record.

## 7. Data protection

| Topic | Position |
|-------|----------|
| **Lawful basis** | Legitimate interest of the employer in managing its facilities. Document this if the organization is in a GDPR jurisdiction |
| **Minimization** | Only name, work email, role and timezone are stored about a person. No phone number, no photo, no personal address |
| **Retention** | Bookings 24 months then archived (D8); audit longer; sessions and tokens swept nightly |
| **Subject access** | An owner can export everything the system holds about one user from the admin screens; the audit log covers the rest |
| **Erasure** | A user can be anonymized — name replaced with "Former employee", email tombstoned — while bookings and audit rows survive for operational integrity. Hard deletion of a user with bookings is not offered |
| **External attendees** | Their addresses are third-party personal data. They are stored only on the booking they relate to, and removed with it at the retention boundary |
| **Transfers** | Email passes through whatever relay the organization chooses. Worth confirming where that relay is hosted if there are data-residency requirements |
| **Third-party processing** | With calendar sync enabled, **meeting titles, descriptions and attendee lists are sent to Google or Microsoft**. For most organizations that data already lives there, but it must be stated in the privacy notice, and it is a new processor relationship if your calendars are hosted elsewhere |
| **Cross-border** | Multi-location means staff data may be processed across jurisdictions. Relevant if any location is in the EU/UK and the deployment is not |

## 8. Pre-launch security checklist

- [ ] `.env` is not committed; secrets come only from the environment
- [ ] `SESSION_SECRET` is at least 32 random bytes and unique to this installation
- [ ] HTTPS enforced; HSTS enabled; certificate auto-renewal verified
- [ ] CSP active with no `unsafe-inline`; verified with no console violations
- [ ] Seed script confirmed to refuse to run with `NODE_ENV=production`
- [ ] Default demo accounts absent from the production database
- [ ] First owner account created through a one-time bootstrap command, not a seeded password
- [ ] Rate limits verified live, not just in tests
- [ ] `npm audit --omit=dev` clean at high and critical
- [ ] Database backups running, and a restore **actually rehearsed** on a scratch host
- [ ] SPF, DKIM and DMARC configured and verified for the sending domain
- [ ] Error pages leak no stack traces in production
- [ ] `/dev/emails` and the seed route are disabled outside development
- [ ] The production client bundle contains no secrets — grep `client/dist` for any `VITE_`
      value that should not be public
- [ ] Source maps either not shipped to production, or shipped deliberately and knowingly
- [ ] SPA fallback does not shadow `/api` — an unknown `/api/*` path returns a JSON 404, not
      `index.html`
- [ ] An authenticated employee account verified unable to reach any admin endpoint directly by URL
- [ ] Logs confirmed free of credentials and tokens

## 9. Known limitations of v1

Stated openly so nobody is surprised.

1. **No MFA.** A phished password is full access at that user's level.
2. **No SSO.** One more password for staff to manage; account offboarding is manual.
3. **Admins can read every non-private meeting title.** This is inherent to the move-and-cancel
   capability — you cannot relocate a meeting you cannot see. The audit log is the compensating
   control, and admins should be told their access is logged.
4. **Single-instance assumption.** Running two instances without adding job leases risks
   duplicate reminder emails ([02](02-architecture.md#6-background-workers)).
5. **No anti-automation on login beyond rate limiting.** No CAPTCHA. Acceptable for an internal
   system that is not exposed to the public internet; reconsider if it is.
