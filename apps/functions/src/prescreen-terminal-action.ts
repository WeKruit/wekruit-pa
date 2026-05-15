/**
 * v1.9 Phase 84 — Post-terminal action handler.
 *
 * Called by `prescreen-turn-handler.ts` AFTER `pipeline.runTurn` reaches a
 * terminal state and the terminal text has been sent. Implements:
 *
 *   - TERMINAL-01: PASS → fire generateJobRecs(userId) async
 *   - TERMINAL-02: FAIL → fire generateJobRecs(userId) with "match other jobs?"
 *   - TERMINAL-03 (v1.9 hotfix 2026-05-12): HARD_STOP → SAME as FAIL.
 *     Type-gate-fail (the dominant HARD_STOP cause in production — candidate
 *     missed a hard requirement) deserves "match other jobs?" follow-up.
 *     Original spec carved out HARD_STOP for "policy violation / abuse" —
 *     but type_gate_fail is NOT abuse, it's just a poor fit for this role.
 *     Reserve no-auto-action for explicit abort_hint = "abuse" / "decline"
 *     (future work).
 *   - TERMINAL-04: PAUSE → write pausedAt + no auto-action
 *   - TERMINAL-05: fail-open + audit event for each fire
 *   - TERMINAL-06: idempotency keyed (sessionId, terminal)
 *   - LEVEL1-01..03: PASS Level 1 reveal SMS sequenced BEFORE generateJobRecs
 *
 * Sequence on PASS:
 *   1. terminal text (already sent by caller)
 *   2. Level 1 reveal SMS (this module)
 *   3. generateJobRecs → its own follow-up SMS list (this module)
 *   4. write terminalActionFiredAt stamp + audit event
 */

import { type Firestore, type Timestamp } from "firebase-admin/firestore"
import {
  applyPartialUserTags,
  composeLevel1Reveal,
  composeFailJobRecsPreamble,
  type Level1RevealFields,
} from "@pa/pa-orchestrator"
import { sendImessage } from "./sendblue/sendblue-client.js"
import { runPiiConfirmForUser } from "./pii-confirm-start.js"
import { markPrescreenTerminalOutcome } from "./prescreen-outcome-service.js"

export type PrescreenTerminalKind = "PASS" | "FAIL" | "HARD_STOP" | "PAUSE"

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
  }) => Promise<{ ok: boolean; jobCount: number; reason?: string }>
  /** Optional injected PII bootstrap (for tests). */
  startPii?: (args: {
    db: Firestore
    userId: string
    toE164: string
    jobId: string
    sourceSessionId: string
    source: "pass" | "fail"
    onComplete: (a: { userId: string; toE164: string; jobId: string }) => Promise<void>
    log: (event: string, payload: Record<string, unknown>) => void
  }) => Promise<{ ok: boolean; skipped: boolean; reason?: string }>
  /** Optional injected SMS sender for tests. */
  sendSms?: (args: {
    to: string
    content: string
    userId?: string
    db?: import("firebase-admin/firestore").Firestore
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

function deriveWeakPrescreenTags(args: {
  jobId: string
  scored: Array<{ qId: string; s: number | null; c: number | null; summary: string }>
  recentReplies: string[]
}): string[] {
  const haystack = [
    args.jobId,
    ...args.scored.map((q) => `${q.qId} ${q.summary}`),
    ...args.recentReplies,
  ].join(" ").toLowerCase()
  const tags = new Set<string>(["job_prescreen"])
  if (haystack.includes("software")) tags.add("software_engineering")
  if (haystack.includes("fullstack") || haystack.includes("full-stack")) tags.add("fullstack_engineering")
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
  const merged = new Set<string>()
  if (Array.isArray(existing)) {
    for (const value of existing) {
      if (typeof value !== "string") continue
      const normalized = value.trim()
      if (normalized) merged.add(normalized)
      if (merged.size >= maxItems) return Array.from(merged)
    }
  }
  for (const value of next) {
    const normalized = value.trim()
    if (normalized) merged.add(normalized)
    if (merged.size >= maxItems) break
  }
  return Array.from(merged)
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
 */
async function defaultGenerateJobRecs(args: {
  userId: string
  toE164: string
}): Promise<{ ok: boolean; jobCount: number; reason?: string }> {
  // Dynamic import keeps test isolation. The deps factory in index.ts
  // builds the same closure; we duplicate the minimal version here to
  // avoid circular import.
  const { getFirestore } = await import("firebase-admin/firestore")
  const { queryMatchingJobsV16 } = await import("@pa/job-rec")
  const { sendImessage: send } = await import("@pa/job-rec")
  const db = getFirestore()
  const result = await queryMatchingJobsV16(
    { userId: args.userId, limit: 5 },
    { db, log: () => undefined }
  )
  if (result.noUserTags) return { ok: false, jobCount: 0, reason: "no_user_tags" }
  if (!result.jobs || result.jobs.length === 0) {
    return { ok: false, jobCount: 0, reason: "no_matches" }
  }
  const lines: string[] = ["其他可能合适的机会:"]
  for (const job of result.jobs) {
    const tag = job.companyName ? ` @ ${job.companyName}` : ""
    const url = job.atsApplyUrl
      ? `\n${job.atsApplyUrl}`
      : job.primaryUrl
        ? `\n${job.primaryUrl}`
        : ""
    const reason = job.reason ? `\n${job.reason}` : ""
    lines.push(`• ${job.jobTitle}${tag}${url}${reason}`)
  }
  const sendRes = await send(
    {
      userId: args.userId,
      content: lines.join("\n\n"),
      idempotencyKey: `${args.userId}-${new Date().toISOString().slice(0, 16)}-prescreen-term`,
    },
    { db, log: () => undefined }
  )
  return {
    ok: sendRes.ok,
    jobCount: result.jobs.length,
    ...(sendRes.ok ? {} : { reason: "send_failed" }),
  }
}

async function defaultSendSms(args: {
  to: string
  content: string
  userId?: string
  db?: import("firebase-admin/firestore").Firestore
}): Promise<void> {
  await sendImessage({
    to: args.to,
    content: args.content,
    userId: args.userId,
    db: args.db,
  })
}

async function writePrescreenMemoryUpdate(args: {
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
    const questions = (session.questions ?? {}) as Record<string, { finalS?: number; finalC?: number; scored?: { aggregate?: { summary?: string } } }>
    const qIds = Object.keys(questions)
    const scored = qIds
      .map((qId) => {
        const q = questions[qId] ?? {}
        return {
          qId,
          s: typeof q.finalS === "number" ? q.finalS : null,
          c: typeof q.finalC === "number" ? q.finalC : null,
          summary: typeof q.scored?.aggregate?.summary === "string" ? q.scored.aggregate.summary : "",
        }
      })
      .filter((q) => q.summary || q.s !== null || q.c !== null)

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
        .reverse()
    } catch {
      lastReplies = []
    }

    const bestSummary = scored.map((q) => q.summary).filter(Boolean).join(" | ").slice(0, 800)
    const replySummary = lastReplies.join(" / ").slice(0, 800)
    const summary = bestSummary || replySummary || `Prescreen ended with ${args.terminal}`
    const evidenceTags = deriveWeakPrescreenTags({
      jobId: args.jobId,
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
    await args.db.collection("pa-prescreen-memory-events").doc(args.sessionId).set({
      userId: args.userId,
      jobId: args.jobId,
      terminal: args.terminal,
      summary,
      scored,
      recentReplies: lastReplies,
      createdAt: args.occurredAt,
    })
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
  log: NonNullable<RunPrescreenTerminalActionArgs["log"]>
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
      onComplete: async ({ userId, toE164 }) => {
        try {
          await genJobRecs({ userId, toE164 })
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
    if (startResult.skipped) {
      log("prescreen.terminal_action.pii_skipped_firing_recs_directly", {
        sessionId: args.sessionId,
      })
      try {
        await genJobRecs({ userId: args.userId, toE164: args.toE164 })
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
      const text = composeLevel1Reveal(level1Fields, args.lang)
      try {
        await send({ to: args.toE164, content: text, userId: args.userId, db: args.db })
        level1Sent = true
      } catch (err) {
        log("prescreen.terminal_action.level1_send_failed", {
          sessionId: args.sessionId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    // Kick off PII confirm (pass source); onComplete fires generateJobRecs
    piiStarted = await startPiiWithRecsChain(args, "pass", genJobRecs, log)
  } else if (args.terminal === "FAIL" || args.terminal === "HARD_STOP") {
    // TERMINAL-02 + TERMINAL-03 — preamble first, then PII collect, then recs.
    try {
      await send({ to: args.toE164, content: composeFailJobRecsPreamble(args.lang), userId: args.userId, db: args.db })
    } catch (err) {
      log("prescreen.terminal_action.preamble_send_failed", {
        sessionId: args.sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    piiStarted = await startPiiWithRecsChain(args, "fail", genJobRecs, log)
  } else if (args.terminal === "PAUSE") {
    await sessRef.update({ pausedAt: now().toISOString() })
  }
  // jobRecsFired/Result are stamped by the PII onComplete chain (async).
  // We log piiStarted here for observability.
  jobRecsFired = piiStarted // proxy — actual recs fire after PII completes

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
