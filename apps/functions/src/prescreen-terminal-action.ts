/**
 * v1.9 Phase 84 — Post-terminal action handler.
 *
 * Called by `prescreen-turn-handler.ts` AFTER `pipeline.runTurn` reaches a
 * terminal state and the terminal text has been sent. Implements:
 *
 *   - TERMINAL-01: PASS → reveal employer next step; do not push unrelated recs
 *   - TERMINAL-02: FAIL → fire generateJobRecs(userId) with "match other jobs?"
 *   - TERMINAL-03: HARD_STOP → retain/contact candidate only, no immediate recs.
 *     A hard stop means a must-have failed with high confidence. Immediate
 *     recommendations can over-trust stale global tags and contradict the
 *     just-finished transcript, so matching should happen later from the
 *     broader candidate pool.
 *   - TERMINAL-04: PAUSE → write pausedAt + no auto-action
 *   - TERMINAL-05: fail-open + audit event for each fire
 *   - TERMINAL-06: idempotency keyed (sessionId, terminal)
 *   - LEVEL1-01..03: PASS Level 1 reveal SMS sequenced after terminal copy
 *
 * Sequence on PASS:
 *   1. terminal text (already sent by caller)
 *   2. Level 1 reveal SMS (this module)
 *   3. write terminalActionFiredAt stamp + audit event
 */

import { type Firestore, type Timestamp } from "firebase-admin/firestore"
import {
  applyPartialUserTags,
  composeLevel1Reveal,
  composeFailJobRecsPreamble,
  type Level1RevealFields,
} from "@pa/pa-orchestrator"
import { sendRuntimeApprovedIMessage } from "./runtime-approved-outbox.js"
import { runPiiConfirmForUser } from "./pii-confirm-start.js"
import { markPrescreenTerminalOutcome } from "./prescreen-outcome-service.js"
import {
  buildJobRecommendationRuntimeContext,
  collectJobRecommendationMessageItems,
  collectLiveFirestoreJobRecommendationMessageItems,
  composeJobRecommendationMessage,
  compactJobRecContext,
  type JobRecIntroContext,
  type JobRecommendationSource,
} from "./job-rec-copy.js"
import { isClaireEntryUxCanary } from "./claire-agent/canary.js"

export type PrescreenTerminalKind = "PASS" | "FAIL" | "HARD_STOP" | "PAUSE"
const BETA_CANDIDATE_VISIBLE_LANG = "en" as const

export interface RunPrescreenTerminalActionArgs {
  db: Firestore
  sessionId: string
  terminal: PrescreenTerminalKind
  userId: string
  jobId: string
  toE164: string
  lang: "zh" | "en"
  /** Optional injected job-recs caller for tests. */
  generateJobRecs?: (args: {
    userId: string
    toE164: string
    lang?: "zh" | "en"
  }) => Promise<{ ok: boolean; jobCount: number; reason?: string }>
  /** Optional injected PII bootstrap (for tests). */
  startPii?: (args: {
    db: Firestore
    userId: string
    toE164: string
    jobId: string
    sourceSessionId: string
    source: "pass" | "fail"
    lang?: "zh" | "en"
    onComplete: (a: { userId: string; toE164: string; jobId: string }) => Promise<void>
    log: (event: string, payload: Record<string, unknown>) => void
  }) => Promise<{ ok: boolean; skipped: boolean; reason?: string }>
  /** Optional injected SMS sender for tests. */
  sendSms?: (args: {
    to: string
    content: string
    userId?: string
    db?: import("firebase-admin/firestore").Firestore
    runtimeSource?: string
    idempotencyKey?: string
  }) => Promise<void>
  /** Optional injected marketplace outcome marker for tests. */
  markOutcome?: (args: {
    db: Firestore
    sessionId: string
    userId: string
    jobId: string
    terminal: PrescreenTerminalKind
    occurredAt: string
  }) => Promise<unknown>
  /** Optional clock for tests. */
  now?: () => Date
  log?: (event: string, payload: Record<string, unknown>) => void
}

export interface RunPrescreenTerminalActionResult {
  /** Idempotency: action was already fired prior. */
  alreadyFired: boolean
  /** Whether Level 1 reveal was sent (PASS only). */
  level1Sent: boolean
  /** Whether generateJobRecs was invoked. */
  jobRecsFired: boolean
  /** Outcome of job rec call (when fired). */
  jobRecsResult?: { ok: boolean; jobCount: number; reason?: string }
}

interface PaJobLevel1Fields {
  jobTitle?: string
  company?: string
  applyUrl?: string
  salaryRange?: string
  nextStepEta?: string
}

function isUserExitLikePrescreenReply(reply: string): boolean {
  const normalized = reply.trim().toLowerCase()
  if (!normalized) return false
  if (/^(stop|cancel|pause|quit|exit|end|not now|later|nevermind|never mind)[.!\s]*$/i.test(normalized)) {
    return true
  }
  return /^(please\s+)?(stop|cancel|pause|quit|exit|end)\b(?=.*\b(this|screen|role|interview|prescreen|pre-screen|for now|now|please)\b)[a-z0-9\s'’.-]*[.!?。！？\s]*$/i.test(normalized)
}

function isMemoryEligiblePrescreenScore(q: {
  s: number | null
  summary: string
  answered?: boolean
  abortHintKind?: string
}): boolean {
  if (q.abortHintKind === "off_topic" || q.abortHintKind === "decline") return false
  if (q.answered === false && !q.summary.trim()) return false
  return q.summary.trim().length > 0 || q.s !== null
}

function deriveWeakPrescreenTags(args: {
  terminal: PrescreenTerminalKind
  scored: Array<{ qId: string; s: number | null; c: number | null; summary: string }>
  recentReplies: string[]
}): string[] {
  const tags = new Set<string>(["job_prescreen"])
  const positiveScored = args.scored.filter((q) => typeof q.s === "number" && q.s >= 0.5)
  const haystackParts = [
    ...positiveScored.map((q) => `${q.qId} ${q.summary}`),
    ...(args.terminal === "PASS" || positiveScored.length > 0 ? args.recentReplies : []),
  ]
  const haystack = haystackParts.join(" ").toLowerCase()
  if (haystack.includes("javascript") || haystack.includes("react") || haystack.includes("ui")) tags.add("frontend_development")
  if (haystack.includes("sql") || haystack.includes("database") || haystack.includes("db")) tags.add("data_workflows")
  if (haystack.includes("debug") || haystack.includes("failure") || haystack.includes("triage")) tags.add("debugging_workflows")
  if (haystack.includes("operator") || haystack.includes("ops") || haystack.includes("dashboard")) tags.add("operator_tools")
  if (haystack.includes("san francisco")) tags.add("san_francisco")
  if (haystack.includes("no current or future visa sponsorship") || haystack.includes("do not need current or future visa")) {
    tags.add("no_visa_sponsorship")
  }
  return Array.from(tags).slice(0, 10)
}

function mergeStringTags(existing: unknown, next: string[], maxItems: number): string[] {
  const existingValues: string[] = []
  if (Array.isArray(existing)) {
    for (const value of existing) {
      if (typeof value !== "string") continue
      const normalized = value.trim()
      if (normalized && !existingValues.includes(normalized)) existingValues.push(normalized)
    }
  }
  const nextValues: string[] = []
  for (const value of next) {
    const normalized = value.trim()
    if (normalized && !nextValues.includes(normalized)) nextValues.push(normalized)
  }
  const merged = Array.from(new Set([...existingValues, ...nextValues]))
  if (merged.length <= maxItems) return merged
  const nextSet = new Set(nextValues)
  const existingSlots = Math.max(0, maxItems - nextValues.length)
  return [
    ...merged.filter((value) => !nextSet.has(value)).slice(0, existingSlots),
    ...nextValues,
  ].slice(0, maxItems)
}

async function readLevel1Fields(
  db: Firestore,
  jobId: string
): Promise<PaJobLevel1Fields | null> {
  if (!jobId) return null
  const snap = await db.collection("pa-jobs").doc(jobId).get()
  if (!snap.exists) return null
  const data = snap.data() ?? {}
  const cfg = (data.prescreenConfig ?? {}) as Record<string, unknown>
  const level1 = (cfg.level1Reveal ?? {}) as Record<string, unknown>
  return {
    jobTitle: typeof cfg.jobTitle === "string" ? cfg.jobTitle : undefined,
    company: typeof cfg.company === "string" ? cfg.company : undefined,
    applyUrl: typeof level1.applyUrl === "string" ? level1.applyUrl : undefined,
    salaryRange: typeof level1.salaryRange === "string" ? level1.salaryRange : undefined,
    nextStepEta: typeof level1.nextStepEta === "string" ? level1.nextStepEta : undefined,
  }
}

/**
 * Best-effort lazy import of `generateJobRecsForUser` extracted from
 * `apps/functions/src/index.ts`. Composing the actual function inline
 * would entangle module-init in tests, so we accept it via injection +
 * provide a default via late-bound require for production.
 *
 * EXPORTED (2026-06-05 #3 convergence) so the prescreen→onboarding convergence
 * (`startSharedOnboardingAfterPrescreen`) can fire the SAME find_match-backed recs
 * the FAIL terminal already uses, instead of duplicating the closure. Reuse, not rebuild.
 */
export async function defaultGenerateJobRecs(args: {
  userId: string
  toE164: string
  lang?: "zh" | "en"
}): Promise<{ ok: boolean; jobCount: number; reason?: string }> {
  // Dynamic import keeps test isolation. The deps factory in index.ts
  // builds the same closure; we duplicate the minimal version here to
  // avoid circular import.
  const { getFirestore } = await import("firebase-admin/firestore")
  const { queryMatchingJobsV16, sendImessage: send, recordRecommendedJobs } = await import("@pa/job-rec")
  const db = getFirestore()
  const result = await queryMatchingJobsV16(
    { userId: args.userId, limit: 5, lang: "en", allowBroadFallback: true },
    { db, log: () => undefined }
  )
  if (result.noUserTags) return { ok: false, jobCount: 0, reason: "no_user_tags" }
  if (!result.jobs || result.jobs.length === 0) {
    return { ok: false, jobCount: 0, reason: "no_matches" }
  }
  let userTagsForJobRec: unknown
  let introContext: JobRecIntroContext | undefined
  try {
    const userDoc = await db.collection("pa-users").doc(args.userId).get()
    userTagsForJobRec = userDoc.exists ? userDoc.data()?.tags : undefined
    introContext = compactJobRecContext(userTagsForJobRec)
  } catch {
    userTagsForJobRec = undefined
    introContext = undefined
  }
  const items = await collectLiveFirestoreJobRecommendationMessageItems(db, result.jobs, "en", {
    limit: 3,
    candidateTags: userTagsForJobRec,
  })
  if (items.length === 0) {
    return { ok: false, jobCount: 0, reason: "no_linkable_matches" }
  }
  const sendRes = await send(
    {
      userId: args.userId,
      context: buildJobRecommendationRuntimeContext(items, introContext, {
        requestedCount: 3,
        source: "prescreen_terminal_action",
        eventKind: "prescreen_terminal_job_recommendations",
      }),
      idempotencyKey: `${args.userId}-${new Date().toISOString().slice(0, 16)}-prescreen-term`,
    },
    { db, log: () => undefined }
  )
  if (sendRes.ok) {
    const { buildRichMatchReason } = await import("@pa/job-rec")
    const candidateTagsForReason =
      userTagsForJobRec && typeof userTagsForJobRec === "object"
        ? (userTagsForJobRec as Record<string, unknown>)
        : undefined
    await recordRecommendedJobs(
      db,
      {
        userId: args.userId,
        // Persist the grounded "why matched" pitch so /me/matches reads the GOOD
        // reason rather than recomputing weak templates.
        jobs: items.map((item) => {
          const sourceJob = item.sourceJob as Record<string, unknown>
          let matchReason: string | undefined
          if (candidateTagsForReason) {
            try {
              matchReason = buildRichMatchReason({
                candidate: candidateTagsForReason,
                job: sourceJob,
                matchedSkills:
                  (sourceJob.matchedSkills as Array<{ name?: string }> | undefined) ?? [],
                breakdown: sourceJob.v16Score as Record<string, unknown> | undefined,
                lang: "en",
              })
            } catch {
              matchReason = undefined
            }
          }
          return { ...sourceJob, ...(matchReason ? { matchReason } : {}) }
        }),
        source: "prescreen_terminal_action",
      },
      () => undefined,
    )
    const lastJobBatchSentAt = new Date().toISOString()
    await db.collection("pa-job-profiles").doc(args.userId).set(
      {
        lastJobBatchSentAt,
        updatedAt: lastJobBatchSentAt,
      },
      { merge: true },
    )
  }
  return {
    ok: sendRes.ok,
    jobCount: items.length,
    ...(sendRes.ok ? {} : { reason: "send_failed" }),
  }
}

export function composeJobRecsMessage(
  jobs: JobRecommendationSource[],
  lang: "zh" | "en",
  context?: JobRecIntroContext,
): string {
  return composeJobRecommendationMessage(
    collectJobRecommendationMessageItems(jobs, lang, { limit: 3 }),
    lang,
    context,
  )
}

async function defaultSendSms(args: {
  to: string
  content: string
  userId?: string
  db?: import("firebase-admin/firestore").Firestore
  runtimeSource?: string
  idempotencyKey?: string
}): Promise<void> {
  await sendRuntimeApprovedIMessage({
    to: args.to,
    content: args.content,
    userId: args.userId,
    db: args.db,
    runtimeSource: args.runtimeSource ?? "pa_prescreen_runtime",
    idempotencyKey: args.idempotencyKey,
  })
}

function hasResumeOrLinkedInProfileSignal(user: Record<string, unknown>): boolean {
  if (typeof user.latestResumeArtifactId === "string" && user.latestResumeArtifactId.trim()) return true
  if (typeof user.linkedinUrl === "string" && user.linkedinUrl.trim()) return true
  if (user.linkedinOauthLinked === true) return true
  const resumeParseCount = user.resumeParseCount
  if (typeof resumeParseCount === "number" && Number.isFinite(resumeParseCount) && resumeParseCount > 0) {
    return true
  }
  const tags = user.tags && typeof user.tags === "object" ? user.tags as Record<string, unknown> : null
  const skills = tags && Array.isArray(tags.skills) ? tags.skills : []
  return skills.some((value) => typeof value === "string" && value.trim())
}

function prescreenTerminalActionQuestionLabel(qId: string): string {
  return qId.replace(/_/g, " ").trim()
}

function cleanTerminalActionSummary(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null
  const clean = value.replace(/\s+/g, " ").trim().replace(/[.。]+$/g, "")
  return clean ? clean.slice(0, max) : null
}

function rejectedPrescreenFeedback(session: Record<string, unknown>): string {
  const questions = session.questions && typeof session.questions === "object"
    ? session.questions as Record<string, unknown>
    : {}
  const rows: Array<{ qId: string; score: number; summary: string | null }> = []
  for (const [qId, raw] of Object.entries(questions)) {
    if (!raw || typeof raw !== "object") continue
    const q = raw as {
      finalS?: unknown
      scored?: { aggregate?: { summary?: unknown } }
    }
    const score = typeof q.finalS === "number" && Number.isFinite(q.finalS) ? q.finalS : null
    if (score === null) continue
    rows.push({
      qId,
      score,
      summary: cleanTerminalActionSummary(q.scored?.aggregate?.summary, 180),
    })
  }
  const weakest = rows.sort((a, b) => a.score - b.score)[0]
  if (!weakest) return "the screen did not show enough direct evidence for this specific role"
  const label = prescreenTerminalActionQuestionLabel(weakest.qId)
  if (weakest.summary) return `${label}: ${weakest.summary}`
  return `the screen needed stronger evidence on ${label}`
}

async function sendDevRejectedRetentionHandoff(args: {
  db: Firestore
  sessionId: string
  userId: string
  toE164: string
  terminal: "FAIL" | "HARD_STOP"
  session: Record<string, unknown>
  send: NonNullable<RunPrescreenTerminalActionArgs["sendSms"]>
  log: NonNullable<RunPrescreenTerminalActionArgs["log"]>
}): Promise<boolean> {
  if (!isClaireEntryUxCanary(args.userId)) return false
  let user: Record<string, unknown> = {}
  try {
    const snap = await args.db.collection("pa-users").doc(args.userId).get()
    user = (snap.data() ?? {}) as Record<string, unknown>
  } catch (err) {
    args.log("prescreen.terminal_action.rejected_handoff_user_read_failed", {
      sessionId: args.sessionId,
      userId: args.userId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  const hasProfileSignal = hasResumeOrLinkedInProfileSignal(user)
  const profileCopy = hasProfileSignal
    ? "I have some resume/LinkedIn signal on file, and I can keep using that plus this screen to pitch better-fit collaboration roles with more context."
    : "If you add your LinkedIn or resume, I can pull your experience into your profile and pitch better-fit collaboration roles with context instead of making you repeat the same background."
  const text = [
    `WeKruit team notes: this specific role probably is not moving forward because ${rejectedPrescreenFeedback(args.session)}.`,
    profileCopy,
    "Want me to send matching recommendations too?",
  ].join(" ")

  try {
    await args.send({
      to: args.toE164,
      content: text,
      userId: args.userId,
      db: args.db,
      runtimeSource: "pa_prescreen_runtime",
      idempotencyKey: `prescreen_terminal_rejected_retention:${args.sessionId}`,
    })
    await args.db.collection("pa-prescreen-sessions").doc(args.sessionId).set(
      {
        postPrescreenRetention: {
          stage: "await_profile_and_match_opt_in",
          terminal: args.terminal,
          profileSignalOnFile: hasProfileSignal,
          updatedAt: new Date().toISOString(),
        },
      },
      { merge: true },
    )
    args.log("prescreen.terminal_action.rejected_retention_handoff_sent", {
      sessionId: args.sessionId,
      userId: args.userId,
      terminal: args.terminal,
      profileSignalOnFile: hasProfileSignal,
    })
    return true
  } catch (err) {
    args.log("prescreen.terminal_action.rejected_retention_handoff_failed", {
      sessionId: args.sessionId,
      userId: args.userId,
      terminal: args.terminal,
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

export async function writePrescreenMemoryUpdate(args: {
  db: Firestore
  sessionId: string
  userId: string
  jobId: string
  terminal: PrescreenTerminalKind
  occurredAt: string
  log: NonNullable<RunPrescreenTerminalActionArgs["log"]>
}): Promise<void> {
  try {
    const sessionSnap = await args.db.collection("pa-prescreen-sessions").doc(args.sessionId).get()
    const session = sessionSnap.data() ?? {}
    const questions = (session.questions ?? {}) as Record<string, {
      finalS?: number
      finalC?: number
      scored?: {
        aggregate?: { summary?: string }
        answered?: boolean
        abortHint?: { kind?: string }
      }
    }>
    const qIds = Object.keys(questions)
    const scored = qIds
      .map((qId) => {
        const q = questions[qId] ?? {}
        return {
          qId,
          s: typeof q.finalS === "number" ? q.finalS : null,
          c: typeof q.finalC === "number" ? q.finalC : null,
          summary: typeof q.scored?.aggregate?.summary === "string" ? q.scored.aggregate.summary : "",
          answered: typeof q.scored?.answered === "boolean" ? q.scored.answered : undefined,
          abortHintKind: typeof q.scored?.abortHint?.kind === "string" ? q.scored.abortHint.kind : undefined,
        }
      })
      .filter(isMemoryEligiblePrescreenScore)
      .map(({ answered: _answered, abortHintKind: _abortHintKind, ...q }) => q)

    let lastReplies: string[] = []
    try {
      const turns = await args.db
        .collection("pa-prescreen-sessions")
        .doc(args.sessionId)
        .collection("turns")
        .orderBy("ts", "desc")
        .limit(6)
        .get()
      lastReplies = turns.docs
        .map((d) => {
          const data = d.data()
          return typeof data.reply === "string" ? data.reply.trim() : ""
        })
        .filter(Boolean)
        .filter((reply) => !isUserExitLikePrescreenReply(reply))
        .reverse()
    } catch {
      lastReplies = []
    }

    const bestSummary = scored.map((q) => q.summary).filter(Boolean).join(" | ").slice(0, 800)
    const replySummary = lastReplies.join(" / ").slice(0, 800)
    const summary = bestSummary || replySummary || (args.terminal === "PAUSE" ? "Prescreen paused by candidate" : `Prescreen ended with ${args.terminal}`)
    const evidenceTags = deriveWeakPrescreenTags({
      terminal: args.terminal,
      scored,
      recentReplies: lastReplies,
    })
    const profileEvidence = {
      kind: "job_prescreen",
      sessionId: args.sessionId,
      jobId: args.jobId,
      terminal: args.terminal,
      summary,
      scored,
      recentReplies: lastReplies,
      evidenceTags,
      updatedAt: args.occurredAt,
    }
    await args.db.collection("pa-prescreen-memory-events").doc(args.sessionId).set({
      userId: args.userId,
      jobId: args.jobId,
      terminal: args.terminal,
      summary,
      scored,
      recentReplies: lastReplies,
      createdAt: args.occurredAt,
    })

    if (args.terminal === "PAUSE") {
      args.log("prescreen.terminal_action.memory_archived", {
        sessionId: args.sessionId,
        userId: args.userId,
        terminal: args.terminal,
      })
      return
    }

    const userSnap = await args.db.collection("pa-users").doc(args.userId).get()
    const existingTags = ((userSnap.data()?.tags ?? {}) as Record<string, unknown>) || {}
    const proposedTags = mergeStringTags(existingTags.proposedTags, evidenceTags, 12)
    const update = {
      lastPrescreenMemoryUpdate: profileEvidence,
      conversationDerivedPreferences: {
        prescreenEvidenceByJob: {
          [args.jobId]: profileEvidence,
        },
        updatedAt: args.occurredAt,
      },
      updatedAt: args.occurredAt,
    }
    await args.db.collection("pa-users").doc(args.userId).set(update, { merge: true })
    await applyPartialUserTags(
      args.db,
      args.userId,
      { proposedTags },
      {
        source: "chat",
        nowIso: args.occurredAt,
        log: (event, payload) => args.log(event, payload ?? {}),
      },
    )
    args.log("prescreen.terminal_action.memory_updated", {
      sessionId: args.sessionId,
      userId: args.userId,
      terminal: args.terminal,
    })
  } catch (err) {
    args.log("prescreen.terminal_action.memory_update_failed", {
      sessionId: args.sessionId,
      userId: args.userId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

async function endMatchingUserPrescreenWorkSession(args: {
  db: Firestore
  sessionId: string
  userId: string
  jobId: string
  terminal: PrescreenTerminalKind
  occurredAt: string
  sessionWorkSession: unknown
  log: NonNullable<RunPrescreenTerminalActionArgs["log"]>
}): Promise<void> {
  try {
    const userRef = args.db.collection("pa-users").doc(args.userId)
    const userSnap = await userRef.get()
    const userData = userSnap.data() ?? {}
    const current = userData.workSession && typeof userData.workSession === "object"
      ? userData.workSession as Record<string, unknown>
      : null
    if (
      current?.kind === "job_prescreen" &&
      current.status === "active" &&
      current.sessionId &&
      current.sessionId !== args.sessionId
    ) {
      args.log("prescreen.terminal_action.user_work_session_skip", {
        sessionId: args.sessionId,
        userId: args.userId,
        currentKind: current?.kind ?? null,
        currentStatus: current?.status ?? null,
        currentSessionId: current?.sessionId ?? null,
      })
      return
    }
    const sessionWorkSession = args.sessionWorkSession && typeof args.sessionWorkSession === "object"
      ? args.sessionWorkSession as Record<string, unknown>
      : null
    const baseWorkSession = current?.sessionId === args.sessionId
      ? current
      : sessionWorkSession ?? {}
    const boundary = args.terminal === "PAUSE"
      ? typeof sessionWorkSession?.boundary === "string" && sessionWorkSession.boundary !== "trigger"
        ? sessionWorkSession.boundary
        : "user_exit"
      : "terminal"
    await userRef.set(
      {
        workSession: {
          ...baseWorkSession,
          kind: "job_prescreen",
          status: "ended",
          boundary,
          endedAt: args.occurredAt,
          sessionId: args.sessionId,
          jobId: args.jobId,
          terminal: args.terminal,
        },
        updatedAt: args.occurredAt,
      },
      { merge: true },
    )
    args.log("prescreen.terminal_action.user_work_session_ended", {
      sessionId: args.sessionId,
      userId: args.userId,
      terminal: args.terminal,
      boundary,
    })
  } catch (err) {
    args.log("prescreen.terminal_action.user_work_session_end_failed", {
      sessionId: args.sessionId,
      userId: args.userId,
      terminal: args.terminal,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Kick off PII confirm pipeline (1st Q emit) with onComplete hook wired to
 * generateJobRecs. Returns true if started successfully.
 *
 * If skip-if-present triggers (user already consented), the recs chain
 * fires immediately via the same generateJobRecs caller.
 */
async function startPiiWithRecsChain(
  args: RunPrescreenTerminalActionArgs,
  source: "pass" | "fail",
  genJobRecs: NonNullable<RunPrescreenTerminalActionArgs["generateJobRecs"]>,
  log: NonNullable<RunPrescreenTerminalActionArgs["log"]>,
  opts: { fireJobRecs: boolean } = { fireJobRecs: true },
): Promise<boolean> {
  const startFn = args.startPii ?? runPiiConfirmForUser
  try {
    const startResult = await startFn({
      db: args.db,
      userId: args.userId,
      toE164: args.toE164,
      jobId: args.jobId,
      sourceSessionId: args.sessionId,
      source,
      lang: BETA_CANDIDATE_VISIBLE_LANG,
      onComplete: async ({ userId, toE164 }) => {
        if (!opts.fireJobRecs) return
        try {
          await genJobRecs({ userId, toE164, lang: BETA_CANDIDATE_VISIBLE_LANG })
        } catch (err) {
          log("prescreen.terminal_action.pii_recs_failed", {
            sessionId: args.sessionId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      },
      log: (event, payload) => log(`pii.${event}`, payload),
    })
    // Skip-if-present → user already consented. Fire recs immediately.
    if (startResult.skipped && opts.fireJobRecs) {
      log("prescreen.terminal_action.pii_skipped_firing_recs_directly", {
        sessionId: args.sessionId,
      })
      try {
        await genJobRecs({ userId: args.userId, toE164: args.toE164, lang: BETA_CANDIDATE_VISIBLE_LANG })
      } catch (err) {
        log("prescreen.terminal_action.recs_direct_failed", {
          sessionId: args.sessionId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return true
  } catch (err) {
    log("prescreen.terminal_action.pii_start_failed", {
      sessionId: args.sessionId,
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

/**
 * Main entry. Idempotent: subsequent calls with the same (sessionId,
 * terminal) return alreadyFired=true and do nothing.
 */
export async function runPrescreenTerminalAction(
  args: RunPrescreenTerminalActionArgs
): Promise<RunPrescreenTerminalActionResult> {
  const log = args.log ?? (() => {})
  const now = args.now ?? (() => new Date())
  const send = args.sendSms ?? defaultSendSms
  const genJobRecs = args.generateJobRecs ?? defaultGenerateJobRecs
  const markOutcome =
    args.markOutcome ??
    ((input: Parameters<NonNullable<RunPrescreenTerminalActionArgs["markOutcome"]>>[0]) =>
      markPrescreenTerminalOutcome(input))

  const sessRef = args.db.collection("pa-prescreen-sessions").doc(args.sessionId)

  // ── Idempotency check ──────────────────────────────────────────────────
  const sessSnap = await sessRef.get()
  const sessData = sessSnap.data() ?? {}
  const firedAt = sessData.terminalActionFiredAt as string | Timestamp | undefined
  if (firedAt) {
    log("prescreen.terminal_action.already_fired", {
      sessionId: args.sessionId,
      terminal: args.terminal,
    })
    return { alreadyFired: true, level1Sent: false, jobRecsFired: false }
  }

  let level1Sent = false
  let jobRecsFired = false
  let jobRecsResult: { ok: boolean; jobCount: number; reason?: string } | undefined
  const outcomeAt = now().toISOString()

  try {
    await markOutcome({
      db: args.db,
      sessionId: args.sessionId,
      userId: args.userId,
      jobId: args.jobId,
      terminal: args.terminal,
      occurredAt: outcomeAt,
    })
  } catch (err) {
    log("prescreen.terminal_action.outcome_mark_failed", {
      sessionId: args.sessionId,
      userId: args.userId,
      jobId: args.jobId,
      terminal: args.terminal,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  await writePrescreenMemoryUpdate({
    db: args.db,
    sessionId: args.sessionId,
    userId: args.userId,
    jobId: args.jobId,
    terminal: args.terminal,
    occurredAt: outcomeAt,
    log,
  })
  await endMatchingUserPrescreenWorkSession({
    db: args.db,
    sessionId: args.sessionId,
    userId: args.userId,
    jobId: args.jobId,
    terminal: args.terminal,
    occurredAt: outcomeAt,
    sessionWorkSession: sessData.workSession,
    log,
  })

  // v1.9 hotfix flow:
  //   PASS:        Level 1 reveal → start PII confirm → (onComplete) job recs
  //   FAIL/HS:     preamble       → start PII confirm → (onComplete) job recs
  //   PAUSE:       write pausedAt — no PII, no recs (user explicitly paused)
  // Job recs are fired ASYNCHRONOUSLY after candidate completes the 3 PII Qs.
  // This way ALL engaged candidates leave their contact info before getting
  // recs (max funnel capture).
  let piiStarted = false
  if (args.terminal === "PASS") {
    // LEVEL1-01..03: read level 1 fields + send reveal SMS
    const fields = await readLevel1Fields(args.db, args.jobId)
    if (fields && fields.jobTitle) {
      const level1Fields: Level1RevealFields = {
        jobTitle: fields.jobTitle,
        company: fields.company,
        applyUrl: fields.applyUrl,
        salaryRange: fields.salaryRange,
        nextStepEta: fields.nextStepEta,
      }
      const text = composeLevel1Reveal(level1Fields, BETA_CANDIDATE_VISIBLE_LANG)
      try {
        await send({
          to: args.toE164,
          content: text,
          userId: args.userId,
          db: args.db,
          runtimeSource: "pa_prescreen_runtime",
          idempotencyKey: `prescreen_terminal_level1:${args.sessionId}`,
        })
        level1Sent = true
      } catch (err) {
        log("prescreen.terminal_action.level1_send_failed", {
          sessionId: args.sessionId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    // Kick off PII confirm for contact capture. PASS already hands off to the
    // employer, so do not immediately push unrelated job recommendations.
    piiStarted = await startPiiWithRecsChain(args, "pass", genJobRecs, log, { fireJobRecs: false })
  } else if (args.terminal === "FAIL") {
    if (isClaireEntryUxCanary(args.userId)) {
      await sendDevRejectedRetentionHandoff({
        db: args.db,
        sessionId: args.sessionId,
        userId: args.userId,
        toE164: args.toE164,
        terminal: args.terminal,
        session: sessData,
        send,
        log,
      })
    } else {
      // TERMINAL-02 — preamble first, then PII collect, then recs.
      try {
        await send({
          to: args.toE164,
          content: composeFailJobRecsPreamble(BETA_CANDIDATE_VISIBLE_LANG),
          userId: args.userId,
          db: args.db,
          runtimeSource: "pa_prescreen_runtime",
          idempotencyKey: `prescreen_terminal_fail_preamble:${args.sessionId}`,
        })
      } catch (err) {
        log("prescreen.terminal_action.preamble_send_failed", {
          sessionId: args.sessionId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      piiStarted = await startPiiWithRecsChain(args, "fail", genJobRecs, log)
    }
  } else if (args.terminal === "HARD_STOP") {
    if (isClaireEntryUxCanary(args.userId)) {
      await sendDevRejectedRetentionHandoff({
        db: args.db,
        sessionId: args.sessionId,
        userId: args.userId,
        toE164: args.toE164,
        terminal: args.terminal,
        session: sessData,
        send,
        log,
      })
    } else {
      // TERMINAL-03 — preserve the candidate in the pool, but do not push
      // immediate job recommendations from stale global tags after a must-have
      // failure in the visible transcript.
      piiStarted = await startPiiWithRecsChain(args, "fail", genJobRecs, log, { fireJobRecs: false })
    }
  } else if (args.terminal === "PAUSE") {
    await sessRef.update({ pausedAt: now().toISOString() })
  }
  // jobRecsFired/Result are stamped by the PII onComplete chain (async).
  // We log piiStarted here for observability.
  jobRecsFired = piiStarted && args.terminal === "FAIL"

  // ── Stamp idempotency + audit ──────────────────────────────────────────
  const stampIso = now().toISOString()
  await sessRef.update({
    terminalActionFiredAt: stampIso,
    terminalActionResult: {
      level1Sent,
      jobRecsFired,
      jobRecsOk: jobRecsResult?.ok ?? null,
      jobRecsCount: jobRecsResult?.jobCount ?? 0,
      jobRecsReason: jobRecsResult?.reason ?? null,
    },
  })
  await args.db.collection("pa-audit-events").add({
    kind: "prescreen.terminal_action",
    sessionId: args.sessionId,
    userId: args.userId,
    jobId: args.jobId,
    terminal: args.terminal,
    level1Sent,
    jobRecsFired,
    jobRecsResult: jobRecsResult ?? null,
    ts: stampIso,
  })
  log("prescreen.terminal_action.fired", {
    sessionId: args.sessionId,
    terminal: args.terminal,
    level1Sent,
    jobRecsFired,
    jobRecsOk: jobRecsResult?.ok,
  })

  return { alreadyFired: false, level1Sent, jobRecsFired, jobRecsResult }
}
