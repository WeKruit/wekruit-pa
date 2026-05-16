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
 *   3. Supersede any other active prescreen session for this candidate, then
 *      persist a fresh pa-prescreen-sessions/{sessionId}
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
import { markFirstInterviewStarted } from "./prescreen-outcome-service.js"

export interface RunPreScreenArgs {
  db: Firestore
  jobId: string
  userId: string
  toE164: string
  /**
   * v1.9 hotfix 2026-05-13 — when set, the trigger was authorized via a
   * public-job-page pending-invite. `userId` is the phone-resolved real
   * user (canonical session owner); `sourceRequestedUserId` is the original
   * wkr_uid from localStorage, kept for attribution.
   *
   * The pending-invite doc keyed by `sourceRequestedUserId` was already
   * consumed at the trigger level — do NOT re-consume here.
   */
  sourceRequestedUserId?: string
  markStarted?: (args: {
    db: Firestore
    sessionId: string
    userId: string
    jobId: string
    occurredAt: string
  }) => Promise<unknown>
  sendSms?: typeof sendImessage
  log?: (event: string, payload: Record<string, unknown>) => void
}

export interface RunPreScreenResult {
  ok: boolean
  reason?: "config_missing" | "config_invalid" | "send_failed" | "started" | "resumed"
  sessionId: string
  firstQuestionSent?: boolean
}

function deriveSessionId(jobId: string, userId: string, nowIso: string): string {
  const stamp = nowIso.replace(/[^0-9A-Za-z]/g, "")
  return `ps_${jobId}_${userId}_${stamp}`
}

const MIN_PRESCREEN_PROBE_ROUNDS = 4

export async function runPreScreenForUser(args: RunPreScreenArgs): Promise<RunPreScreenResult> {
  const log = args.log ?? (() => {})
  const markStarted = args.markStarted ?? markFirstInterviewStarted
  const sendSms = args.sendSms ?? sendImessage
  const nowIso = new Date().toISOString()
  const sessionId = deriveSessionId(args.jobId, args.userId, nowIso)

  // 1. Load config
  const jobSnap = await args.db.collection("pa-jobs").doc(args.jobId).get()
  const data = jobSnap.data()
  const rawCfg = data?.prescreenConfig
  if (!rawCfg) {
    log("prescreen.config_missing", { jobId: args.jobId })
    const title = typeof data?.title === "string" && data.title.trim() ? data.title.trim() : "this role"
    try {
      await sendSms({
        to: args.toE164,
        content: `Claire's screen for ${title} is still being prepared. WeKruit has the role listed, but the employer-specific questions are not approved yet. We will unlock this screen when it is ready.`,
        userId: args.userId,
        db: args.db,
      })
    } catch (err) {
      log("prescreen.config_missing_notice_failed", {
        jobId: args.jobId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
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

  // 2. A new trigger starts a new job work-session. Durable candidate profile
  // stays global, but active prescreen conversation state must not leak across
  // jobs or repeated starts.
  await supersedeOtherActivePrescreens(args.db, {
    userId: args.userId,
    newSessionId: sessionId,
    nowIso,
    log,
  })

  // 3. Persist fresh session state.
  const sessRef = args.db.collection("pa-prescreen-sessions").doc(sessionId)
  const firstQText = cfg.questions[0].prompt.en

  const state = emptyPreScreenState({
    sessionId,
    userId: args.userId,
    jobId: args.jobId,
    questions: configToStateQuestions(cfg),
    threshold: cfg.threshold,
    confidenceThreshold: cfg.confidenceThreshold,
    maxClarifyRounds: Math.max(cfg.maxClarifyRounds, MIN_PRESCREEN_PROBE_ROUNDS),
    nowIso,
  })
  await sessRef.set({
    ...state,
    cfgSnapshot: cfg, // snapshot of config at session start
    e164: args.toE164,
    workSession: {
      kind: "job_prescreen",
      status: "active",
      startedAt: nowIso,
      boundary: "trigger",
    },
  })
  await args.db.collection("pa-users").doc(args.userId).set(
    {
      workSession: {
        kind: "job_prescreen",
        status: "active",
        startedAt: nowIso,
        boundary: "trigger",
        sessionId,
        jobId: args.jobId,
      },
      updatedAt: nowIso,
    },
    { merge: true },
  )

  // 4. Send first question.
  const opener = `Hi — Claire from ${cfg.company ?? "WeKruit"}. Quick screen for ${cfg.jobTitle}. ${firstQText}`

  // v1.9 hotfix 2026-05-13 — when the trigger was authorized via a
  // public-job-page pending-invite, attribute the session to the candidate's
  // job-page visit. The pending-invite was already CONSUMED at the trigger
  // level (prescreen.ts), so we only write attribution here — do not look
  // up or delete the pending-invite doc.
  //
  // Pre-2026-05-13 the consume + attribution lived here and was keyed by
  // args.userId, but that was always the random wkr_uid (now: phone-resolved
  // real userId), so attribution wrote to the wrong pa-users doc and the
  // pending-invite was never found because args.userId no longer matches
  // the doc id. The trigger-level reconciliation passes both pieces through.
  if (args.sourceRequestedUserId) {
    try {
      await args.db
        .collection("pa-users")
        .doc(args.userId)
        .set(
          {
            attribution: {
              source: "public_job_page",
              fromJobPageRequestedUserId: args.sourceRequestedUserId,
              jobIdSeen: args.jobId,
              resolvedAt: nowIso,
            },
            updatedAt: nowIso,
          },
          { merge: true }
        )
    } catch (err) {
      log("prescreen.session_start.pending_attribution_failed", {
        userId: args.userId,
        sourceRequestedUserId: args.sourceRequestedUserId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  try {
    await markStarted({
      db: args.db,
      sessionId,
      userId: args.userId,
      jobId: args.jobId,
      occurredAt: nowIso,
    })
    await sendSms({ to: args.toE164, content: opener, userId: args.userId, db: args.db })
    log("prescreen.session_started", {
      sessionId,
      jobId: args.jobId,
      userId: args.userId,
    })
    return {
      ok: true,
      reason: "started",
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

async function supersedeOtherActivePrescreens(
  db: Firestore,
  args: {
    userId: string
    newSessionId: string
    nowIso: string
    log: (event: string, payload: Record<string, unknown>) => void
  },
): Promise<void> {
  const snap = await db
    .collection("pa-prescreen-sessions")
    .where("userId", "==", args.userId)
    .where("terminal", "==", null)
    .get()
  const updates = snap.docs
    .filter((doc) => doc.id !== args.newSessionId)
    .map((doc) =>
      doc.ref.set(
        {
          terminal: "PAUSE",
          terminalReason: `superseded_by_new_prescreen_session:${args.newSessionId}`,
          currentQId: null,
          supersededBySessionId: args.newSessionId,
          supersededAt: args.nowIso,
          updatedAt: args.nowIso,
          workSession: {
            kind: "job_prescreen",
            status: "ended",
            endedAt: args.nowIso,
            boundary: "superseded",
            supersededBySessionId: args.newSessionId,
          },
        },
        { merge: true },
      ),
    )
  await Promise.all(updates)
  if (updates.length > 0) {
    args.log("prescreen.session_start.superseded_active_sessions", {
      userId: args.userId,
      newSessionId: args.newSessionId,
      count: updates.length,
    })
  }
}
