/**
 * website-entry-event.ts — PRD §2.3/§2.4/§2.5 (ENTRY-UX-PRD.md): website-origin
 * candidate entry STATE + runtime-event emission.
 *
 * This module is the single producer seam for "a candidate entered from the
 * website" — sign-in via Google / magic link / LinkedIn OAuth
 * (candidate-magic-link-verify) and public-page resume upload
 * (public-cv-ingest). It does TWO things and composes NO candidate prose
 * (PRD rule 1 — the runtime turn does the talking):
 *
 *  1. recordWebsiteEntryContinuation — writes the §2.4 continuation state onto
 *     pa-users/{uid}.websiteEntry so the FIRST candidate message after a
 *     "Talk to Claire" click can resume the signed-in/resume/LinkedIn state
 *     instead of entering a stranger flow. This is durable server-side state;
 *     the CTA itself only needs to attribute the phone to the same uid.
 *
 *  2. emit — when the entry carries pitchable EVIDENCE (a parsed resume or a
 *     Coresignal-enriched LinkedIn profile), enqueue the SAME class of runtime
 *     event the LinkedIn pitch-handoff canary uses
 *     (eventKind "resume_parse_completed", consumed TODAY by the thin
 *     cvParsedReentry carve-out → confirmation/pitch/offer turn). Context
 *     carries websiteEntry:true + authProvider/resumeStatus/linkedinState/
 *     jobIdContext/pitchAlreadySent so the runtime can route §2.1.3's third
 *     arm (role continuation) when a job context exists.
 *
 * Idempotency convention (linkedin double-callback dedup rule): the key is a
 * PER-FLOW id — `login:<auth_time>` for a sign-in flow, `cv:<resumeId>` for a
 * parse flow — NEVER a content hash and NEVER nowIso. A double verify call of
 * one login / a double POST of one upload dedups; a genuine new flow emits.
 *
 * No routable phone (the website-first cohort): the event cannot be enqueued
 * (enqueueRuntimeEventHandoff → user_not_routable), so the continuation is
 * recorded with pendingEmit:true and REPLAYED when the phone binds
 * (connect-phone verify → replayPendingWebsiteEntryEvent). The verification-
 * code / job opener sms CTA path needs no replay: the opener inbound itself is
 * a runtime turn that reads pa-users.websiteEntry.
 *
 * Canary: NEW proactive outbound behavior → gated on isClaireEntryUxCanary
 * (dev cohort; deliberately NOT swept by PA_ONBOARDING_RAMP_ALL — see
 * claire-agent/canary.ts). Non-canary entries still record continuation state
 * (a read, not a send).
 */
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import { isClaireEntryUxCanary } from "../claire-agent/canary.js"
import {
  enqueueRuntimeEventHandoff,
  type RuntimeEventHandoffResult,
} from "../runtime-event-handoff.js"

export const WEBSITE_ENTRY_EVENT_SOURCE = "website_entry"
/** Field on pa-users/{uid} holding the §2.4 continuation state. Literal lives ONLY here. */
export const WEBSITE_ENTRY_FIELD = "websiteEntry"

export type WebsiteEntryAuthProvider = "google" | "magic_link" | "linkedin_oauth" | "unknown"
export type WebsiteEntryResumeStatus = "none" | "processing" | "parsed"
export type WebsiteEntryLinkedinState = "none" | "oauth_linked" | "url_linked" | "enriched"
export type WebsiteEntryProducer = "candidate_verify" | "public_cv_ingest"

/** The §2.4 "Talk to Claire" continuation payload (items 1-6; item 7 is runtime-owned). */
export interface WebsiteEntryState {
  candidateId: string
  authProvider: WebsiteEntryAuthProvider
  resumeStatus: WebsiteEntryResumeStatus
  linkedinState: WebsiteEntryLinkedinState
  /** Job/role context when the entry came from a job page (§2.4 item 5). */
  jobIdContext?: string | null
  /** Whether the pitch turn already ran for this candidate (pa-users.pitchedAt). */
  pitchAlreadySent: boolean
}

/** Durable shape stored at pa-users/{uid}.websiteEntry. EVERY key is always
 *  written (explicit null/false) so a set(merge) never leaves stale subkeys. */
export interface WebsiteEntryContinuationDoc {
  flowId: string
  candidateId: string
  authProvider: WebsiteEntryAuthProvider
  resumeStatus: WebsiteEntryResumeStatus
  linkedinState: WebsiteEntryLinkedinState
  jobIdContext: string | null
  pitchAlreadySent: boolean
  /** Evidence-bearing entry with no routable phone yet → replay on phone bind. */
  pendingEmit: boolean
  /** flowId of the last successfully enqueued runtime event ("" = never). */
  lastEmitFlowId: string
  source: WebsiteEntryProducer
  updatedAt: string
}

export interface WebsiteEntryDeps {
  enqueue?: typeof enqueueRuntimeEventHandoff
  isCanary?: (userId: string) => boolean
  nowIso?: () => string
}

export interface ProcessWebsiteEntryOptions {
  /** Per-flow idempotency id (login:<auth_time> | cv:<resumeId>). NEVER content-hash/nowIso. */
  flowId: string
  source: WebsiteEntryProducer
  /**
   * True when this flow PRODUCED new evidence (a fresh parse / enrich) — those
   * may emit even for an already-pitched candidate (the improved-pitch path).
   * False for a plain re-login: emit at most once and never re-pitch.
   */
  newEvidence: boolean
  deps?: WebsiteEntryDeps
}

export interface ProcessWebsiteEntryResult {
  recorded: boolean
  emitted: boolean
  pendingEmit: boolean
  skippedReason?:
    | "no_evidence"
    | "already_pitched"
    | "already_emitted_for_login"
    | "not_canary"
    | "user_not_routable"
    | "enqueue_failed"
}

/** Which evidence the pitch turn would use, or null when there is nothing to pitch from. */
export function websiteEntryEvidenceSource(
  state: Pick<WebsiteEntryState, "resumeStatus" | "linkedinState">,
): "resume" | "linkedin" | null {
  if (state.resumeStatus === "parsed") return "resume"
  if (state.linkedinState === "enriched") return "linkedin"
  return null
}

function continuationDoc(
  state: WebsiteEntryState,
  opts: { flowId: string; source: WebsiteEntryProducer; pendingEmit: boolean; lastEmitFlowId: string; nowIso: string },
): WebsiteEntryContinuationDoc {
  return {
    flowId: opts.flowId,
    candidateId: state.candidateId,
    authProvider: state.authProvider,
    resumeStatus: state.resumeStatus,
    linkedinState: state.linkedinState,
    jobIdContext: state.jobIdContext ?? null,
    pitchAlreadySent: state.pitchAlreadySent,
    pendingEmit: opts.pendingEmit,
    lastEmitFlowId: opts.lastEmitFlowId,
    source: opts.source,
    updatedAt: opts.nowIso,
  }
}

function readContinuation(userData: Record<string, unknown> | undefined): Partial<WebsiteEntryContinuationDoc> {
  const raw = userData?.[WEBSITE_ENTRY_FIELD]
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  return raw as Partial<WebsiteEntryContinuationDoc>
}

/** Best-effort continuation write (never throws — a missed record degrades to pre-PRD behavior). */
export async function recordWebsiteEntryContinuation(
  db: Firestore,
  doc: WebsiteEntryContinuationDoc,
): Promise<boolean> {
  try {
    await db
      .collection(PA_COLLECTIONS.users)
      .doc(doc.candidateId)
      .set({ [WEBSITE_ENTRY_FIELD]: doc, updatedAt: doc.updatedAt }, { merge: true })
    return true
  } catch {
    return false
  }
}

/** Build the sanitizable runtime-event context (§2.4 items 1-6; no candidate prose). */
export function buildWebsiteEntryEventContext(
  state: WebsiteEntryState,
  evidence: "resume" | "linkedin",
): Record<string, unknown> {
  return {
    cvParsedTrigger: true,
    websiteEntry: true,
    enrichmentSource: evidence,
    authProvider: state.authProvider,
    resumeStatus: state.resumeStatus,
    linkedinState: state.linkedinState,
    jobIdContext: state.jobIdContext ?? null,
    pitchAlreadySent: state.pitchAlreadySent,
  }
}

async function tryEmit(
  db: Firestore,
  state: WebsiteEntryState,
  flowId: string,
  evidence: "resume" | "linkedin",
  deps?: WebsiteEntryDeps,
): Promise<RuntimeEventHandoffResult | { ok: false; reason: "enqueue_failed" }> {
  const enqueue = deps?.enqueue ?? enqueueRuntimeEventHandoff
  try {
    return await enqueue(db, {
      userId: state.candidateId,
      source: WEBSITE_ENTRY_EVENT_SOURCE,
      // SAME eventKind the LinkedIn pitch-handoff canary emits — consumed by the
      // existing thin cvParsedReentry carve-out (no new consumption seam needed
      // for the evidence-bearing case). Context distinguishes the website origin.
      eventKind: "resume_parse_completed",
      idempotencyKey: `website-entry:${state.candidateId}:${flowId}`,
      requireExistingSession: false,
      context: buildWebsiteEntryEventContext(state, evidence),
    })
  } catch {
    return { ok: false, reason: "enqueue_failed" }
  }
}

/**
 * Record the continuation and, when the entry carries evidence, emit the
 * pitch runtime event. user_not_routable (website-first, no bound phone) →
 * continuation is recorded with pendingEmit:true for the phone-bind replay.
 */
export async function processWebsiteEntry(
  db: Firestore,
  state: WebsiteEntryState,
  opts: ProcessWebsiteEntryOptions,
): Promise<ProcessWebsiteEntryResult> {
  const nowIso = (opts.deps?.nowIso ?? (() => new Date().toISOString()))()
  const isCanary = opts.deps?.isCanary ?? isClaireEntryUxCanary

  let existing: Partial<WebsiteEntryContinuationDoc> = {}
  try {
    const snap = await db.collection(PA_COLLECTIONS.users).doc(state.candidateId).get()
    existing = readContinuation(snap.data() as Record<string, unknown> | undefined)
  } catch {
    /* best-effort — treat as no prior continuation */
  }

  const evidence = websiteEntryEvidenceSource(state)
  let skippedReason: ProcessWebsiteEntryResult["skippedReason"]
  let emitted = false
  let pendingEmit = false
  let lastEmitFlowId = typeof existing.lastEmitFlowId === "string" ? existing.lastEmitFlowId : ""

  if (!evidence) {
    skippedReason = "no_evidence"
  } else if (!opts.newEvidence && state.pitchAlreadySent) {
    // Plain re-login of an already-pitched candidate — never re-pitch (§2.4: the
    // CONTINUATION handles "known + pitched"; the proactive event does not).
    skippedReason = "already_pitched"
  } else if (!opts.newEvidence && lastEmitFlowId) {
    // Login-origin emit is one-shot: one proactive pitch event per candidate,
    // not one per login (the runtime owns what happens after).
    skippedReason = "already_emitted_for_login"
  } else if (!isCanary(state.candidateId)) {
    skippedReason = "not_canary"
  } else {
    const result = await tryEmit(db, state, opts.flowId, evidence, opts.deps)
    if (result.ok) {
      emitted = true
      lastEmitFlowId = opts.flowId
    } else if (result.reason === "user_not_routable") {
      pendingEmit = true
      skippedReason = "user_not_routable"
    } else {
      skippedReason = "enqueue_failed"
    }
  }

  const recorded = await recordWebsiteEntryContinuation(
    db,
    continuationDoc(state, {
      flowId: opts.flowId,
      source: opts.source,
      pendingEmit,
      lastEmitFlowId,
      nowIso,
    }),
  )

  return { recorded, emitted, pendingEmit, ...(skippedReason ? { skippedReason } : {}) }
}

/**
 * Phone-bind replay (connect-phone verify): a website-first candidate recorded
 * an evidence-bearing entry with no routable phone; now that the phone is
 * bound, emit the stored flow. Idempotent on the SAME flowId — a double verify
 * call replays once. Never throws.
 */
export async function replayPendingWebsiteEntryEvent(
  db: Firestore,
  userId: string,
  deps?: WebsiteEntryDeps,
): Promise<{ emitted: boolean; reason?: string }> {
  const nowIso = (deps?.nowIso ?? (() => new Date().toISOString()))()
  const isCanary = deps?.isCanary ?? isClaireEntryUxCanary
  try {
    const snap = await db.collection(PA_COLLECTIONS.users).doc(userId).get()
    const data = snap.data() as Record<string, unknown> | undefined
    const cont = readContinuation(data)
    if (cont.pendingEmit !== true || !cont.flowId) return { emitted: false, reason: "no_pending" }
    const state: WebsiteEntryState = {
      candidateId: userId,
      authProvider: cont.authProvider ?? "unknown",
      resumeStatus: cont.resumeStatus ?? "none",
      linkedinState: cont.linkedinState ?? "none",
      jobIdContext: cont.jobIdContext ?? null,
      pitchAlreadySent: cont.pitchAlreadySent === true,
    }
    const evidence = websiteEntryEvidenceSource(state)
    if (!evidence) return { emitted: false, reason: "no_evidence" }
    if (!isCanary(userId)) return { emitted: false, reason: "not_canary" }
    const result = await tryEmit(db, state, cont.flowId, evidence, deps)
    if (!result.ok) return { emitted: false, reason: result.reason }
    await recordWebsiteEntryContinuation(
      db,
      continuationDoc(state, {
        flowId: cont.flowId,
        source: cont.source ?? "candidate_verify",
        pendingEmit: false,
        lastEmitFlowId: cont.flowId,
        nowIso,
      }),
    )
    return { emitted: true }
  } catch (err) {
    return { emitted: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/** Derive linkedinState from an already-fetched pa-users doc (zero extra read). */
export function deriveLinkedinStateFromUser(
  userData: Record<string, unknown> | undefined,
): WebsiteEntryLinkedinState {
  const data = userData ?? {}
  const highlights = data.experienceHighlights
  const hasHighlights = Array.isArray(highlights) && highlights.length > 0
  const oauthLinked = data.linkedinOauthLinked === true
  const url = typeof data.linkedinUrl === "string" ? data.linkedinUrl.trim() : ""
  const hasRealUrl = url.length > 0 && !url.includes("/oauth-linked/")
  if (hasHighlights && (oauthLinked || hasRealUrl)) return "enriched"
  if (oauthLinked) return "oauth_linked"
  if (hasRealUrl) return "url_linked"
  return "none"
}

/** Derive pitchAlreadySent from an already-fetched pa-users doc. */
export function derivePitchAlreadySent(userData: Record<string, unknown> | undefined): boolean {
  const pitchedAt = userData?.pitchedAt
  return typeof pitchedAt === "string" ? pitchedAt.length > 0 : Boolean(pitchedAt)
}
