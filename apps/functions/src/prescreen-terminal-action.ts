/**
 * v1.9 Phase 84 — Post-terminal action handler.
 *
 * Called by `prescreen-turn-handler.ts` AFTER `pipeline.runTurn` reaches a
 * terminal state and the terminal text has been sent. Implements:
 *
 *   - TERMINAL-01: PASS → fire generateJobRecs(userId) async
 *   - TERMINAL-02: FAIL → fire generateJobRecs(userId) with "match other jobs?"
 *   - TERMINAL-03: HARD_STOP → no auto-action
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

import type { Firestore, Timestamp } from "firebase-admin/firestore"
import { composeLevel1Reveal, composeFailJobRecsPreamble, type Level1RevealFields } from "@pa/pa-orchestrator"
import { sendImessage } from "./sendblue/sendblue-client.js"

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
  /** Optional injected SMS sender for tests. */
  sendSms?: (args: { to: string; content: string }) => Promise<void>
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

async function defaultSendSms(args: { to: string; content: string }): Promise<void> {
  await sendImessage({ to: args.to, content: args.content })
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

  // ── Dispatch by terminal ───────────────────────────────────────────────
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
        await send({ to: args.toE164, content: text })
        level1Sent = true
      } catch (err) {
        log("prescreen.terminal_action.level1_send_failed", {
          sessionId: args.sessionId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // TERMINAL-01: fire generateJobRecs async + fail-open
    try {
      jobRecsResult = await genJobRecs({ userId: args.userId, toE164: args.toE164 })
      jobRecsFired = true
    } catch (err) {
      log("prescreen.terminal_action.jobrecs_threw", {
        sessionId: args.sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
      jobRecsResult = { ok: false, jobCount: 0, reason: "exception" }
      jobRecsFired = true
    }
  } else if (args.terminal === "FAIL") {
    // TERMINAL-02: preamble + fire generateJobRecs
    try {
      await send({ to: args.toE164, content: composeFailJobRecsPreamble(args.lang) })
    } catch (err) {
      log("prescreen.terminal_action.preamble_send_failed", {
        sessionId: args.sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    try {
      jobRecsResult = await genJobRecs({ userId: args.userId, toE164: args.toE164 })
      jobRecsFired = true
    } catch (err) {
      log("prescreen.terminal_action.jobrecs_threw", {
        sessionId: args.sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
      jobRecsResult = { ok: false, jobCount: 0, reason: "exception" }
      jobRecsFired = true
    }
  } else if (args.terminal === "PAUSE") {
    // TERMINAL-04: write pausedAt; no auto-action
    await sessRef.update({ pausedAt: now().toISOString() })
  }
  // TERMINAL-03: HARD_STOP → no action; just stamp idempotency.

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
