/**
 * iter34 Sprint A.6 — Poll parsedCandidateResumes for a given userId until
 * a non-empty doc shows up, or until timeout.
 *
 * Adam directive iter34 P3 follow-up:
 *   resume -> wait for parse done (max 90s) -> push CV summary tag ->
 *   user sees it -> push match
 *
 * Bug being fixed: cv-ingest is async. Old onResumeAccepted called
 * applyOnboarding("complete") in the same turn, so the very next
 * generateJobRecs call ran with empty CV signal → garbage matches.
 *
 * Design:
 *   - Poll every `intervalMs` (default 5_000)
 *   - Stop when a doc has at least one of: topSkills[], industryTags[],
 *     experiences[] non-empty (matches cv-summary's "is the doc useful?"
 *     check) — bare-doc-with-no-fields counts as "still parsing", we
 *     wait it out.
 *   - Hard cap at `timeoutMs` (default 90_000); on timeout return
 *     {cv: null, timedOut: true}.
 *
 * Pure: takes Firestore handle as `unknown` + optional sleep/now
 * injectors so tests can fast-forward time.
 */

import type { CvSummaryInput } from "../cv-summary.js"

/** Loose Firestore shape — same trick the rest of pa-orchestrator uses. */
interface QueryShape {
  where(field: string, op: string, val: unknown): QueryShape
  orderBy(field: string, dir: string): QueryShape
  limit(n: number): QueryShape
  get(): Promise<{ empty: boolean; docs: Array<{ data(): unknown }> }>
}
interface DbShape {
  collection(name: string): QueryShape
}

const PARSED_RESUMES_COLLECTION = "parsedCandidateResumes"

export interface PollParsedResumeOpts {
  /** Polling cadence in ms. Default 5_000. */
  intervalMs?: number
  /** Hard timeout in ms. Default 90_000. */
  timeoutMs?: number
  /**
   * Sleep injection — used by tests to fast-forward. Default uses
   * setTimeout. Receives the requested ms; resolves when "elapsed".
   */
  sleep?: (ms: number) => Promise<void>
  /**
   * "Now" injection — Date.now() by default. Tests use a counter to
   * advance virtual time deterministically.
   */
  now?: () => number
  /** Optional log fn for observability. */
  log?: (event: string, payload: Record<string, unknown>) => void
}

export interface PollParsedResumeResult {
  /** Non-null when a usable doc landed within the timeout. */
  cv: CvSummaryInput | null
  /** True iff we hit the hard timeout. */
  timedOut: boolean
  /** How many poll attempts ran (for tests + logs). */
  attempts: number
}

/**
 * Decides whether a parsedCandidateResume doc has enough signal that we
 * should stop polling + push the summary. A bare doc (e.g. cv-ingest
 * wrote a placeholder before fields populate) counts as "keep polling".
 */
export function isCvDocUsable(doc: unknown): boolean {
  if (!doc || typeof doc !== "object") return false
  const d = doc as Partial<CvSummaryInput>
  const hasTopSkills = Array.isArray(d.topSkills) && d.topSkills.length > 0
  const hasIndustryTags = Array.isArray(d.industryTags) && d.industryTags.length > 0
  const hasExperiences = Array.isArray(d.experiences) && d.experiences.length > 0
  // Also accept candidateProfile.skills as a "doc has signal" hint —
  // some pipelines populate this before topSkills lands.
  const cp = d.candidateProfile && typeof d.candidateProfile === "object" ? d.candidateProfile : null
  const hasProfileSkills =
    cp != null && Array.isArray(cp.skills) && cp.skills.length > 0
  return hasTopSkills || hasIndustryTags || hasExperiences || hasProfileSkills
}

/**
 * Default sleep — real wall-clock setTimeout. Tests inject a virtual one.
 */
const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Poll Firestore for a parsedCandidateResume row with usable signal.
 *
 * @param db  Firestore handle (loose-typed; matches the rest of pa-orch).
 * @param userId  The user we're parsing CV for.
 * @returns  cv (null on timeout) + timedOut flag + attempts count.
 */
export async function pollParsedCandidateResume(
  db: unknown,
  userId: string,
  opts: PollParsedResumeOpts = {}
): Promise<PollParsedResumeResult> {
  const intervalMs = opts.intervalMs ?? 5_000
  const timeoutMs = opts.timeoutMs ?? 90_000
  const sleep = opts.sleep ?? realSleep
  const now = opts.now ?? Date.now
  const log = opts.log

  const start = now()
  let attempts = 0

  // Defensive: no db means we can't poll. Treat as instant timeout.
  if (!db) {
    log?.("pa.onboarding.cv_poll.no_db", { userId })
    return { cv: null, timedOut: true, attempts: 0 }
  }
  const fdb = db as DbShape

  // Loop: query → check → sleep → repeat. We attempt at least once
  // even if timeoutMs <= 0 to guarantee a "is it already there?" probe.
  // The exit condition is: usable doc OR (now - start) >= timeoutMs.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempts++
    let doc: unknown = null
    try {
      const snap = await fdb
        .collection(PARSED_RESUMES_COLLECTION)
        .where("userId", "==", userId)
        .orderBy("createdAt", "desc")
        .limit(1)
        .get()
      if (!snap.empty) doc = snap.docs[0]!.data()
    } catch (err) {
      log?.("pa.onboarding.cv_poll.query_error", {
        userId,
        attempt: attempts,
        error: err instanceof Error ? err.message : String(err),
      })
      // On query error, do NOT bail — cv-ingest can finish even if a
      // single Firestore read flaked. Keep polling.
    }

    if (isCvDocUsable(doc)) {
      log?.("pa.onboarding.cv_poll.found", { userId, attempt: attempts })
      return { cv: doc as CvSummaryInput, timedOut: false, attempts }
    }

    const elapsed = now() - start
    if (elapsed >= timeoutMs) {
      log?.("pa.onboarding.cv_poll.timeout", { userId, attempts, elapsedMs: elapsed })
      return { cv: null, timedOut: true, attempts }
    }

    // Don't oversleep past the timeout — clamp so we exit cleanly.
    const remaining = timeoutMs - elapsed
    const wait = Math.min(intervalMs, Math.max(0, remaining))
    if (wait > 0) await sleep(wait)
  }
}
