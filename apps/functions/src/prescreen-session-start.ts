/**
 * v1.8 Phase 77.3 — runPreScreenForUser real handler.
 *
 * Triggered by PrescreenTrigger (webhook.ts router dispatch). On entry we
 * know the (jobId, userId, toE164) tuple has been validated + authorized
 * + idempotency-stamped.
 *
 * Responsibilities:
 *   1. Load pa-jobs/{jobId}.prescreenConfig — refuse on missing/invalid
 *   2. Build initial PreScreenState from config
 *   3. Persist pa-prescreen-sessions/{sessionId} (sessionId derived from
 *      jobId + userId + UTC date so a same-day re-trigger reuses)
 *   4. Emit the first question via Sendblue
 *   5. Audit
 *
 * Subsequent candidate replies are routed by a separate Cloud Function
 * (paPrescreenTurn — added in a follow-up that wires the inbound router
 * to check active session before dispatching to Claire).
 */
import type { Firestore } from "firebase-admin/firestore"
import {
  configToStateQuestions,
  safeParsePrescreenConfig,
  emptyPreScreenState,
  type PrescreenConfig,
} from "@pa/pa-orchestrator"
import { sendImessage } from "./sendblue/sendblue-client.js"

export interface RunPreScreenArgs {
  db: Firestore
  jobId: string
  userId: string
  toE164: string
  log?: (event: string, payload: Record<string, unknown>) => void
}

export interface RunPreScreenResult {
  ok: boolean
  reason?: "config_missing" | "config_invalid" | "send_failed" | "started" | "resumed"
  sessionId: string
  firstQuestionSent?: boolean
}

function deriveSessionId(jobId: string, userId: string, nowIso: string): string {
  const dateStamp = nowIso.slice(0, 10).replace(/-/g, "") // YYYYMMDD
  return `ps_${jobId}_${userId}_${dateStamp}`
}

export async function runPreScreenForUser(args: RunPreScreenArgs): Promise<RunPreScreenResult> {
  const log = args.log ?? (() => {})
  const nowIso = new Date().toISOString()
  const sessionId = deriveSessionId(args.jobId, args.userId, nowIso)

  // 1. Load config
  const jobSnap = await args.db.collection("pa-jobs").doc(args.jobId).get()
  const data = jobSnap.data()
  const rawCfg = data?.prescreenConfig
  if (!rawCfg) {
    log("prescreen.config_missing", { jobId: args.jobId })
    return { ok: false, reason: "config_missing", sessionId }
  }
  const parsed = safeParsePrescreenConfig(rawCfg)
  if (!parsed.ok) {
    log("prescreen.config_invalid", {
      jobId: args.jobId,
      issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    })
    return { ok: false, reason: "config_invalid", sessionId }
  }
  const cfg: PrescreenConfig = parsed.config

  // 2-3. Check if session already exists today (idempotent re-trigger)
  const sessRef = args.db.collection("pa-prescreen-sessions").doc(sessionId)
  const existing = await sessRef.get()
  let isResume = false
  let firstQText: string

  if (existing.exists) {
    const sdata = existing.data()
    if (sdata?.terminal === null && sdata.currentQId) {
      // In-progress — re-emit the active question (resume after disconnect)
      const activeQ = cfg.questions.find((q) => q.qId === sdata.currentQId)
      if (activeQ) {
        isResume = true
        firstQText = activeQ.prompt.en // TODO lang resolution from user doc
      } else {
        firstQText = cfg.questions[0].prompt.en
      }
    } else {
      // Already terminal — surface a "you've already completed" message.
      firstQText = `You've already completed pre-screening for ${cfg.jobTitle}. The employer will reach out if it's a fit.`
    }
  } else {
    const state = emptyPreScreenState({
      sessionId,
      userId: args.userId,
      jobId: args.jobId,
      questions: configToStateQuestions(cfg),
      threshold: cfg.threshold,
      confidenceThreshold: cfg.confidenceThreshold,
      maxClarifyRounds: cfg.maxClarifyRounds,
      nowIso,
    })
    await sessRef.set({
      ...state,
      cfgSnapshot: cfg, // snapshot of config at session start
      e164: args.toE164,
    })
    firstQText = cfg.questions[0].prompt.en
  }

  // 4. Send first question (or re-emit)
  const opener = isResume
    ? `Resuming pre-screen for ${cfg.jobTitle}. ${firstQText}`
    : `Hi — Claire from ${cfg.company ?? "WeKruit"}. Quick screen for ${cfg.jobTitle}. ${firstQText}`

  // v1.9 G4 — consume any pending-invite stub from public job page so
  // we can attribute the trigger back to the candidate's job-page visit.
  // Fire-and-forget; failure is non-fatal.
  try {
    const pendingRef = args.db.collection("pa-prescreen-pending-invites").doc(args.userId)
    const pendingSnap = await pendingRef.get()
    if (pendingSnap.exists) {
      const data = pendingSnap.data() as { jobId?: string; createdAt?: string } | undefined
      if (data?.jobId && data.jobId === args.jobId) {
        await args.db
          .collection("pa-users")
          .doc(args.userId)
          .set(
            {
              attribution: {
                source: "public_job_page",
                fromJobPageRequestedUserId: args.userId,
                jobIdSeen: data.jobId,
                jobPageAt: data.createdAt,
                resolvedAt: nowIso,
              },
              updatedAt: nowIso,
            },
            { merge: true }
          )
        await pendingRef.delete().catch(() => undefined)
      }
    }
  } catch (err) {
    log("prescreen.session_start.pending_attribution_failed", {
      userId: args.userId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  try {
    await sendImessage({ to: args.toE164, content: opener, userId: args.userId, db: args.db })
    log("prescreen.session_started", {
      sessionId,
      jobId: args.jobId,
      userId: args.userId,
      isResume,
    })
    return {
      ok: true,
      reason: isResume ? "resumed" : "started",
      sessionId,
      firstQuestionSent: true,
    }
  } catch (err) {
    log("prescreen.send_failed", {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    })
    return { ok: false, reason: "send_failed", sessionId }
  }
}
