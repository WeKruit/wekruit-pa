/**
 * tools/scheduling-tools.ts — Cal.com interview scheduling for thin Claire.
 *
 * Two tools, both built via buildSchedulingTools(ctx):
 *   offer_interview_slots — READ-only availability (persists the offered set so
 *                           a 1-based slotNumber resolves on the NEXT turn).
 *   book_interview_slot   — the WRITE: real Cal.com booking + WeKruit email.
 *
 * SAFETY LOCKS (greenfield, candidate-facing, real bookings + emails):
 *  1. The Cal.com key is read from process.env.CALCOM_API_KEY ONLY (inside the
 *     client) — never hardcoded.
 *  2. BOTH tools are GATED to SCHEDULING_DEV_UIDS (Adam +14243201960, Noah
 *     +12154034668). A non-dev uid → { ok:false, reason:"scheduling_not_enabled" }
 *     with ZERO Cal.com calls, ZERO Firestore writes, ZERO email. Mirrors the
 *     REC_CARD_UIDS guard in cutover.ts. (v1: even read-only offering is gated so
 *     we never promise real candidates slots we won't book.)
 *  3. Tools fail-OPEN: every path returns { ok, ... } and NEVER throws (RC
 *     contract), so a Cal.com / Mailgun outage can't break the chat turn.
 *  4. NEVER book an ISO that wasn't in the persisted offeredSlots → slot_not_offered
 *     (guards against an LLM-invented time). The LLM only PROPOSES
 *     slotNumber/partOfDay/timeZone; the tool's execute is the deterministic
 *     reducer that picks the ISO, books, and writes state (v2.0 rule: LLM never
 *     directly controls state).
 */
import { tool, z } from "../sdk.js"
import type { Firestore } from "firebase-admin/firestore"
import { InterviewBookingSchema, interviewBookingDocId, PA_COLLECTIONS } from "@pa/core-types"
import { type Location } from "@wekruit/shared-tags"

import {
  getAvailableSlots,
  createBooking,
  CalcomClientError,
  type FlatSlot,
} from "../../calcom/calcom-client.js"
import { resolveEventTypeId } from "../../calcom/event-type-routing.js"
import { sendInterviewConfirmationEmail } from "../../calcom/interview-confirmation-email.js"
import type { ClaireToolContext } from "../types.js"
import { SCHEDULING_DEV_UIDS, isSchedulingEligible } from "../scheduling-gate.js"

const INTERVIEW_BOOKINGS_COLLECTION = "pa-interview-bookings"
const PA_USERS_COLLECTION = "pa-users"

/**
 * Re-export the dev allowlist from the single source (scheduling-gate.ts).
 * Kept here for back-compat (harness + tests import it from this module). The
 * GATE is now `isSchedulingEligible` (dev uids OR the widenable
 * `paSchedulingEnabled` flag); SCHEDULING_DEV_UIDS remains the always-on floor.
 */
export { SCHEDULING_DEV_UIDS }

/** 7-day availability window from now. */
const WINDOW_DAYS = 7
/** Max slots to present per offer. */
const MAX_OFFERED = 5

const DEFAULT_TIMEZONE = "America/New_York"

/**
 * Static US location-token → IANA tz map. Keys are the EXACT canonical
 * `@wekruit/shared-tags` LOCATION_VOCAB tokens that pa-users.tags.targetLocations
 * actually stores (verified against canonical/location.ts) — e.g.
 * `san_francisco_bay_area`, `new_york_metro`. NO bare/abbreviated forms (D5 bans
 * `sf`/`nyc`/`la`, and there is no bare `new_york`/`los_angeles` token), so every
 * key here can really appear in stored tags. NO regex classification of free text
 * (honors no-regex-in-tagging). US-only platform scope keeps this small; tokens
 * not listed fall through to DEFAULT_TIMEZONE.
 */
const LOCATION_TZ: Partial<Record<Location, string>> = {
  // Eastern
  new_york_metro: "America/New_York",
  boston_metro: "America/New_York",
  washington_dc_metro: "America/New_York",
  atlanta_metro: "America/New_York",
  miami_metro: "America/New_York",
  philadelphia_metro: "America/New_York",
  pittsburgh: "America/New_York",
  charlotte: "America/New_York",
  raleigh_durham: "America/New_York",
  tampa: "America/New_York",
  orlando: "America/New_York",
  jacksonville: "America/New_York",
  detroit: "America/New_York",
  columbus_ohio: "America/New_York",
  cleveland: "America/New_York",
  cincinnati: "America/New_York",
  indianapolis: "America/New_York",
  providence: "America/New_York",
  hartford: "America/New_York",
  richmond_virginia: "America/New_York",
  buffalo: "America/New_York",
  rochester_new_york: "America/New_York",
  ann_arbor: "America/New_York",
  // Central
  chicago_metro: "America/Chicago",
  austin_metro: "America/Chicago",
  dallas_fort_worth: "America/Chicago",
  houston_metro: "America/Chicago",
  minneapolis_st_paul: "America/Chicago",
  st_louis: "America/Chicago",
  kansas_city: "America/Chicago",
  nashville: "America/Chicago",
  milwaukee: "America/Chicago",
  madison_wisconsin: "America/Chicago",
  // Mountain
  denver_metro: "America/Denver",
  salt_lake_city: "America/Denver",
  albuquerque: "America/Denver",
  boise: "America/Denver",
  // Arizona (no DST)
  phoenix: "America/Phoenix",
  tucson: "America/Phoenix",
  // Pacific
  san_francisco_bay_area: "America/Los_Angeles",
  los_angeles_metro: "America/Los_Angeles",
  seattle_metro: "America/Los_Angeles",
  portland_oregon: "America/Los_Angeles",
  san_diego: "America/Los_Angeles",
  sacramento: "America/Los_Angeles",
  santa_barbara: "America/Los_Angeles",
  las_vegas: "America/Los_Angeles",
  reno: "America/Los_Angeles",
  // Non-contiguous
  honolulu: "Pacific/Honolulu",
  anchorage: "America/Anchorage",
}

// ---------------------------------------------------------------------------
// Helpers (all fail-soft)
// ---------------------------------------------------------------------------

/** Active opportunity for the turn (matches every other tool in matching-tools.ts). */
function resolveJobId(ctx: ClaireToolContext): string {
  return (ctx.jobId ?? "").trim() || "unknown_job"
}

/**
 * Recover the active scheduling jobId across turns.
 *
 * ctx.jobId is only populated by the mode-selector on a PRESCREEN turn. The
 * candidate's slot pick almost always lands on a LATER turn, when the prescreen
 * session is terminal → mode flips to TRIAGE → ctx.jobId is undefined →
 * resolveJobId() would return "unknown_job" and key the booking doc on a
 * DIFFERENT, empty doc (the offer was persisted under the real jobId). So when
 * the turn has no usable ctx.jobId, find the candidate's most-recent live
 * scheduling doc (status offered/booked/failed) and reuse ITS jobId. Fail-soft:
 * any query error → falls back to resolveJobId(ctx) ("unknown_job").
 */
async function resolveActiveSchedulingJobId(ctx: ClaireToolContext): Promise<string> {
  const direct = resolveJobId(ctx)
  if (direct !== "unknown_job") return direct
  try {
    const snap = await ctx.db
      .collection(INTERVIEW_BOOKINGS_COLLECTION)
      .where("userId", "==", ctx.userId)
      .where("status", "in", ["offered", "booked", "failed"])
      .get()
    if (snap.empty) return direct
    // Most-recently updated wins (in-memory sort; the Cal.com tools write a
    // small number of docs per user so this is cheap + needs no composite index).
    let best: { jobId: string; updatedAt: string } | null = null
    for (const d of snap.docs) {
      const data = d.data() as Record<string, unknown>
      const jobId = typeof data.jobId === "string" ? data.jobId : ""
      if (!jobId || jobId === "unknown_job") continue
      const updatedAt = typeof data.updatedAt === "string" ? data.updatedAt : ""
      if (!best || updatedAt > best.updatedAt) best = { jobId, updatedAt }
    }
    if (best) {
      ctx.log("pa.claire.scheduling.recovered_job", { userId: ctx.userId, jobId: best.jobId })
      return best.jobId
    }
  } catch (err) {
    ctx.log("pa.claire.scheduling.recover_job_error", {
      userId: ctx.userId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return direct
}

/** A schedulable opportunity surfaced to the candidate when we must disambiguate. */
export interface SchedulableJob {
  jobId: string
  label: string
  /** canonical roleFunction token that routes the Cal event-type (dev-mimic only; real jobs route via resolveRoleFunctions). */
  roleFunction?: string
}

/**
 * Fixed 2-job mimic for SCHEDULING_DEV_UIDS so the multi-job disambiguation flow
 * is testable end-to-end EVEN when the dev account has zero real dashboard-committed
 * passes. The two roles deliberately route to DIFFERENT Cal event-types
 * (software_engineering → 5847961, creatives_and_design → 5604544) so booking the
 * CHOSEN one is verifiable on the interviewer's calendar.
 */
const DEV_MIMIC_SCHEDULABLE_JOBS: SchedulableJob[] = [
  { jobId: "dev-metavoice-swe", label: "Software Engineer @ MetaVoice", roleFunction: "software_engineering" },
  { jobId: "dev-helium-design", label: "Product Designer @ Helium", roleFunction: "creatives_and_design" },
]

/** Cap on the schedulable-jobs list we present (keeps the disambiguation prompt short). */
const MAX_SCHEDULABLE_JOBS = 5

/**
 * Build a human label for a schedulable job from the job side. The
 * pa-employer-visible-profiles doc itself carries NO job title/company (only
 * candidateId/jobId/displayName=candidate name), so resolve the label from
 * matching-jobs/{jobId} (companyName/jobTitle) → pa-jobs/{jobId} (company/jobTitle)
 * → bare jobId. Fail-soft: any read error → jobId.
 */
async function resolveJobLabel(ctx: ClaireToolContext, jobId: string): Promise<string> {
  const join = (title: string, company: string): string => {
    const t = title.trim()
    const c = company.trim()
    if (t && c) return `${t} @ ${c}`
    return t || c || jobId
  }
  try {
    const mj = await ctx.db.collection("matching-jobs").doc(jobId).get()
    if (mj.exists) {
      const d = mj.data() as Record<string, unknown>
      const title = typeof d.jobTitle === "string" ? d.jobTitle : typeof d.roleTitle === "string" ? d.roleTitle : ""
      const company = typeof d.companyName === "string" ? d.companyName : ""
      if (title || company) return join(title, company)
    }
  } catch {
    /* fail-soft */
  }
  try {
    const pj = await ctx.db.collection("pa-jobs").doc(jobId).get()
    if (pj.exists) {
      const d = pj.data() as Record<string, unknown>
      const title = typeof d.jobTitle === "string" ? d.jobTitle : ""
      const company = typeof d.company === "string" ? d.company : typeof d.companyName === "string" ? d.companyName : ""
      if (title || company) return join(title, company)
    }
  } catch {
    /* fail-soft */
  }
  return jobId
}

/**
 * The set of jobs a candidate can actually schedule = jobs with a dashboard-committed
 * PASS, which lives ONLY in pa-employer-visible-profiles (written by
 * applyPassedCandidateSnapshot via the HITL commit path). Query that collection by
 * candidateId == ctx.userId, map each to {jobId,label}, dedup by jobId, cap at 5.
 *
 * Dev-mimic fallback: for SCHEDULING_DEV_UIDS only, when the REAL query is empty,
 * return DEV_MIMIC_SCHEDULABLE_JOBS so the disambiguation flow is testable.
 * Fail-soft: any query error → [] (real) so a non-dev never gets a phantom list.
 */
export async function listSchedulableJobs(ctx: ClaireToolContext): Promise<SchedulableJob[]> {
  const out: SchedulableJob[] = []
  const seen = new Set<string>()
  try {
    const snap = await ctx.db
      .collection(PA_COLLECTIONS.employerVisibleProfiles)
      .where("candidateId", "==", ctx.userId)
      .get()
    for (const d of snap.docs) {
      const data = d.data() as Record<string, unknown>
      const jobId = typeof data.jobId === "string" ? data.jobId.trim() : ""
      if (!jobId || seen.has(jobId)) continue
      seen.add(jobId)
      out.push({ jobId, label: await resolveJobLabel(ctx, jobId) })
      if (out.length >= MAX_SCHEDULABLE_JOBS) break
    }
  } catch (err) {
    ctx.log("pa.claire.scheduling.list_jobs_error", {
      userId: ctx.userId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  // Dev-mimic ONLY when the real query found nothing (so a dev's REAL passes win).
  if (out.length === 0 && SCHEDULING_DEV_UIDS.has(ctx.userId)) {
    ctx.log("pa.claire.scheduling.list_jobs_dev_mimic", { userId: ctx.userId, count: DEV_MIMIC_SCHEDULABLE_JOBS.length })
    return DEV_MIMIC_SCHEDULABLE_JOBS.map((j) => ({ ...j }))
  }
  return out
}

/**
 * Match the candidate's free-text/jobId job pick against the schedulable list:
 * exact jobId first, then case-insensitive substring on the label. Returns the
 * matched job or null.
 */
function matchJobChoice(jobs: SchedulableJob[], jobChoice: string): SchedulableJob | null {
  const choice = jobChoice.trim()
  if (!choice) return null
  const byId = jobs.find((j) => j.jobId === choice)
  if (byId) return byId
  const lc = choice.toLowerCase()
  const bySubstr = jobs.find((j) => j.label.toLowerCase().includes(lc))
  return bySubstr ?? null
}

/** A string looks like a plausible IANA tz when it contains a "/". */
function isPlausibleIana(tz: string): boolean {
  return typeof tz === "string" && tz.includes("/")
}

/**
 * Resolve the candidate's IANA tz. First non-empty wins:
 *   1. argTz (validated plausible IANA),
 *   2. pa-users.tags.targetLocations[0] mapped via LOCATION_TZ,
 *   3. DEFAULT America/New_York (the Cal account owner's tz, not UTC).
 */
export async function resolveTimeZone(ctx: ClaireToolContext, argTz: string | null | undefined): Promise<string> {
  const fromArg = (argTz ?? "").trim()
  if (fromArg && isPlausibleIana(fromArg)) return fromArg
  try {
    const snap = await ctx.db.collection(PA_USERS_COLLECTION).doc(ctx.userId).get()
    const tags = snap.exists ? (snap.data()?.tags as Record<string, unknown> | undefined) : undefined
    const locs = tags && Array.isArray(tags.targetLocations) ? (tags.targetLocations as unknown[]) : []
    for (const raw of locs) {
      if (typeof raw !== "string") continue
      const token = raw.trim().toLowerCase()
      const tz = (LOCATION_TZ as Record<string, string | undefined>)[token]
      if (tz) return tz
      // remote / anywhere → default tz (no city signal).
      if (token.startsWith("remote") || token === "anywhere") break
    }
  } catch (err) {
    ctx.log("pa.claire.scheduling.resolve_tz_error", {
      userId: ctx.userId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return DEFAULT_TIMEZONE
}

/**
 * Resolve the candidate's email from pa-candidate-handles (forward query:
 * candidateId == userId && kind == "email"). Email is SPARSE → "" when absent.
 */
export async function resolveCandidateEmail(ctx: ClaireToolContext): Promise<string> {
  try {
    const snap = await ctx.db
      .collection("pa-candidate-handles")
      .where("candidateId", "==", ctx.userId)
      .where("kind", "==", "email")
      .limit(1)
      .get()
    if (snap.empty) return ""
    const v = snap.docs[0]!.data()?.normalizedValue
    return typeof v === "string" ? v.trim().toLowerCase() : ""
  } catch (err) {
    ctx.log("pa.claire.scheduling.resolve_email_error", {
      userId: ctx.userId,
      error: err instanceof Error ? err.message : String(err),
    })
    return ""
  }
}

/**
 * Resolve the per-job eventType override + roleFunction route signal.
 * Reads pa-jobs/{jobId}.calcomEventTypeId (override) + matching-jobs/{jobId}.roleFunction
 * (route), falling back to pa-users.tags.targetRoleFunction. Fail-soft → default.
 */
export async function resolveRoleFunctions(
  ctx: ClaireToolContext,
  jobId: string,
): Promise<{ override: number | null; roleFunctions: string[] }> {
  let override: number | null = null
  let roleFunctions: string[] = []
  const asArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : []

  if (jobId && jobId !== "unknown_job") {
    try {
      const jobSnap = await ctx.db.collection("pa-jobs").doc(jobId).get()
      const ov = jobSnap.exists ? jobSnap.data()?.calcomEventTypeId : undefined
      if (typeof ov === "number" && Number.isInteger(ov) && ov > 0) override = ov
    } catch {
      /* fail-soft */
    }
    try {
      const mjSnap = await ctx.db.collection("matching-jobs").doc(jobId).get()
      roleFunctions = mjSnap.exists ? asArr(mjSnap.data()?.roleFunction) : []
    } catch {
      /* fail-soft */
    }
  }
  if (roleFunctions.length === 0) {
    try {
      const userSnap = await ctx.db.collection(PA_USERS_COLLECTION).doc(ctx.userId).get()
      const tags = userSnap.exists ? (userSnap.data()?.tags as Record<string, unknown> | undefined) : undefined
      roleFunctions = asArr(tags?.targetRoleFunction)
    } catch {
      /* fail-soft */
    }
  }
  return { override, roleFunctions }
}

/** Candidate's first name from pa-users; "Candidate" when unknown. Fail-soft. */
async function resolveCandidateName(ctx: ClaireToolContext): Promise<string> {
  try {
    const snap = await ctx.db.collection(PA_USERS_COLLECTION).doc(ctx.userId).get()
    if (!snap.exists) return "Candidate"
    const d = snap.data() ?? {}
    const first = typeof d.firstName === "string" ? d.firstName.trim() : ""
    if (first) return first
    const display = typeof d.displayName === "string" ? d.displayName.trim() : ""
    if (display) return display
  } catch {
    /* fail-soft */
  }
  return "Candidate"
}

/** Local hour (0-23) of an ISO instant in a given IANA tz. */
function localHour(iso: string, timeZone: string): number {
  try {
    const h = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone }).format(new Date(iso))
    const n = Number(h)
    // Intl can return "24" for midnight in some runtimes — normalize.
    return Number.isFinite(n) ? n % 24 : 0
  } catch {
    return 0
  }
}

/** Local weekday (0=Sun..6=Sat) of an ISO instant in a given IANA tz; -1 on failure. */
const WD_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
function localWeekday(iso: string, timeZone: string): number {
  try {
    const s = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone }).format(new Date(iso))
    return WD_INDEX[s] ?? -1
  } catch {
    return -1
  }
}

const WEEKDAY_NAMES: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tues: 2, tue: 2,
  wednesday: 3, weds: 3, wed: 3,
  thursday: 4, thurs: 4, thur: 4, thu: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
}

/**
 * Parse a candidate's verbatim time words ("9am mon", "the 2pm friday", "first one")
 * into a CONFIDENT wall-clock hour + weekday, so book_interview_slot can reject when
 * the LLM mapped a stated time onto the wrong offered slot (the 2026-06-01 "said 9am,
 * got the 9pm slot" bug). Confidence is the whole point — we only return a value we
 * can act on, so an unparseable phrase ("first one", "2") falls through to the normal
 * slotNumber/slotIso path with NO false rejection.
 *
 *  - hour24: set ONLY when a meridiem is explicit (9am/9 p.m.) or the time is
 *    unambiguously 24h (>=13, e.g. "13:00") or noon/midnight. A bare "9" stays null
 *    (could mean either the 9am or 9pm slot — not our call to guess).
 *  - weekday: set when exactly ONE weekday name appears (0=Sun..6=Sat).
 *  - Multiple DISTINCT hours/weekdays in the phrase → that dimension stays null
 *    (ambiguous → don't flag). Pure; exported for tests.
 */
export function parseStatedTime(text: string): { hour24: number | null; weekday: number | null } {
  const t = (text || "").toLowerCase()

  // ── clock ──
  const hours = new Set<number>()
  if (/\bnoon\b/.test(t)) hours.add(12)
  if (/\bmidnight\b/.test(t)) hours.add(0)
  // H(:MM) am/pm  (e.g. "9am", "9 am", "9:00 pm", "9 p.m.")
  const reMer = /\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s?m\.?\b/g
  let m: RegExpExecArray | null
  while ((m = reMer.exec(t))) {
    let h = Number(m[1]!) % 12
    if (m[3] === "p") h += 12
    hours.add(h)
  }
  // Unambiguous 24h "H:MM" (>=13 can't be a 12h clock).
  const re24 = /\b(1[3-9]|2[0-3]):[0-5]\d\b/g
  while ((m = re24.exec(t))) hours.add(Number(m[1]!))
  const hour24 = hours.size === 1 ? [...hours][0]! : null

  // ── weekday ──
  const wds = new Set<number>()
  for (const [name, idx] of Object.entries(WEEKDAY_NAMES)) {
    if (new RegExp(`\\b${name}\\b`).test(t)) wds.add(idx)
  }
  const weekday = wds.size === 1 ? [...wds][0]! : null

  return { hour24, weekday }
}

/** partOfDay filter on the slot's LOCAL hour: morning <12, afternoon 12-17, evening >=17. */
export function filterByPartOfDay(
  slots: FlatSlot[],
  partOfDay: "morning" | "afternoon" | "evening" | "any" | null | undefined,
  timeZone: string,
): FlatSlot[] {
  if (!partOfDay || partOfDay === "any") return slots
  return slots.filter((s) => {
    const h = localHour(s.iso, timeZone)
    if (partOfDay === "morning") return h < 12
    if (partOfDay === "afternoon") return h >= 12 && h < 17
    return h >= 17 // evening
  })
}

/** Pick up to `n` slots spread evenly across the sorted array (span the week). Pure. */
export function pickSpread(slots: FlatSlot[], n: number): FlatSlot[] {
  if (slots.length <= n) return [...slots]
  const out: FlatSlot[] = []
  const stride = (slots.length - 1) / (n - 1)
  for (let i = 0; i < n; i++) {
    out.push(slots[Math.round(i * stride)]!)
  }
  // de-dup (rounding can collide) while preserving order.
  const seen = new Set<string>()
  return out.filter((s) => (seen.has(s.iso) ? false : (seen.add(s.iso), true)))
}

/** Human label for a slot in the candidate's tz, e.g. "Mon Jun 2, 9:00 AM EDT". Pure. */
export function humanLabel(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
      timeZone,
    }).format(new Date(iso))
  } catch {
    return iso
  }
}

/** Load the Cal.com booking doc, defensively parsed (never throws on a legacy/malformed doc). */
async function loadBooking(
  db: Firestore,
  id: string,
): Promise<Partial<import("@pa/core-types").InterviewBooking> | null> {
  try {
    const snap = await db.collection(INTERVIEW_BOOKINGS_COLLECTION).doc(id).get()
    if (!snap.exists) return null
    const parsed = InterviewBookingSchema.partial().safeParse(snap.data())
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Offer core (SDK-free) — shared by the offer_interview_slots tool AND the
// proactive HITL-commit invite (scheduling-invite.ts). Does NOT call tool()/the
// @openai/agents SDK, so the commit CF can build a real offer without paying the
// agent-SDK boot cost. The tool is now a thin gate + delegate.
// ---------------------------------------------------------------------------

/** Discriminated result of building an interview offer. */
export type InterviewOfferResult =
  | {
      ok: true
      jobId: string
      eventTypeId: number
      timeZone: string
      /** numbered (1-based) offered slots in the candidate's tz. */
      slots: Array<{ number: number; iso: string; label: string }>
      count: number
      filteredEmpty: boolean
    }
  | { ok: false; reason: "no_schedulable_job" }
  | { ok: false; reason: "needs_job_choice"; jobs: Array<{ jobId: string; label: string }> }
  | { ok: false; reason: "calcom_unavailable" }
  | { ok: false; reason: "no_slots" }

/**
 * Args for the SDK-free book core. The LLM (candidate path) or operator
 * (headhunter book-on-behalf) PROPOSES these; the core is the deterministic
 * reducer that resolves the ISO from the persisted offer + books + writes state.
 */
export interface BookInterviewSlotArgs {
  /** 1-based index into the persisted offeredSlots (preferred). */
  slotNumber?: number | null
  /** exact ISO that MUST be in the persisted offered set. */
  slotIso?: string | null
  /** candidate's verbatim time words (AM/PM + weekday mismatch backstop). "" / null disables the guard. */
  statedTime?: string | null
  candidateEmail?: string | null
  candidateName?: string | null
  timeZone?: string | null
}

/**
 * Discriminated result of the book core. The SUCCESS shapes + every failure
 * reason are byte-identical to what book_interview_slot's execute historically
 * returned (the candidate path's wire contract — do NOT change without updating
 * the prompt + tests).
 */
export type BookInterviewSlotResult =
  | { ok: true; action: "booked"; slotIso: string; when: string; meetingUrl: string; emailed: boolean; calBookingUid: string }
  | { ok: true; action: "already_booked"; slotIso: string; when: string; meetingUrl: string; emailed: boolean; calBookingUid: string }
  | { ok: false; reason: "slots_expired"; retryable: true }
  | { ok: false; reason: "slot_not_offered" }
  | { ok: false; reason: "no_slot_selected" }
  | { ok: false; reason: "slot_time_mismatch"; stated: string; offered: string[] }
  | { ok: false; reason: "need_email" }
  | { ok: false; reason: "already_booked_other_slot"; when: string }
  | { ok: false; reason: "slot_unavailable"; retryable: true }
  | { ok: false; reason: "calcom_unavailable"; retryable: true }

/**
 * Build (and persist) a real Cal.com interview offer for the active opportunity.
 * Pure of the agent SDK; fail-OPEN (returns a discriminated reason, never throws).
 * This is the EXACT body offer_interview_slots used to run inline — extracted so
 * the proactive invite reuses the SAME real-slots + persisted-offer path (so the
 * candidate's later slot pick resolves against the same booking doc).
 */
export async function buildInterviewOffer(
  ctx: ClaireToolContext,
  args: {
    timeZone?: string | null
    partOfDay?: "morning" | "afternoon" | "evening" | "any" | null
    jobChoice?: string | null
  },
): Promise<InterviewOfferResult> {
  const { timeZone, partOfDay, jobChoice } = args
  // RESOLVE which job this offer is for.
  //   (a) turn context (resolveActiveSchedulingJobId — ctx.jobId on a prescreen
  //       turn, else the candidate's most-recent live scheduling doc) → single,
  //       no ask. This also recovers a re-offer ('anything in the afternoon?')
  //       that arrives on a TRIAGE turn so it reconciles with the original
  //       real-jobId offer doc instead of writing an orphan __unknown_job doc.
  //   (b) else disambiguate over the candidate's dashboard-committed PASSes.
  let jobId = await resolveActiveSchedulingJobId(ctx)
  // roleFunction override carried ONLY when the chosen job is a dev-mimic (its
  // event-type is routed from this token, since it has no matching-jobs doc).
  let mimicRoleFunction: string | undefined
  if (jobId === "unknown_job") {
    const jobs = await listSchedulableJobs(ctx)
    if (jobs.length === 0) {
      ctx.log("pa.claire.offer_interview_slots", { userId: ctx.userId, reason: "no_schedulable_job" })
      return { ok: false as const, reason: "no_schedulable_job" as const }
    }
    let chosen: SchedulableJob | null = jobs.length === 1 ? jobs[0]! : null
    if (!chosen && jobChoice) chosen = matchJobChoice(jobs, jobChoice)
    if (!chosen) {
      ctx.log("pa.claire.offer_interview_slots", { userId: ctx.userId, reason: "needs_job_choice", count: jobs.length })
      return {
        ok: false as const,
        reason: "needs_job_choice" as const,
        jobs: jobs.map((j) => ({ jobId: j.jobId, label: j.label })),
      }
    }
    jobId = chosen.jobId
    mimicRoleFunction = chosen.roleFunction
  }

  const tz = await resolveTimeZone(ctx, timeZone)
  // Event-type routing: a dev-mimic chosen job has no matching-jobs doc, so
  // route from its own roleFunction token (MetaVoice→5847961, Helium→design);
  // a real job keeps the resolveRoleFunctions(ctx, jobId) path.
  const { override, roleFunctions } = mimicRoleFunction
    ? { override: null as number | null, roleFunctions: [mimicRoleFunction] }
    : await resolveRoleFunctions(ctx, jobId)
  const { eventTypeId } = resolveEventTypeId({ jobOverrideEventTypeId: override, roleFunctions })

  const now = new Date(ctx.nowIso())
  const start = now.toISOString()
  const end = new Date(now.getTime() + WINDOW_DAYS * 24 * 3600 * 1000).toISOString()

  let slots: FlatSlot[]
  try {
    slots = await getAvailableSlots({ start, end, eventTypeId, timeZone: tz })
  } catch (err) {
    // FAIL-OPEN — both error classes degrade to calcom_unavailable, never throw.
    ctx.log("pa.claire.offer_interview_slots", {
      userId: ctx.userId,
      jobId,
      error: err instanceof Error ? err.message : String(err),
    })
    return { ok: false as const, reason: "calcom_unavailable" as const }
  }

  if (slots.length === 0) {
    return { ok: false as const, reason: "no_slots" as const }
  }

  // partOfDay filter; fall back to unfiltered if it empties the list.
  const filtered = filterByPartOfDay(slots, partOfDay, tz)
  const filteredEmpty = filtered.length === 0 && (partOfDay ?? "any") !== "any"
  const usable = filtered.length > 0 ? filtered : slots

  // pick a spread of up to MAX_OFFERED.
  const picked = pickSpread(usable, MAX_OFFERED)

  // PERSIST the offer — this is what lets slotNumber resolve next turn.
  // Fail-soft: a write error still returns the slots (only a cross-turn
  // slotNumber would degrade).
  const docId = interviewBookingDocId({ userId: ctx.userId, jobId })
  const nowIso = ctx.nowIso()
  try {
    const ref = ctx.db.collection(INTERVIEW_BOOKINGS_COLLECTION).doc(docId)
    const existing = await loadBooking(ctx.db, docId)
    await ref.set(
      {
        id: docId,
        userId: ctx.userId,
        jobId,
        status: "offered",
        eventTypeId,
        timeZone: tz,
        offeredSlots: picked.map((s) => ({ iso: s.iso, date: s.date })),
        offeredAt: nowIso,
        sessionId: ctx.sessionId,
        updatedAt: nowIso,
        ...(existing ? {} : { createdAt: nowIso }),
        version: (typeof existing?.version === "number" ? existing.version : 0) + 1,
      },
      { merge: true },
    )
  } catch (err) {
    ctx.log("pa.claire.offer_interview_slots.persist_failed", {
      userId: ctx.userId,
      jobId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  ctx.log("pa.claire.offer_interview_slots", {
    userId: ctx.userId,
    jobId,
    eventTypeId,
    count: picked.length,
    filteredEmpty,
  })

  return {
    ok: true as const,
    jobId,
    eventTypeId,
    timeZone: tz,
    slots: picked.map((s, i) => ({ number: i + 1, iso: s.iso, label: humanLabel(s.iso, tz) })),
    count: picked.length,
    filteredEmpty,
  }
}

// ---------------------------------------------------------------------------
// Book core (SDK-free) — shared by the book_interview_slot candidate tool AND
// the headhunter book-on-behalf runner (headhunter-mcp/scheduling.ts). Does NOT
// call tool()/the @openai/agents SDK and never throws (fail-OPEN: every path
// returns a discriminated reason). Mirrors buildInterviewOffer's extraction: the
// candidate tool becomes a thin gate + delegate.
//
// IMPORTANT: this is the EXACT reducer book_interview_slot's execute used to run
// inline — the success shapes + every failure reason are byte-identical (the
// candidate wire contract). It reads ONLY ctx fields a partial cast provides
// (db, userId, jobId, sessionId, nowIso, log, toE164?) — never the messaging
// `transport` — so a headhunter-built ctx (no transport, no toE164) is safe.
// ---------------------------------------------------------------------------

/**
 * Resolve the candidate's chosen offered slot from the persisted booking doc and
 * create a REAL Cal.com booking (then persist booked→confirmed + send the WeKruit
 * confirmation email). The caller (candidate tool OR headhunter runner) is
 * responsible for the eligibility gate BEFORE calling this — the core itself does
 * NOT re-gate (so a future caller cohort doesn't have to be in scheduling-tools).
 */
export async function bookInterviewSlotCore(
  ctx: ClaireToolContext,
  args: BookInterviewSlotArgs,
): Promise<BookInterviewSlotResult> {
  const { slotNumber, slotIso, statedTime, candidateEmail, candidateName, timeZone } = args
  // Recover the real jobId across turns: the slot pick almost always lands
  // on a TRIAGE turn (prescreen already terminal → ctx.jobId undefined). The
  // offer was persisted under the real jobId's doc, so we MUST read that
  // same doc, not recompute the docId from a missing jobId.
  const jobId = await resolveActiveSchedulingJobId(ctx)
  const docId = interviewBookingDocId({ userId: ctx.userId, jobId })
  const doc = await loadBooking(ctx.db, docId)
  // Resolve slotNumber against the FULL offered list (the candidate's 1-based
  // numbering maps to the exact order we presented), THEN apply staleness.
  const offered = Array.isArray(doc?.offeredSlots) ? doc!.offeredSlots! : []

  // (1b) STALENESS — an offer from a prior day can have slots already in the
  // past by the time the candidate replies. If EVERY offered slot is in the
  // past, return a distinct slots_expired so the agent re-offers fresh times
  // proactively rather than blind-POSTing a past instant Cal will 4xx.
  const nowMs = Date.parse(ctx.nowIso())
  const isFuture = (iso: string): boolean => {
    const t = Date.parse(iso)
    return !Number.isFinite(nowMs) || !Number.isFinite(t) || t > nowMs
  }
  if (offered.length > 0 && !offered.some((s) => isFuture(s.iso))) {
    ctx.log("pa.claire.book_interview_slot", { userId: ctx.userId, jobId, reason: "slots_expired_all" })
    return { ok: false as const, reason: "slots_expired" as const, retryable: true }
  }

  // (2) resolve the chosen ISO STRICTLY from the persisted offered set.
  const offeredIsos = new Set(offered.map((s) => s.iso))
  let chosenIso = ""
  const argIso = (slotIso ?? "").trim()
  if (argIso) {
    if (offeredIsos.has(argIso)) chosenIso = argIso
    else {
      ctx.log("pa.claire.book_interview_slot", { userId: ctx.userId, jobId, reason: "slot_not_offered_iso" })
      return { ok: false as const, reason: "slot_not_offered" as const }
    }
  } else if (typeof slotNumber === "number") {
    const idx = slotNumber - 1
    if (idx >= 0 && idx < offered.length) chosenIso = offered[idx]!.iso
    else {
      ctx.log("pa.claire.book_interview_slot", { userId: ctx.userId, jobId, reason: "slot_not_offered_number" })
      return { ok: false as const, reason: "slot_not_offered" as const }
    }
  } else {
    return { ok: false as const, reason: "no_slot_selected" as const }
  }

  // (2b) The candidate picked a SPECIFIC slot that's already in the past →
  // slots_expired (distinct from Cal's slot_unavailable) so the agent re-offers.
  if (!isFuture(chosenIso)) {
    ctx.log("pa.claire.book_interview_slot", { userId: ctx.userId, jobId, reason: "slots_expired_picked" })
    return { ok: false as const, reason: "slots_expired" as const, retryable: true }
  }

  // (2c) STATED-TIME GUARD — the deterministic backstop for the LLM snapping a
  // candidate's wall-clock words onto the wrong offered slot (2026-06-01: "9am
  // mon" → got the mon 9PM slot, because the agent matched day+hour and dropped
  // AM/PM). The slots were PRESENTED in doc.timeZone, so compare in that same tz.
  // We only reject on a CONFIDENT conflict (explicit meridiem / unambiguous
  // weekday) — an unparseable phrase ("first one", "2") leaves both null and
  // falls through, so this never blocks a legit numbered pick. A headhunter
  // operator passing slotNumber with empty statedTime → no guard (intended).
  const presentedTz = doc?.timeZone || DEFAULT_TIMEZONE
  const stated = parseStatedTime(statedTime ?? "")
  if (stated.hour24 !== null || stated.weekday !== null) {
    const chosenHour = localHour(chosenIso, presentedTz)
    const chosenWd = localWeekday(chosenIso, presentedTz)
    const hourConflict = stated.hour24 !== null && stated.hour24 !== chosenHour
    const dayConflict = stated.weekday !== null && chosenWd >= 0 && stated.weekday !== chosenWd
    if (hourConflict || dayConflict) {
      ctx.log("pa.claire.book_interview_slot", {
        userId: ctx.userId,
        jobId,
        reason: "slot_time_mismatch",
        stated: statedTime ?? "",
        statedHour: stated.hour24,
        statedWeekday: stated.weekday,
        chosenHour,
        chosenWd,
      })
      return {
        ok: false as const,
        reason: "slot_time_mismatch" as const,
        stated: (statedTime ?? "").trim(),
        offered: offered.filter((s) => isFuture(s.iso)).map((s) => humanLabel(s.iso, presentedTz)),
      }
    }
  }

  // (3) email — required (Cal attendee + our confirmation both need it).
  const email = (candidateEmail ?? "").trim().toLowerCase() || (await resolveCandidateEmail(ctx))
  if (!email) {
    ctx.log("pa.claire.book_interview_slot", { userId: ctx.userId, jobId, reason: "need_email" })
    return { ok: false as const, reason: "need_email" as const }
  }

  // (4) dedup — a live Cal.com booking already exists. Key off the live
  // booking id/uid (NOT status), because a re-offer can re-stamp
  // status:"offered" over a prior confirmed booking while leaving the live
  // calBookingId/Uid + selectedSlotIso intact.
  const hasLiveBooking =
    (typeof doc?.calBookingId === "number" && doc.calBookingId > 0) ||
    (typeof doc?.calBookingUid === "string" && doc.calBookingUid.length > 0)

  // (4a) SAME slot already booked → already_booked, no 2nd POST (idempotent).
  if (
    (doc?.status === "booked" || doc?.status === "confirmed" || hasLiveBooking) &&
    doc?.selectedSlotIso === chosenIso
  ) {
    ctx.log("pa.claire.book_interview_slot", { userId: ctx.userId, jobId, action: "already_booked" })
    return {
      ok: true as const,
      action: "already_booked" as const,
      slotIso: chosenIso,
      when: humanLabel(chosenIso, doc?.timeZone || DEFAULT_TIMEZONE),
      // Surface the join link from the persisted doc so Claire can re-share it
      // in chat on a repeat ask (same field the email rendered). Absent → "".
      meetingUrl: typeof doc?.meetingUrl === "string" ? doc.meetingUrl : "",
      emailed: !!doc?.confirmationEmailMessageId,
      calBookingUid: doc?.calBookingUid ?? "",
    }
  }

  // (4b) RESCHEDULE GUARD — there is ALREADY a live Cal.com booking on this
  // (user × job) doc for a DIFFERENT slot. A blind second POST would create a
  // second real interview AND orphan the first on the interviewer's calendar
  // (it would never be cancelled). v1 does NOT support reschedule, so refuse:
  // the agent tells the candidate the time is locked and a teammate handles
  // any change.
  if (hasLiveBooking && doc?.selectedSlotIso && doc.selectedSlotIso !== chosenIso) {
    ctx.log("pa.claire.book_interview_slot", {
      userId: ctx.userId,
      jobId,
      reason: "already_booked_other_slot",
    })
    return {
      ok: false as const,
      reason: "already_booked_other_slot" as const,
      when: humanLabel(doc.selectedSlotIso, doc?.timeZone || DEFAULT_TIMEZONE),
    }
  }

  const name = (candidateName ?? "").trim() || (await resolveCandidateName(ctx))
  // (5) tz precedence: an explicit, plausible arg wins; else PREFER the tz
  // the slots were actually PRESENTED in (doc.timeZone) so the booking +
  // confirmation email show the SAME wall-clock the candidate picked from;
  // only then fall back to user-tags/default. (resolveTimeZone never returns
  // empty, so the old `|| doc?.timeZone` after it was dead — this mirrors the
  // eventTypeId precedence just below, which prefers doc.eventTypeId first.)
  const argTz = (timeZone ?? "").trim()
  const tz =
    argTz && isPlausibleIana(argTz)
      ? argTz
      : doc?.timeZone || (await resolveTimeZone(ctx, null))
  const eventTypeId =
    typeof doc?.eventTypeId === "number" && doc.eventTypeId > 0
      ? doc.eventTypeId
      : resolveEventTypeId(await resolveRoleFunctions(ctx, jobId)).eventTypeId
  const ref = ctx.db.collection(INTERVIEW_BOOKINGS_COLLECTION).doc(docId)
  const nowIso = ctx.nowIso()
  const baseVersion = typeof doc?.version === "number" ? doc.version : 0

  // (6) createBooking — the real WRITE.
  let booking: Awaited<ReturnType<typeof createBooking>>
  try {
    booking = await createBooking({
      start: chosenIso,
      eventTypeId,
      attendee: {
        name,
        email,
        timeZone: tz,
        language: "en",
        ...(ctx.toE164 ? { phoneNumber: ctx.toE164 } : {}),
      },
      // NO hardcoded location — Cal 400s a location whose integration doesn't
      // match the event-type's configured one ("integration cal-video not valid
      // for event type … allowed: google-meet"). Omitting it makes Cal apply the
      // event-type's OWN integration. (2026-06-01: the cal-video hardcode failed
      // EVERY booking on google-meet event-types → surfaced as "slot got taken".)
      metadata: { wekruitUserId: ctx.userId, wekruitJobId: jobId, sessionId: ctx.sessionId },
    })
  } catch (err) {
    if (err instanceof CalcomClientError) {
      // 4xx (e.g. slot already taken) → failed (recoverable). Re-offer.
      ctx.log("pa.claire.book_interview_slot", {
        userId: ctx.userId,
        jobId,
        reason: "slot_unavailable",
        status: err.status,
      })
      try {
        await ref.set(
          { id: docId, userId: ctx.userId, jobId, status: "failed", lastError: err.message.slice(0, 300), updatedAt: nowIso, version: baseVersion + 1 },
          { merge: true },
        )
      } catch {
        /* fail-soft */
      }
      return { ok: false as const, reason: "slot_unavailable" as const, retryable: true }
    }
    // 5xx / network / timeout / missing-key → transient; leave status offered.
    ctx.log("pa.claire.book_interview_slot", {
      userId: ctx.userId,
      jobId,
      reason: "calcom_unavailable",
      error: err instanceof Error ? err.message : String(err),
    })
    return { ok: false as const, reason: "calcom_unavailable" as const, retryable: true }
  }

  // (7) write booked.
  const calBookingId = typeof booking.id === "number" ? booking.id : null
  const calBookingUid = typeof booking.uid === "string" ? booking.uid : ""
  // Video-call join link (e.g. Google Meet) parsed from the Cal response →
  // persisted + rendered in the WeKruit confirmation email. Absent → null.
  const meetingUrl = typeof booking.meetingUrl === "string" && booking.meetingUrl ? booking.meetingUrl : ""
  try {
    await ref.set(
      {
        id: docId,
        userId: ctx.userId,
        jobId,
        status: "booked",
        eventTypeId,
        timeZone: tz,
        selectedSlotIso: chosenIso,
        calBookingId,
        calBookingUid: calBookingUid || null,
        meetingUrl: meetingUrl || null,
        candidateEmail: email,
        lastError: null,
        sessionId: ctx.sessionId,
        updatedAt: nowIso,
        version: baseVersion + 1,
      },
      { merge: true },
    )
  } catch (err) {
    // The booking IS made — a write hiccup must not flip ok:false. Log + continue.
    ctx.log("pa.claire.book_interview_slot.persist_booked_failed", {
      userId: ctx.userId,
      jobId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // (8) WeKruit confirmation email (supplement; Cal also auto-emails). On
  // failure, leave status booked (never break the turn) → emailed:false.
  let emailed = false
  try {
    const mail = await sendInterviewConfirmationEmail({
      to: email,
      name,
      whenIso: chosenIso,
      timeZone: tz,
      jobId,
      eventTypeId,
      ...(meetingUrl ? { meetingUrl } : {}),
      db: ctx.db,
      userId: ctx.userId,
    })
    emailed = mail.ok
    if (mail.ok) {
      try {
        await ref.set(
          {
            status: "confirmed",
            confirmationEmailSentAt: nowIso,
            confirmationEmailMessageId: mail.messageId || null,
            updatedAt: nowIso,
          },
          { merge: true },
        )
      } catch {
        /* fail-soft — the email DID send */
      }
    }
  } catch (err) {
    // sendInterviewConfirmationEmail is itself fail-open, but belt-and-suspenders.
    ctx.log("pa.claire.book_interview_slot.email_failed", {
      userId: ctx.userId,
      jobId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  ctx.log("pa.claire.book_interview_slot", {
    userId: ctx.userId,
    jobId,
    action: "booked",
    emailed,
    calBookingUid,
  })

  return {
    ok: true as const,
    action: "booked" as const,
    slotIso: chosenIso,
    when: humanLabel(chosenIso, tz),
    // The video-call join link (e.g. Google Meet) so Claire can drop it
    // straight into the iMessage lock-in bubble, not just the email. "" when
    // Cal didn't return a parseable join URL → prompt keeps the invite wording.
    meetingUrl,
    emailed,
    calBookingUid,
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export function buildSchedulingTools(ctx: ClaireToolContext) {
  // ── A. offer_interview_slots — read-only availability (gated) ─────────────
  const offerInterviewSlots = tool({
    name: "offer_interview_slots",
    description:
      "Get the interviewer's real open times and present them to the candidate to NEGOTIATE an interview. " +
      "Use when the candidate wants to schedule / book / set up an interview, when they ask for times, or " +
      "right after they PASS a collab/partner prescreen. Returns a numbered list of real open slots in the " +
      "candidate's timezone — present 3-5 of them in your voice and ask which works. To refine ('anything in " +
      "the afternoon?', 'next week?', 'I'm on west coast'), call again with partOfDay and/or timeZone. " +
      "If the candidate could be scheduling for MORE THAN ONE role, pass jobChoice = the jobId or role label " +
      "they named. If it returns needs_job_choice, ask which of the listed roles and call again with jobChoice. " +
      "Pass null for anything not stated.",
    parameters: z.object({
      timeZone: z.string().nullable(),
      partOfDay: z.enum(["morning", "afternoon", "evening", "any"]).nullable(),
      jobChoice: z.string().nullable(),
    }),
    async execute({ timeZone, partOfDay, jobChoice }) {
      // (1) GATE — no Cal.com call, no write for an ineligible uid. WIDENABLE:
      // dev uids OR the paSchedulingEnabled flag (default = dev-uids-only).
      if (!(await isSchedulingEligible(ctx.db, ctx.userId, { env: process.env }))) {
        ctx.log("pa.claire.offer_interview_slots", { userId: ctx.userId, gated: true })
        return { ok: false as const, reason: "scheduling_not_enabled" as const }
      }

      // (2) Build the real offer (SDK-free core; shared with the proactive invite).
      const offer = await buildInterviewOffer(ctx, { timeZone, partOfDay, jobChoice })
      if (!offer.ok) return offer
      // The tool's wire shape historically omitted jobId; keep it stable.
      const { jobId: _jobId, ...rest } = offer
      void _jobId
      return rest
    },
  })

  // ── B. book_interview_slot — real Cal.com booking + WeKruit email (gated) ─
  const bookInterviewSlot = tool({
    name: "book_interview_slot",
    description:
      "Book the interview slot the candidate picked from the list offer_interview_slots gave you. Pass the " +
      "slotNumber (preferred — 1-based, exactly as you listed them) or the exact slotIso from that list. ALSO " +
      "pass statedTime = the candidate's own words for the time they chose, verbatim (e.g. '9am mon', 'the 2pm " +
      "friday', 'first one', '2') — the tool uses it to reject an AM/PM or wrong-day mismatch. NEVER snap a " +
      "stated time onto a near offered slot. If the candidate typed an email this turn, pass candidateEmail. If " +
      "it returns need_email, ask for their email once then call again with candidateEmail. If it returns " +
      "slot_time_mismatch, the time they named isn't on the list — tell them that plainly and re-offer the listed " +
      "times (the tool returns them in 'offered'); do NOT book a different time. On ok:true tell them it's locked " +
      "in, and if it returns a non-empty meetingUrl include that link. Pass null for anything not provided.",
    parameters: z.object({
      slotNumber: z.number().int().min(1).max(10).nullable(),
      slotIso: z.string().nullable(),
      statedTime: z.string().nullable(),
      candidateEmail: z.string().nullable(),
      candidateName: z.string().nullable(),
      timeZone: z.string().nullable(),
    }),
    async execute({ slotNumber, slotIso, statedTime, candidateEmail, candidateName, timeZone }) {
      // (1) GATE — NO booking, NO email for an ineligible uid. WIDENABLE: dev
      // uids OR the paSchedulingEnabled flag (default = dev-uids-only).
      if (!(await isSchedulingEligible(ctx.db, ctx.userId, { env: process.env }))) {
        ctx.log("pa.claire.book_interview_slot", { userId: ctx.userId, gated: true })
        return { ok: false as const, reason: "scheduling_not_enabled" as const }
      }

      // (2) Delegate to the SDK-free book core (shared with the headhunter
      // book-on-behalf runner). The core resolves the offered slot, books via
      // Cal.com, persists booked→confirmed, and sends the WeKruit email.
      return bookInterviewSlotCore(ctx, { slotNumber, slotIso, statedTime, candidateEmail, candidateName, timeZone })
    },
  })

  return [offerInterviewSlots, bookInterviewSlot]
}
