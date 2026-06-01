/**
 * Cal.com API v2 client.
 *
 * Endpoint contract validated via live probe 2026-06-01 (real key):
 *   GET  https://api.cal.com/v2/slots        cal-api-version: 2024-09-04
 *   POST https://api.cal.com/v2/bookings      cal-api-version: 2026-02-25
 *   GET  https://api.cal.com/v2/event-types   cal-api-version: 2024-06-14
 *   Auth header: Authorization: Bearer ${apiKey}  (apiKey = cal_live_…)
 *
 * The key is read from `process.env.CALCOM_API_KEY` ONLY — never hardcoded.
 *
 * Error model (mirrors sendblue-client.ts):
 *   - 4xx → CalcomClientError (do not retry; the slot may be taken / bad arg)
 *   - 5xx | 429 | network | timeout | missing-key → CalcomServerError (transient)
 *   - `getCalcomApiKey()` throws a CalcomServerError (NOT a plain Error) when the
 *     secret is unset, so a missing key is handled by the same fail-open catch
 *     the scheduling tools use → tool returns { ok:false } and Claire says a
 *     human will lock it in. The chat turn is never broken.
 */

const BASE = "https://api.cal.com/v2" // HTTPS only — plain HTTP fails.
const DEFAULT_TIMEOUT_MS = 30_000

/** EXACT per-endpoint cal-api-version (do not change — validated live). */
const API_VERSION = {
  eventTypes: "2024-06-14",
  slots: "2024-09-04",
  bookings: "2026-02-25",
} as const

export class CalcomClientError extends Error {
  readonly status: number
  readonly body: unknown
  readonly retryAfter?: string
  constructor(status: number, message: string, body: unknown, retryAfter?: string) {
    super(message)
    this.name = "CalcomClientError"
    this.status = status
    this.body = body
    this.retryAfter = retryAfter
  }
}

export class CalcomServerError extends Error {
  readonly status: number
  readonly body: unknown
  readonly retryAfter?: string
  constructor(status: number, message: string, body: unknown, retryAfter?: string) {
    super(message)
    this.name = "CalcomServerError"
    this.status = status
    this.body = body
    this.retryAfter = retryAfter
  }
}

/**
 * Resolve the Cal.com API key from the environment. Throws a
 * `CalcomServerError` (treated as transient by the tool fail-open catch) when
 * unset, so a missing secret never breaks the chat turn.
 */
export function getCalcomApiKey(): string {
  const k = process.env.CALCOM_API_KEY?.trim() ?? ""
  if (!k) throw new CalcomServerError(0, "CALCOM_API_KEY not set", null)
  return k
}

async function withTimeout<T>(p: (signal: AbortSignal) => Promise<T>, ms = DEFAULT_TIMEOUT_MS): Promise<T> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try {
    return await p(ctrl.signal)
  } finally {
    clearTimeout(t)
  }
}

async function readJson(resp: Response): Promise<unknown> {
  const txt = await resp.text()
  if (!txt) return null
  try {
    return JSON.parse(txt)
  } catch {
    return { raw: txt }
  }
}

/** Map a non-2xx response (or a thrown fetch) to the right error class. */
function classifyHttp(status: number, message: string, body: unknown, retryAfter?: string): never {
  if (status >= 500 || status === 429) {
    throw new CalcomServerError(status, message, body, retryAfter)
  }
  // 4xx — bad arg / slot taken / auth. Do not retry.
  throw new CalcomClientError(status, message, body, retryAfter)
}

function errMessage(parsed: unknown, status: number, label: string): string {
  if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>
    const e = o.error
    if (e && typeof e === "object" && "message" in (e as Record<string, unknown>)) {
      return String((e as { message?: unknown }).message ?? "")
    }
    if (typeof o.message === "string" && o.message) return o.message
  }
  return `Cal.com ${label} HTTP ${status}`
}

// ---------------------------------------------------------------------------
// GET /slots
// ---------------------------------------------------------------------------

export interface SlotsQuery {
  /** ISO8601 UTC (date or datetime), required. */
  start: string
  /** ISO8601 UTC, required. */
  end: string
  /** we always route by eventTypeId (not slug+username). */
  eventTypeId: number
  /** IANA, default "America/New_York" (resolved by the caller). */
  timeZone?: string
  /** minutes (optional). */
  duration?: number
}

/** A flattened slot: `iso` is the exact Cal ISO w/ offset; `date` is the YYYY-MM-DD bucket. */
export interface FlatSlot {
  iso: string
  date: string
}

/**
 * Flatten the keyed Cal `/slots` data object into a single array sorted ascending
 * by parsed instant. Date keys are NOT guaranteed ordered, and each value is an
 * array of `{ start }`; we sort by `Date.parse(iso)` (which respects the embedded
 * offset). Pure + exported for the unit test.
 */
export function flattenSlots(data: unknown): FlatSlot[] {
  const out: FlatSlot[] = []
  if (data && typeof data === "object") {
    for (const value of Object.values(data as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue
      for (const entry of value) {
        const start =
          entry && typeof entry === "object" && typeof (entry as { start?: unknown }).start === "string"
            ? String((entry as { start: string }).start)
            : ""
        if (!start) continue
        out.push({ iso: start, date: start.slice(0, 10) })
      }
    }
  }
  out.sort((a, b) => Date.parse(a.iso) - Date.parse(b.iso))
  return out
}

/**
 * GET /slots — available interview slots for an event type in a window.
 * Returns the flattened + sorted slot list (empty `data:{}` → `[]`).
 */
export async function getAvailableSlots(q: SlotsQuery, apiKey: string = getCalcomApiKey()): Promise<FlatSlot[]> {
  const params = new URLSearchParams()
  params.set("start", q.start)
  params.set("end", q.end)
  params.set("eventTypeId", String(q.eventTypeId))
  if (q.timeZone) params.set("timeZone", q.timeZone)
  if (typeof q.duration === "number" && q.duration > 0) params.set("duration", String(q.duration))
  const url = `${BASE}/slots?${params.toString()}`

  let resp: Response
  try {
    resp = await withTimeout((signal) =>
      fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "cal-api-version": API_VERSION.slots,
        },
        signal,
      }),
    )
  } catch (err) {
    throw new CalcomServerError(
      0,
      `Cal.com slots network error: ${err instanceof Error ? err.message : String(err)}`,
      null,
    )
  }

  const parsed = await readJson(resp)
  const retryAfter = resp.headers.get("retry-after") ?? undefined
  if (resp.status >= 200 && resp.status < 300) {
    const data = parsed && typeof parsed === "object" ? (parsed as { data?: unknown }).data : undefined
    return flattenSlots(data)
  }
  classifyHttp(resp.status, errMessage(parsed, resp.status, "slots"), parsed, retryAfter ?? undefined)
}

// ---------------------------------------------------------------------------
// POST /bookings
// ---------------------------------------------------------------------------

export interface CreateBookingInput {
  /** ISO (the chosen slot — Cal accepts ISO w/ offset). */
  start: string
  eventTypeId: number
  attendee: { name: string; email: string; timeZone: string; language?: "en"; phoneNumber?: string }
  /** default omitted → event type's own length (15/20m). */
  lengthInMinutes?: number
  /** <=50 keys, key<=40ch, val<=500ch. */
  metadata?: Record<string, string>
  /** all our event types use cal-video. */
  location?: { type: "integration"; integration: "cal-video" }
}

export interface BookingResult {
  id: number
  uid: string
  title: string
  /** status === "accepted" on success. */
  status: string
  start: string
  end: string
  duration: number
  eventType: { id: number; slug: string }
}

/**
 * POST /bookings — create the real Cal.com booking. Always includes the
 * `cal-video` integration location + `attendee.language:"en"`.
 *
 * NOTE: Cal.com auto-sends its OWN confirmation email on an accepted booking;
 * our Mailgun confirmation (sendInterviewConfirmationEmail) is a WeKruit-branded
 * SUPPLEMENT. This means the candidate may receive TWO emails — acceptable for v1.
 */
export async function createBooking(
  input: CreateBookingInput,
  apiKey: string = getCalcomApiKey(),
): Promise<BookingResult> {
  const body: CreateBookingInput = {
    ...input,
    attendee: { language: "en", ...input.attendee },
    // Only forward a location if the caller explicitly set one. Do NOT default to
    // cal-video — Cal 400s a location whose integration ≠ the event-type's configured
    // one. With no location, Cal applies the event-type's OWN integration (verified
    // 2026-06-01: omitting it booked a google-meet event-type that the cal-video
    // hardcode had been 400-rejecting on every attempt).
    ...(input.location ? { location: input.location } : {}),
  }

  let resp: Response
  try {
    resp = await withTimeout((signal) =>
      fetch(`${BASE}/bookings`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "cal-api-version": API_VERSION.bookings,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      }),
    )
  } catch (err) {
    throw new CalcomServerError(
      0,
      `Cal.com bookings network error: ${err instanceof Error ? err.message : String(err)}`,
      null,
    )
  }

  const parsed = await readJson(resp)
  const retryAfter = resp.headers.get("retry-after") ?? undefined
  if (resp.status >= 200 && resp.status < 300) {
    const data = parsed && typeof parsed === "object" ? (parsed as { data?: unknown }).data : undefined
    return (data ?? {}) as BookingResult
  }
  classifyHttp(resp.status, errMessage(parsed, resp.status, "bookings"), parsed, retryAfter ?? undefined)
}

// ---------------------------------------------------------------------------
// GET /event-types (optional / diagnostic — NOT wired into the tools)
// ---------------------------------------------------------------------------

export interface EventType {
  id: number
  lengthInMinutes?: number
  slug: string
  title: string
  hidden?: boolean
}

/**
 * GET /event-types?username=<u> — diagnostic helper for an admin/backfill of the
 * routing map. Not on the candidate hot path.
 */
export async function getEventTypes(username: string, apiKey: string = getCalcomApiKey()): Promise<EventType[]> {
  const params = new URLSearchParams()
  params.set("username", username)
  const url = `${BASE}/event-types?${params.toString()}`

  let resp: Response
  try {
    resp = await withTimeout((signal) =>
      fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "cal-api-version": API_VERSION.eventTypes,
        },
        signal,
      }),
    )
  } catch (err) {
    throw new CalcomServerError(
      0,
      `Cal.com event-types network error: ${err instanceof Error ? err.message : String(err)}`,
      null,
    )
  }

  const parsed = await readJson(resp)
  const retryAfter = resp.headers.get("retry-after") ?? undefined
  if (resp.status >= 200 && resp.status < 300) {
    const data = parsed && typeof parsed === "object" ? (parsed as { data?: unknown }).data : undefined
    return Array.isArray(data) ? (data as EventType[]) : []
  }
  classifyHttp(resp.status, errMessage(parsed, resp.status, "event-types"), parsed, retryAfter ?? undefined)
}
