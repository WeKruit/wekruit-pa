# Cal.com Interview Scheduling — thin Claire capability (DESIGN)

Status: DESIGN LOCKED — build-ready. No code written in this phase.
Author: design lead. Date: 2026-06-01. Worktree: `.claude/worktrees/thin-PB`.

> GOAL (Adam): a tool that gets a Cal.com user's availability, lets Claire NEGOTIATE a
> 15-minute interview with the candidate over iMessage, then sends a confirmation email.

This ships as a **PR off origin/main**. Do NOT deploy, do NOT set the secret, do NOT
`firebase deploy`. The orchestrator owner sets `CALCOM_API_KEY` + deploys after approval.

---

## 0. The one collision you must reconcile FIRST

`apps/functions/src/claire-agent/tools/matching-tools.ts` ALREADY has:

- a tool named **`schedule_interview`** (the 4th tool) — a simple dedup reducer that writes a
  `pa-interview-bookings` doc with id `booking-${userId}__${jobId}` and shape
  `{ bookingId, userId, jobId, slotIso, status:"requested", sessionId, createdAt }`.
- a module-level constant `INTERVIEW_BOOKINGS_COLLECTION = "pa-interview-bookings"`.

The new Cal.com tools write to the **same collection** but with a **different doc-id namespace**
so the two never clobber each other:

| Producer | doc id | purpose |
|---|---|---|
| legacy `schedule_interview` | `booking-${userId}__${jobId}` | candidate "book me in" intent stub (no Cal.com) |
| new Cal.com offer/book | `calbk-${userId}__${jobId}` | the real offered-slots + confirmed Cal.com booking |

DECISION (locked): keep `schedule_interview` as-is for now (it is unrelated to Cal.com and
gated to nobody — it's a generic intent stub). The new tools are `offer_interview_slots` +
`book_interview_slot`. Do NOT rename/remove `schedule_interview` in this slice (out of scope,
and it has live tests). The prompt's TRIAGE `scheduling → schedule_interview` mention stays;
the new SCHEDULING section (below) routes the negotiate-then-book flow to the two new tools.
The Cal.com zod schema in core-types is a **superset** that validates docs of BOTH doc-id
conventions (the legacy fields are a strict subset), so a single schema covers the collection.

---

## 1. Files to create / edit

### CREATE

1. `apps/functions/src/calcom/calcom-client.ts`
   — Cal.com API v2 client: `getAvailableSlots`, `createBooking`, `getEventTypes` (optional).
   Error-class split (`CalcomClientError` 4xx / `CalcomServerError` 5xx|429|timeout) + 30s
   AbortController timeout, copied verbatim from `sendblue-client.ts`. Key from
   `process.env.CALCOM_API_KEY` ONLY.
2. `apps/functions/src/calcom/calcom-client.test.ts`
   — mock-fetch unit tests (header-per-endpoint, slot flatten/sort, body shape, 4xx vs 5xx,
   timeout). MUST be picked up by a NEW glob entry `src/calcom/*.test.ts`.
3. `apps/functions/src/calcom/event-type-routing.ts`
   — pure `resolveEventTypeId({ roleFunction, jobOverrideEventTypeId })` + the `ROLE_FUNCTION → eventTypeId`
   map + default. No I/O, fully unit-testable. (Kept separate from the client so it imports
   nothing heavy and can be tested + reused by both tools.)
4. `apps/functions/src/calcom/interview-confirmation-email.ts`
   — `sendInterviewConfirmationEmail(...)` reusing `sendMailgun` from `email/mailgun.js`, building
   a `MailgunConfig` from `process.env` exactly like `send-mailgun-email.ts` (`MAILGUN_API_KEY` /
   `MAILGUN_DOMAIN` default `wekruit.com` / `MAILGUN_FROM` default `WeKruit <hi@wekruit.com>` /
   `MAILGUN_REGION`). Audits the send to the existing `sent_emails` collection (mirror
   `runSendMailgunEmail`). Returns `{ ok, messageId?, reason? }`, fail-open (never throws).
5. `apps/functions/src/calcom/interview-confirmation-email.test.ts`
   — mailgun-mocked: success writes `sent_emails` audit row; non-ok mailgun → `{ ok:false }`;
   thrown sendMailgun → fail-open `{ ok:false }`. (Picked up by the same `src/calcom/*.test.ts` glob.)
6. `apps/functions/src/claire-agent/tools/scheduling-tools.ts`
   — `buildSchedulingTools(ctx: ClaireToolContext)` returning `[offerInterviewSlots, bookInterviewSlot]`.
   Imports `tool, z` from `../sdk.js` (zod@4) — VERBATIM like `matching-tools.ts` line 25. Both
   tools gated to `SCHEDULING_DEV_UIDS`, fail-open, never throw. Owns `SCHEDULING_DEV_UIDS`.
7. `apps/functions/src/claire-agent/tools/scheduling-tools.test.ts`
   — driven offline with a fake `ClaireToolContext` (stub `db`, injected calcom + email + nowIso
   seams). Auto-covered by the EXISTING glob `src/claire-agent/tools/*.test.ts` (no glob edit).
8. `packages/core-types/src/interview-bookings.ts`
   — `InterviewBookingSchema` (zod@3, `import { z } from "zod"` — mirror `pending-outbound.ts`),
   `interviewBookingDocId(...)`, status enum, `InterviewBookingState` type, offered-slot subtype.
9. `packages/core-types/src/interview-bookings.test.ts`
   — schema parse/round-trip + docId determinism + state-transition validity. Add to the
   core-types `package.json` "test" glob.

### EDIT

10. `apps/functions/src/orchestrator-deps.ts`
    — add `export const CALCOM_API_KEY = defineSecret("CALCOM_API_KEY")` and
    `export const CALCOM_SECRETS: SecretParamHandle[] = [CALCOM_API_KEY]` next to `MAILGUN_SECRETS`.
11. `apps/functions/src/index.ts` (`onPaInbound` + the coalescer CF)
    — append `CALCOM_API_KEY` (import from `./orchestrator-deps.js`) and the four `MAILGUN_SECRETS`
    to the `secrets:[...]` array, and re-export the values into `process.env` in the handler body
    (same as the existing `process.env.SENDBLUE_* = ....value()` block) so `process.env.CALCOM_API_KEY`
    + `MAILGUN_*` are populated for the lazily-loaded tools. Apply the IDENTICAL change to the
    coalescer CF (`paMessageCoalescer`, `apps/functions/src/coalesce/paMessageCoalescer.ts` /
    its export site) — thin Claire runs through BOTH inbound paths.
12. `apps/functions/src/claire-agent/tools/index.ts`
    — `import { buildSchedulingTools } from "./scheduling-tools.js"` and add `...buildSchedulingTools(ctx)`
    to the returned array in `buildClaireTools`.
13. `apps/functions/src/claire-agent/prompt.ts`
    — add a `SCHEDULING` const + an after-PASS hook line; compose `SCHEDULING` into `buildClairePrompt`
    after `DELIVERY`. (Details in §7.)
14. `apps/functions/package.json`
    — add `src/calcom/*.test.ts` to the `"test"` node `--test` glob list (right after
    `src/claire-agent/tools/*.test.ts`). `src/claire-agent/tools/*.test.ts` is ALREADY present,
    so `scheduling-tools.test.ts` is auto-covered.
15. `packages/core-types/src/index.ts`
    — `export * from "./interview-bookings.js"` (so `@pa/core-types` re-exports the schema + docId).
16. `packages/core-types/package.json`
    — add `src/interview-bookings.test.ts` to the `"test"` glob.
17. `packages/core-types/src/collections.ts`
    — add `interviewBookings: "pa-interview-bookings"` to `PA_COLLECTIONS` (the literal already
    exists as a string constant in matching-tools.ts; this makes it canonical + reusable).

---

## 2. Cal.com v2 client — `apps/functions/src/calcom/calcom-client.ts`

Pattern copied from `sendblue-client.ts`: `withTimeout(AbortController, 30_000)`, `readJson`,
two error classes, key resolved from env (never hardcoded).

```ts
const BASE = "https://api.cal.com/v2"           // HTTPS only — plain HTTP fails.
const DEFAULT_TIMEOUT_MS = 30_000
const API_VERSION = {                            // EXACT per-endpoint cal-api-version (do not change)
  eventTypes: "2024-06-14",
  slots:      "2024-09-04",
  bookings:   "2026-02-25",
} as const

export class CalcomClientError extends Error { status: number; body: unknown }   // 4xx → no retry
export class CalcomServerError extends Error { status: number; body: unknown }   // 5xx|429|timeout

export function getCalcomApiKey(): string {
  const k = process.env.CALCOM_API_KEY?.trim() ?? ""
  if (!k) throw new CalcomServerError(0, "CALCOM_API_KEY not set", null)   // treated as transient → fail-open in tool
  return k
}
```

`getCalcomApiKey()` throwing a `CalcomServerError` (not a plain `Error`) means a missing secret is
handled by the same fail-open catch the tools use; the tool returns `{ ok:false, reason }` and
Claire says a human will lock it in.

### `getAvailableSlots`

```ts
export interface SlotsQuery {
  start: string                 // ISO8601 UTC (date or datetime), required
  end: string                   // ISO8601 UTC, required
  eventTypeId: number           // we always route by eventTypeId (not slug+username)
  timeZone?: string             // IANA, default "America/New_York" (resolved by caller, see §6)
  duration?: number             // minutes (optional)
}
export interface FlatSlot { iso: string; date: string }   // iso = "2026-06-02T06:00:00.000-07:00", date = "2026-06-02"

export async function getAvailableSlots(q: SlotsQuery, apiKey = getCalcomApiKey()): Promise<FlatSlot[]>
```

- GET `${BASE}/slots?start=&end=&eventTypeId=&timeZone=&duration=` with headers
  `Authorization: Bearer ${apiKey}` + `cal-api-version: 2024-09-04`. `format` omitted (default
  `time`).
- Response shape: `{ status:"success", data: { "YYYY-MM-DD": [ {start:"...iso w/ offset"} , ...], ... } }`.
  Empty availability → `data: {}`.
- **FLATTEN + SORT**: iterate `Object.values(data)`, take each entry's `.start` string, push
  `{ iso: start, date: start.slice(0,10) }`, then sort ascending by `Date.parse(iso)`. Return the
  flat sorted array. (Date keys are NOT guaranteed ordered; sort by parsed instant, which respects
  the embedded offset.) This flatten+sort is a pure helper `flattenSlots(data)` exported for the test.
- 2xx → return slots. 4xx → throw `CalcomClientError`. 5xx|429 → throw `CalcomServerError`
  (preserve `retry-after`). network/abort → `CalcomServerError(0, ...)`.

### `createBooking`

```ts
export interface CreateBookingInput {
  start: string                 // ISO-UTC (the chosen slot, converted to UTC or passed w/ offset — Cal accepts ISO)
  eventTypeId: number
  attendee: { name: string; email: string; timeZone: string; language?: "en"; phoneNumber?: string }
  lengthInMinutes?: number      // default omitted → event type's own length (15/20m)
  metadata?: Record<string, string>   // <=50 keys, key<=40ch, val<=500ch
  location?: { type: "integration"; integration: "cal-video" }   // all our event types use cal-video
}
export interface BookingResult {
  id: number; uid: string; title: string; status: string;        // status === "accepted" on success
  start: string; end: string; duration: number
  eventType: { id: number; slug: string }
}
export async function createBooking(input: CreateBookingInput, apiKey = getCalcomApiKey()): Promise<BookingResult>
```

- POST `${BASE}/bookings` headers `Authorization: Bearer ${apiKey}` + `cal-api-version: 2026-02-25`
  + `content-type: application/json`, JSON body = `input` (always include
  `location:{type:"integration",integration:"cal-video"}` and `attendee.language:"en"`).
- 2xx → return `data`. Same 4xx/5xx split.
- **Note in a code comment** (acceptable for v1): Cal.com auto-sends its OWN confirmation email on
  an accepted booking; our Mailgun email is a WeKruit-branded supplement — possible double-email.

### `getEventTypes` (optional, helper/diagnostic)

GET `${BASE}/event-types?username=<u>` + `cal-api-version: 2024-06-14` → `{ status, data:[{id,lengthInMinutes,slug,title,hidden,...}] }`.
Not on the candidate hot path; useful for an admin/diagnostic backfill of the routing map. Build it,
keep it small, do not wire it into the tools.

---

## 3. `pa-interview-bookings` zod schema + docId — `packages/core-types/src/interview-bookings.ts`

zod@3 (`import { z } from "zod"`), mirroring `pending-outbound.ts` structure (enum + doc schema +
deterministic docId helper). Collection = `PA_COLLECTIONS.interviewBookings = "pa-interview-bookings"`.

```ts
import { z } from "zod"

/** Lifecycle of a Cal.com-backed interview booking. */
export const InterviewBookingStatusSchema = z.enum([
  "offered",     // slots presented to the candidate this/last turn; awaiting their pick
  "booked",      // POST /bookings accepted; Cal.com booking created
  "confirmed",   // our WeKruit Mailgun confirmation email sent (booked + emailed)
  "failed",      // booking attempt failed (4xx/5xx) — recoverable, candidate can retry
])
export type InterviewBookingStatus = z.infer<typeof InterviewBookingStatusSchema>

/** One slot we offered, in the order we listed it (slotNumber is 1-based index into this array). */
export const OfferedSlotSchema = z.object({
  iso: z.string().min(1),        // exact ISO string Cal returned (w/ offset), what we POST back verbatim
  date: z.string().min(1),       // "YYYY-MM-DD" bucket
})
export type OfferedSlot = z.infer<typeof OfferedSlotSchema>

export const InterviewBookingSchema = z.object({
  id: z.string().min(1),                 // == doc id (interviewBookingDocId)
  userId: z.string().min(1),             // pa-users doc id (internal, never raw PII)
  jobId: z.string().min(1),              // the opportunity this interview is for
  status: InterviewBookingStatusSchema,
  eventTypeId: z.number().int().positive(),   // Cal.com event type used for slots + booking
  timeZone: z.string().min(1),           // IANA tz used for slots + the booking attendee
  // OFFER state — persisted so slotNumber resolves to the exact ISO on the NEXT turn:
  offeredSlots: z.array(OfferedSlotSchema).default([]),
  offeredAt: z.string().min(1).nullable(),
  // BOOK state:
  selectedSlotIso: z.string().min(1).nullable(),
  calBookingId: z.number().int().nullable(),    // Cal numeric id
  calBookingUid: z.string().min(1).nullable(),  // Cal uid (for cancel/reschedule later)
  // CONFIRM (email) state:
  confirmationEmailSentAt: z.string().min(1).nullable(),
  confirmationEmailMessageId: z.string().min(1).nullable(),
  candidateEmail: z.string().min(1).nullable(),  // resolved email used for the booking
  // failure trail:
  lastError: z.string().min(1).nullable(),
  // bookkeeping (legacy schedule_interview fields are a SUBSET of this doc — see §0):
  sessionId: z.string().min(1).nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  version: z.number().int().nonnegative(),
})
export type InterviewBooking = z.infer<typeof InterviewBookingSchema>

/** Cal.com booking doc id — DISTINCT namespace from legacy `booking-...` (see §0). One per (user × job). */
export function interviewBookingDocId(args: { userId: string; jobId: string }): string {
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-")
  return `calbk-${slug(args.userId)}__${slug(args.jobId)}`
}
```

DECISION (locked): **one booking doc per (user × job)**, doc id `calbk-${userId}__${jobId}`. The
`offer_interview_slots` tool upserts the `offered` row (overwriting prior offered slots — re-offering
a refined window REPLACES the array); `book_interview_slot` transitions the SAME doc to
`booked`→`confirmed`. `jobId` falls back to `"unknown_job"` when `ctx.jobId` is absent (same guard
the legacy `schedule_interview` uses), so an out-of-prescreen "set up a time" still gets a stable doc.

---

## 4. eventType routing — `apps/functions/src/calcom/event-type-routing.ts`

Resolution order (first match wins):

1. **Per-job override**: `pa-jobs/{jobId}.calcomEventTypeId` (a `number`). If present + valid, use it.
   (New optional field; absent on every existing job → falls through. No schema migration needed —
   read defensively.)
2. **roleFunction map**: the candidate's matched role's `roleFunction[]` (from the job's
   `matching-jobs`/`pa-jobs` canonical tags, OR the candidate's `tags.targetRoleFunction[]` as a
   fallback) mapped via `ROLE_FUNCTION_EVENT_TYPE`. First roleFunction token with a mapping wins.
3. **Default**: `DEFAULT_EVENT_TYPE_ID`.

```ts
// Live account facts (key cal_live_… owns these). 15-min unless noted.
export const ROLE_FUNCTION_EVENT_TYPE: Record<string, number> = {
  software_engineering: 5847961,   // "Software Engineer Interview" (15m)
  creatives_and_design: 5604544,   // "Designer Interview" (20m)  [ui_ux/design]
  sales_and_business_development: 5180826, // "GTM Interview" (20m) [sales/go_to_market]
  // (Agent Dev Interview 5180824 — no clean roleFunction; reserved, not mapped by default.)
}
export const DEFAULT_EVENT_TYPE_ID = 4508818   // "WeKruit Demo" (15m) — see open question Q1

export function resolveEventTypeId(args: {
  jobOverrideEventTypeId?: number | null
  roleFunctions?: string[] | null
}): { eventTypeId: number; source: "job_override" | "role_function" | "default" } {
  const ov = args.jobOverrideEventTypeId
  if (typeof ov === "number" && Number.isInteger(ov) && ov > 0) return { eventTypeId: ov, source: "job_override" }
  for (const rf of args.roleFunctions ?? []) {
    const id = ROLE_FUNCTION_EVENT_TYPE[String(rf).toLowerCase()]
    if (id) return { eventTypeId: id, source: "role_function" }
  }
  return { eventTypeId: DEFAULT_EVENT_TYPE_ID, source: "default" }
}
```

> NOTE on roleFunction tokens: `creatives_and_design` / `sales_and_business_development` are the
> jobright `utm_campaign` canonical tokens (D1, `@wekruit/shared-tags ROLE_FUNCTION_VOCAB`). The
> implementer MUST verify the EXACT spellings against `packages/shared-tags/src/canonical/role-function.ts`
> at build time and adjust the map keys to match (the brief said `ui_ux`/`design`/`sales`/`go_to_market`
> loosely — those are not the canonical enum). This is the one place to double-check vocab.

Default is `4508818` (WeKruit Demo, true 15-min) — see Q1.

---

## 5. The two tools — `apps/functions/src/claire-agent/tools/scheduling-tools.ts`

```ts
import { tool, z } from "../sdk.js"          // VERBATIM like matching-tools.ts:25 — zod@4 SDK instance
import type { ClaireToolContext } from "../types.js"
import { getAvailableSlots, createBooking, CalcomClientError } from "../../calcom/calcom-client.js"
import { resolveEventTypeId } from "../../calcom/event-type-routing.js"
import { sendInterviewConfirmationEmail } from "../../calcom/interview-confirmation-email.js"
import { InterviewBookingSchema, interviewBookingDocId } from "@pa/core-types"

const INTERVIEW_BOOKINGS_COLLECTION = "pa-interview-bookings"
// WRITE-action allowlist (Adam +14243201960, Noah +12154034668). Mirrors REC_CARD_UIDS in cutover.ts.
const SCHEDULING_DEV_UIDS = new Set<string>(["8fEwIduUrzxZsblHHsNz", "UKFaKdsMzzfPW2CDl5ve"])
```

### Shared helpers (in this file, all fail-soft)

- `resolveTimeZone(ctx, argTz)` → §6.
- `resolveCandidateEmail(ctx)` → query `pa-candidate-handles where candidateId == ctx.userId &&
  kind == "email"` `.limit(1)`, return `normalizedValue` (lowercased email) or `""`. (Forward query;
  candidate-handles docs carry `candidateId`/`kind`/`normalizedValue` — verified.) Email is SPARSE.
- `resolveRoleFunctions(ctx, jobId)` → read `pa-jobs/{jobId}.calcomEventTypeId` (override) +
  `matching-jobs/{jobId}.roleFunction` (route signal); fall back to `pa-users/{userId}.tags.targetRoleFunction`.
  Fail-soft → `{ override: null, roleFunctions: [] }`.
- `loadBooking(db, id)` / `upsertBooking(...)` — Firestore `set(..., { merge:true })`; on read,
  `InterviewBookingSchema.partial().safeParse` defensively (never throw on a malformed legacy doc).

### Tool A — `offer_interview_slots`  (READ-ONLY availability; gated, but no write side-effect besides persisting the offer)

```ts
parameters: z.object({
  timeZone: z.string().nullable(),                       // IANA; null → resolve (§6)
  partOfDay: z.enum(["morning", "afternoon", "evening", "any"]).nullable(),  // negotiation refinement
})
```

`jobId` is NOT a tool param — it comes from `ctx.jobId` (the active opportunity for the turn). The
brief lists `jobId` in the signature; DECISION: take it from `ctx.jobId` (with `"unknown_job"`
fallback) to match how every other tool in this file resolves the opportunity, and to avoid the LLM
hallucinating a job id. (If a future need arises to offer for a *named* role, that resolves through
`find_my_role` → jobId first, same as prescreen.)

execute:
1. **GATE**: if `!SCHEDULING_DEV_UIDS.has(ctx.userId)` → `return { ok:false, reason:"scheduling_not_enabled" }`
   (no Cal.com call, no write). Mirrors the cutover REC_CARD_UIDS guard.
2. `tz = resolveTimeZone(ctx, timeZone)`.
3. `{ override, roleFunctions } = resolveRoleFunctions(ctx, jobId)`; `{ eventTypeId } = resolveEventTypeId(...)`.
4. window: `start = nowIso()`, `end = now + 7 days` (ISO-UTC). DECISION: 7-day window from now.
5. `try { slots = await getAvailableSlots({ start, end, eventTypeId, timeZone: tz }) } catch → fail-open`
   (`CalcomServerError`/`CalcomClientError` both → `{ ok:false, reason:"calcom_unavailable" }`).
6. **partOfDay filter** (in-memory, on the slot's LOCAL hour in `tz`): morning <12, afternoon 12–17,
   evening ≥17. `any`/null → no filter. If the filter empties the list, fall back to unfiltered
   (never return zero just because of a part-of-day preference; tell the agent via a `filteredEmpty:true` flag).
7. **pick ~4–5 spread slots**: take the filtered+sorted list, pick up to 5 by even stride across the
   array (so they span the week, not all on day 1). Helper `pickSpread(slots, 5)`, pure + exported for test.
8. PERSIST the offer: upsert `pa-interview-bookings/{interviewBookingDocId({userId,jobId})}` with
   `status:"offered"`, `eventTypeId`, `timeZone:tz`, `offeredSlots: picked.map({iso,date})`,
   `offeredAt: now`, `updatedAt`, bump `version`. **This is what lets `slotNumber` resolve next turn.**
   Fail-soft: a write error still returns the slots (the agent can read them this turn; only a
   cross-turn `slotNumber` would degrade).
9. Return:
```ts
{ ok:true, eventTypeId, timeZone:tz,
  slots: picked.map((s,i)=>({ number:i+1, iso:s.iso, label:humanLabel(s.iso, tz) })),  // label e.g. "Mon Jun 2, 9:00am ET"
  count: picked.length, filteredEmpty }
```
The agent reads `slots[].label` to present a numbered list in its voice and NEGOTIATE. To refine,
the agent calls `offer_interview_slots` again with a different `partOfDay`/`timeZone` — same doc
re-persisted with the new offered set (§ state machine).

`humanLabel(iso, tz)` formats the ISO instant in `tz` via `Intl.DateTimeFormat` with a short tz
name. Pure + exported for test.

### Tool B — `book_interview_slot`  (WRITE: real Cal.com booking + WeKruit email; gated)

```ts
parameters: z.object({
  slotNumber: z.number().int().min(1).max(10).nullable(),   // 1-based index into the persisted offeredSlots
  slotIso: z.string().nullable(),                           // exact ISO (agent may pass either; slotNumber preferred)
  candidateEmail: z.string().nullable(),                    // only when candidate typed one this turn
  candidateName: z.string().nullable(),
  timeZone: z.string().nullable(),
})
```

execute:
1. **GATE**: `!SCHEDULING_DEV_UIDS.has(ctx.userId)` → `{ ok:false, reason:"scheduling_not_enabled" }`
   (NO booking, NO email). Agent then says a human will lock it in.
2. Load the booking doc `calbk-...`. Resolve the chosen ISO:
   - if `slotIso` present + it is one of `doc.offeredSlots[].iso` → use it.
   - else if `slotNumber` present → `doc.offeredSlots[slotNumber-1].iso`.
   - else → `{ ok:false, reason:"no_slot_selected" }` (agent re-offers / asks which number).
   - if neither resolves to a persisted offered slot → `{ ok:false, reason:"slot_not_offered" }`
     (NEVER book an ISO we didn't offer — guards against an LLM-invented time).
3. **email**: `email = candidateEmail?.trim() || await resolveCandidateEmail(ctx)`. If empty →
   `{ ok:false, reason:"need_email" }` (agent asks for it; no booking attempted). DECISION: we
   require an email to book because Cal.com's attendee + our confirmation both need it.
4. **idempotency / dedup**: if `doc.status === "booked" || "confirmed"` and `doc.selectedSlotIso === chosenIso`
   → `{ ok:true, action:"already_booked", slotIso, calBookingUid: doc.calBookingUid }` (no second POST).
5. `name = candidateName?.trim() || (pa-users/{userId}.firstName) || "Candidate"`.
   `tz = resolveTimeZone(ctx, timeZone) || doc.timeZone`.
6. **createBooking** (the real write):
```ts
const booking = await createBooking({
  start: chosenIso, eventTypeId: doc.eventTypeId,
  attendee: { name, email, timeZone: tz, language: "en", ...(ctx.toE164 ? { phoneNumber: ctx.toE164 } : {}) },
  location: { type:"integration", integration:"cal-video" },
  metadata: { wekruitUserId: ctx.userId, wekruitJobId: jobId, sessionId: ctx.sessionId },  // <=50 keys, <=40/<=500 chars
})
```
   - on `CalcomClientError` (4xx, e.g. slot already taken) → upsert `status:"failed"`,
     `lastError: msg` → `{ ok:false, reason:"slot_unavailable", retryable:true }` (agent re-offers).
   - on `CalcomServerError`/throw → `{ ok:false, reason:"calcom_unavailable", retryable:true }`,
     status left `offered` (so a retry re-uses the same offered slots). FAIL-OPEN: catch everything.
7. upsert `status:"booked"`, `selectedSlotIso: chosenIso`, `calBookingId`, `calBookingUid`,
   `candidateEmail: email`, `updatedAt`, bump `version`.
8. **confirmation email** (WeKruit-branded supplement; Cal also auto-emails — comment notes the
   double): `const mail = await sendInterviewConfirmationEmail({ to: email, name, whenIso: chosenIso,
   timeZone: tz, jobId, eventTypeId, db: ctx.db, userId: ctx.userId })`. On success upsert
   `status:"confirmed"`, `confirmationEmailSentAt`, `confirmationEmailMessageId`. On email failure,
   leave status `booked` (the booking IS made — do not fail the turn) and log; the agent still says
   "you're booked".
9. Return `{ ok:true, action:"booked", slotIso: chosenIso, when: humanLabel(chosenIso, tz),
   emailed: mail.ok, calBookingUid }`. The agent confirms warmly in its voice.

Both tools: `ctx.log("pa.claire.offer_interview_slots"/".book_interview_slot", {...})` for telemetry,
and EVERY path returns `{ ok, ... }` — never throws (RC contract).

### `buildSchedulingTools`

```ts
export function buildSchedulingTools(ctx: ClaireToolContext) {
  const offerInterviewSlots = tool({ name:"offer_interview_slots", description:"...", parameters:..., async execute(...) {...} })
  const bookInterviewSlot   = tool({ name:"book_interview_slot",   description:"...", parameters:..., async execute(...) {...} })
  return [offerInterviewSlots, bookInterviewSlot]
}
```

---

## 6. Timezone strategy

`resolveTimeZone(ctx, argTz)` resolution order (first non-empty wins):
1. `argTz` (the tool param) — when the candidate stated a tz or the agent inferred one ("I'm in NYC"
   → agent passes `America/New_York`). Validate it is a plausible IANA string (contains `/`); else skip.
2. candidate location tag: read `pa-users/{userId}.tags.targetLocations[0]` and map a US city/region
   token → IANA via a small static `LOCATION_TZ` map (`new_york`/`nyc`→`America/New_York`,
   `sf_bay_area`/`san_francisco`→`America/Los_Angeles`, `seattle`→`America/Los_Angeles`,
   `austin`/`chicago`→`America/Chicago`, `remote*`/`anywhere`→ default). Pure helper, no regex
   classification of free text — it only maps the ALREADY-canonical location token to a tz.
3. **default `America/New_York`** (the Cal.com account owner's tz — Noah is `America/New_York`).

The resolved IANA tz is passed to BOTH `getAvailableSlots` (so slot ISO offsets are in the
candidate's zone) AND `createBooking` (`attendee.timeZone`), and stored on the booking doc. All
human labels render in this tz. US-only scope (per platform rule) keeps the map small.

DECISION: default `America/New_York` (matches the Cal account + the most common candidate tz), NOT
UTC — UTC slot labels would confuse candidates.

---

## 7. prompt.ts — SCHEDULING section + after-PASS hook

Add a `SCHEDULING` const, composed into `buildClairePrompt` right after `DELIVERY`:

```
SCHEDULING (only when scheduling tools are available to this candidate — they are gated; if a tool
returns reason 'scheduling_not_enabled', tell them warmly that a teammate will lock in a time and
move on — do NOT keep retrying):
- To set up an interview, NEGOTIATE, don't dictate. Call offer_interview_slots (it returns a numbered
  list of real open times in their timezone). Present 3-5 of them in your voice as a short numbered
  list (plain text, no markdown) and ask which works — e.g. 'got a few open: 1) mon 9am ET 2) tue
  2pm ET 3) wed 11am ET — which works, or want other times?'.
- If they want a different window ('anything in the afternoon?', 'next week?', 'I'm on west coast')
  → call offer_interview_slots AGAIN with partOfDay and/or timeZone refined. Re-offer until they pick.
- When they pick one ('2 works', 'tuesday', 'the 2pm') → call book_interview_slot with the slotNumber
  (preferred) or the exact slotIso from the list. If it returns need_email, ask for their email once,
  then call book_interview_slot again with candidateEmail. On ok:true say it's locked in + that a
  calendar invite + confirmation are on the way (keep it to one short bubble). On reason
  'slot_unavailable' (someone grabbed it), apologize lightly and re-offer. Never invent a time that
  wasn't in the offered list.
```

**After-PASS hook** — passing the prescreen is the green light to offer the interview, SAME turn,
the agent still has `ctx.jobId`. Add one line into the PRESCREEN mode directive's terminal handling
AND the SCHEDULING block:

```
- AFTER A PASS: when explain_prescreen_outcome reports the candidate PASSED a collab/partner role,
  that's the green light to set up the first interview RIGHT NOW (same conversation, you still know
  the role). Warmly congratulate, then go straight into SCHEDULING (call offer_interview_slots) — do
  not make them ask. If scheduling isn't enabled for them, say a teammate will reach out to lock a time.
```

(Build note: scheduling is gated to 2 dev uids, so for everyone else the tool returns
`scheduling_not_enabled` and the prompt's "teammate will lock it in" branch fires — safe.)

---

## 8. Secret wiring

`orchestrator-deps.ts`:
```ts
export const CALCOM_API_KEY: SecretParamHandle = defineSecret("CALCOM_API_KEY")
export const CALCOM_SECRETS: SecretParamHandle[] = [CALCOM_API_KEY]
```

`index.ts` `onPaInbound` `secrets:[...]` — append `CALCOM_API_KEY` + the four `MAILGUN_SECRETS`
(`MAILGUN_API_KEY, MAILGUN_DOMAIN, MAILGUN_FROM, MAILGUN_REGION`). In the handler body, alongside
the existing `process.env.SENDBLUE_* = ....value()` re-exports, add:
```ts
process.env.CALCOM_API_KEY = CALCOM_API_KEY.value()
process.env.MAILGUN_API_KEY = MAILGUN_API_KEY.value()
process.env.MAILGUN_DOMAIN = MAILGUN_DOMAIN.value()
process.env.MAILGUN_FROM = MAILGUN_FROM.value()
try { process.env.MAILGUN_REGION = MAILGUN_REGION.value() } catch { /* optional */ }
```
(Wrap each in the same defensive try/value pattern the file already uses; an unset MAILGUN_REGION
must not crash.) Apply the IDENTICAL secrets-array + env-reexport change to the **coalescer CF**
(`paMessageCoalescer`) since thin Claire runs through it too.

Secret is NOT set in this slice — the orchestrator owner runs
`firebase functions:secrets:set CALCOM_API_KEY ...` then deploys. Until then a missing key →
`getCalcomApiKey()` throws `CalcomServerError` → tool returns `{ ok:false, reason:"calcom_unavailable" }`
→ chat turn unaffected (fail-open).

---

## 9. State machine

```
            offer_interview_slots (gated)                book_interview_slot (gated)
   (none) ─────────────────────────────────▶ offered ───────────────────────────────▶ booked
                          ▲   │ re-offer (refined window/tz)        │ Cal POST accepted    │ Mailgun ok
                          └───┘ overwrites offeredSlots[]           │                      ▼
                                                                    │                  confirmed
                                                  Cal 4xx (slot taken) / 5xx            (email sent;
                                                                    ▼                    Cal also auto-emails)
                                                                 failed ──▶ (candidate retries → re-offer → offered)
```

- `offered` persists `offeredSlots[]` (ordered) on `pa-interview-bookings/{calbk-userId__jobId}`.
  This array is the index resolution source: `slotNumber` (1-based) → `offeredSlots[slotNumber-1].iso`.
  Re-offering REPLACES the array (negotiation), so the numbering the agent just showed always
  matches what's persisted.
- `booked` set after Cal.com returns `status:"accepted"` (stores `calBookingId`/`calBookingUid`/`selectedSlotIso`).
- `confirmed` set after our Mailgun email succeeds. Email failure leaves it `booked` (booking is real;
  turn still succeeds).
- `failed` on a 4xx booking error (recoverable); a transient 5xx leaves status `offered` so a retry
  reuses the same offered set.
- Transitions are deterministic (the tool's `execute`, not the LLM). The LLM only proposes
  `slotNumber`/`partOfDay`/`timeZone` — the reducer picks the ISO, books, and writes state. (v2.0
  Rule: LLM never directly controls state.)

---

## 10. Tool contracts (summary)

**`offer_interview_slots`** — params `{ timeZone: string|null, partOfDay: "morning"|"afternoon"|"evening"|"any"|null }`
(jobId from `ctx.jobId`). Returns
`{ ok:true, eventTypeId, timeZone, slots:[{number,iso,label}], count, filteredEmpty }` |
`{ ok:false, reason:"scheduling_not_enabled"|"calcom_unavailable"|"no_slots" }`.

**`book_interview_slot`** — params `{ slotNumber:int|null, slotIso:string|null, candidateEmail:string|null,
candidateName:string|null, timeZone:string|null }` (jobId from `ctx.jobId`). Returns
`{ ok:true, action:"booked"|"already_booked", slotIso, when, emailed:boolean, calBookingUid }` |
`{ ok:false, reason:"scheduling_not_enabled"|"need_email"|"no_slot_selected"|"slot_not_offered"|"slot_unavailable"|"calcom_unavailable", retryable? }`.

---

## 11. Test plan

### `calcom-client.test.ts` (mock global `fetch`)
- `getAvailableSlots` sends the EXACT `cal-api-version: 2024-09-04` header + `Authorization: Bearer <env>`
  (set `process.env.CALCOM_API_KEY` in the test) + correct query params; flattens the keyed `data`
  object and sorts ascending by instant; empty `data:{}` → `[]`.
- `flattenSlots` pure helper: multi-day, out-of-order keys → single sorted array.
- `createBooking` sends `cal-api-version: 2026-02-25` + JSON body incl. `location:{type:"integration",
  integration:"cal-video"}` + `attendee.language:"en"`; returns `data` on 200.
- `getEventTypes` sends `cal-api-version: 2024-06-14`.
- 4xx → `CalcomClientError` (status carried); 5xx & 429 → `CalcomServerError` (retry-after carried);
  AbortController timeout → `CalcomServerError(0,...)`.
- NEVER references a literal `cal_live_` key — only `process.env.CALCOM_API_KEY` (test sets a fake).

### `event-type-routing.test.ts` (pure)
- job override beats everything; roleFunction map hit (software_engineering→5847961,
  creatives_and_design→5604544); unmapped/empty roleFunctions → default 4508818; `source` label correct.

### `scheduling-tools.test.ts` (fake ctx; inject calcom + email seams)
- GATE: a non-dev `ctx.userId` → both tools return `scheduling_not_enabled`, ZERO Cal.com calls,
  ZERO Firestore writes, ZERO email.
- `offer_interview_slots` (dev uid): persists `status:"offered"` + ordered `offeredSlots` to
  `calbk-<uid>__<jobId>`; returns a numbered list (1..N) whose `iso` matches the persisted array;
  partOfDay filter narrows; filter-empties → unfiltered fallback + `filteredEmpty:true`.
- `book_interview_slot` (dev uid): resolves `slotNumber`→ exact persisted ISO; books via injected
  calcom stub; writes `booked`→`confirmed`; asserts `sent_emails` audit row written (mocked mailgun
  returns `{ok:true,messageId}`); `slotNumber` that wasn't offered → `slot_not_offered` (no booking).
- `need_email` branch: no `candidateEmail` arg AND no `pa-candidate-handles` email row → `need_email`,
  no booking. With a candidate-handles email row → resolves it + books.
- dedup: second `book` for the same already-`confirmed` slot → `already_booked`, no second Cal POST.
- FAIL-OPEN: injected calcom that throws → `{ ok:false, reason:"calcom_unavailable" }` (no throw);
  mailgun that throws after a successful booking → status stays `booked`, `{ ok:true, emailed:false }`.

### `interview-confirmation-email.test.ts`
- success → `sent_emails` audit row (uid/to/messageId/status:"sent"/provider:"mailgun"); reuses
  `sendMailgun` (injected); non-ok mailgun → `{ ok:false }`; thrown sendMailgun → fail-open `{ ok:false }`.

### `interview-bookings.test.ts` (core-types)
- `InterviewBookingSchema` round-trips a full `confirmed` doc + a minimal `offered` doc; rejects a bad
  status; `interviewBookingDocId` deterministic + slugified + `calbk-` namespace (distinct from `booking-`).

### glob wiring
- `apps/functions/package.json` "test": add `src/calcom/*.test.ts`. (`src/claire-agent/tools/*.test.ts`
  already present → `scheduling-tools.test.ts` auto-runs.)
- `packages/core-types/package.json` "test": add `src/interview-bookings.test.ts`.

### Local sim (no deploy)
- `runner-local.mjs` scenario (dev phone `+14243201960`, uid `8fEwIduUrzxZsblHHsNz`): inbound "can we
  set up the interview?" → assert outbound has a numbered slot list; "2 works" → assert booked + email
  intent. Drive with stub calcom + mailgun (no live key) per the eval-real-seam memory rule.
- Run order before commit: `source ~/.zshrc && nvm use 24`, then
  `pnpm --filter @pa/core-types test`, `pnpm --filter @wekruit/functions test` (or the functions test
  script), all green.

---

## 12. Open questions for Adam (with recommended defaults)

(See structured `openQuestions`.)
