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
 *   4. Emit the first question through the runtime-approved outbox
 *   5. Audit
 *
 * Subsequent candidate replies are routed by a separate Cloud Function that
 * checks active session ownership before dispatching to Claire.
 */
import type { Firestore } from "firebase-admin/firestore"
import {
  configToStateQuestions,
  safeParsePrescreenConfig,
  emptyPreScreenState,
  type PrescreenConfig,
} from "@pa/pa-orchestrator"
import { sendRuntimeApprovedIMessage } from "./runtime-approved-outbox.js"
import { markFirstInterviewStarted } from "./prescreen-outcome-service.js"

type RuntimeSmsSender = (args: {
  to: string
  content: string
  userId?: string
  db?: Firestore
  runtimeSource?: string
  idempotencyKey?: string
}) => Promise<unknown>

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
  /**
   * The candidate already supplied the first prescreen answer in the initial
   * SMS trigger message. Start the session without re-sending Q1; the caller
   * must route that answer through runPrescreenTurnIfActive immediately after
   * this returns ok=true.
   */
  suppressFirstQuestion?: boolean
  /**
   * MATCHED-GATE bypass. When true, skip the "was this job ever matched/pushed to this candidate"
   * check. The matched-gate now guards ONLY the CONVERSATIONAL start (Adam 2026-06-03: "the
   * invited[gate] is for guarding the conversational start; but for string → start it's everyone").
   * So this is true for every caller EXCEPT the agent's begin_collab_prescreen tool (which does its
   * own matched-roles resolution before calling here):
   *   - the candidate copy-paste `WeKruit_<jobId>_<userId>_Job` STRING trigger (PrescreenTrigger) —
   *     token possession + the trigger's self-identity check IS the authorization;
   *   - admin test-drives, the broker control plane, the recovery-agent replay, the post-PASS Apply
   *     flow, and public-page first-timers (the last also via `sourceRequestedUserId`).
   * Left FALSE (gate runs) only by begin_collab_prescreen, so an agent-guessed jobId can't start a
   * screen the candidate was never matched to.
   */
  allowMatchedBypass?: boolean
  /**
   * Injectable matched-set check (tests stub it). Default reads the rec ledger
   * (`pa-user-job-recommendations/{userId}/jobs/{jobId}.recommendationCount > 0`)
   * ∪ a pending-invite for this job. Point-reads only — never the live V16 query
   * (protects the chat fn from the catalog-OOM; fail-open on read error).
   */
  isJobMatchedToUser?: (db: Firestore, userId: string, jobId: string) => Promise<boolean>
  markStarted?: (args: {
    db: Firestore
    sessionId: string
    userId: string
    jobId: string
    occurredAt: string
  }) => Promise<unknown>
  sendSms?: RuntimeSmsSender
  log?: (event: string, payload: Record<string, unknown>) => void
}

export interface RunPreScreenResult {
  ok: boolean
  reason?: "config_missing" | "config_invalid" | "send_failed" | "started" | "resumed" | "not_matched"
  sessionId: string
  firstQuestionSent?: boolean
}

const USER_JOB_RECOMMENDATIONS_COLLECTION = "pa-user-job-recommendations"
const PENDING_INVITES_COLLECTION = "pa-prescreen-pending-invites"

/**
 * Default matched-set check for the prescreen MATCHED-GATE. A candidate may only
 * start a prescreen for a job they've been MATCHED to OR have already DONE (Adam
 * 2026-05-31: "only able to start/query collab jobs if they've done it or
 * matched; else if new, go to the website and send the exact formatted text").
 * A config-bearing jobId harvested from a /j/:jobId URL or another candidate is
 * NOT startable by verbal/paste alone — the new candidate must go through the
 * website, which mints the pending-invite (→ `sourceRequestedUserId` bypass).
 * "Matched" = ever recommended, NOT match score (Rule 4: score never blocks).
 *
 * Three point-read arms (no live V16 query → protects the chat fn from the
 * catalog-OOM): (1) rec ledger recommendationCount>0, (2) an existing prescreen
 * session for this (user, job) = "done it", (3) a pending-invite for this job.
 * Fail-OPEN on read error: availability beats blocking every legit start during
 * a transient Firestore blip.
 */
export async function defaultIsJobMatchedToUser(
  db: Firestore,
  userId: string,
  jobId: string,
): Promise<boolean> {
  if (!userId || !jobId) return false
  try {
    // (1) MATCHED — ever recommended/pushed to this candidate.
    const recSnap = await db
      .collection(USER_JOB_RECOMMENDATIONS_COLLECTION)
      .doc(userId)
      .collection("jobs")
      .doc(jobId)
      .get()
    if (recSnap.exists) {
      const count = recSnap.data()?.recommendationCount
      if (typeof count === "number" && Number.isFinite(count) && count > 0) return true
    }
    // (2) DONE IT — already has a prescreen session for this job (resume/continue).
    const sessionSnap = await db
      .collection("pa-prescreen-sessions")
      .where("userId", "==", userId)
      .where("jobId", "==", jobId)
      .limit(1)
      .get()
    if (!sessionSnap.empty) return true
    // (3) PENDING-INVITE — the website public-page flow stamped one for this job.
    const inviteSnap = await db.collection(PENDING_INVITES_COLLECTION).doc(userId).get()
    if (inviteSnap.exists && inviteSnap.data()?.jobId === jobId) return true
    return false
  } catch {
    // Fail-open: a rec-ledger read error must not block legitimate starts.
    return true
  }
}

function deriveSessionId(jobId: string, userId: string, nowIso: string): string {
  const stamp = nowIso.replace(/[^0-9A-Za-z]/g, "")
  return `ps_${jobId}_${userId}_${stamp}`
}

const MIN_PRESCREEN_PROBE_ROUNDS = 4

async function replaceUserPrescreenWorkSession(args: {
  db: Firestore
  userId: string
  workSession: Record<string, unknown>
  updatedAt: string
}): Promise<void> {
  const userRef = args.db.collection("pa-users").doc(args.userId)
  const patch = {
    workSession: args.workSession,
    updatedAt: args.updatedAt,
  }
  try {
    await userRef.update(patch)
  } catch {
    await userRef.set(patch, { merge: true })
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function markSessionStartSendFailed(args: {
  db: Firestore
  sessionId: string
  userId: string
  occurredAt: string
  error: string
}): Promise<void> {
  const sessionRef = args.db.collection("pa-prescreen-sessions").doc(args.sessionId)
  const sessionSnap = await sessionRef.get()
  const session = sessionSnap.data() ?? {}
  const currentWorkSession = session.workSession && typeof session.workSession === "object"
    ? (session.workSession as Record<string, unknown>)
    : {}
  await sessionRef.set(
    {
      terminal: "PAUSE",
      terminalReason: `send_failed: ${args.error}`,
      currentQId: null,
      firstQuestionSent: false,
      firstQuestionSendFailedAt: args.occurredAt,
      firstQuestionSendError: args.error,
      updatedAt: args.occurredAt,
      workSession: {
        kind: "job_prescreen",
        status: "ended",
        startedAt: currentWorkSession.startedAt ?? session.createdAt ?? args.occurredAt,
        endedAt: args.occurredAt,
        boundary: "send_failed",
      },
    },
    { merge: true },
  )

  const userRef = args.db.collection("pa-users").doc(args.userId)
  const userSnap = await userRef.get()
  const user = userSnap.data() ?? {}
  const userWorkSession = user.workSession && typeof user.workSession === "object"
    ? (user.workSession as Record<string, unknown>)
    : null
  const isSameActivePrescreen =
    userWorkSession?.kind === "job_prescreen" &&
    userWorkSession.status === "active" &&
    userWorkSession.sessionId === args.sessionId
  if (!isSameActivePrescreen) return
  const endedWorkSession = {
    ...userWorkSession,
    status: "ended",
    endedAt: args.occurredAt,
    boundary: "send_failed",
  }
  try {
    await userRef.update({ workSession: endedWorkSession, updatedAt: args.occurredAt })
  } catch {
    await userRef.set({ workSession: endedWorkSession, updatedAt: args.occurredAt }, { merge: true })
  }
}

export async function runPreScreenForUser(args: RunPreScreenArgs): Promise<RunPreScreenResult> {
  const log = args.log ?? (() => {})
  const markStarted = args.markStarted ?? markFirstInterviewStarted
  const sendSms = args.sendSms ?? sendRuntimeApprovedIMessage
  const nowIso = new Date().toISOString()
  const sessionId = deriveSessionId(args.jobId, args.userId, nowIso)

  // 0. MATCHED-GATE (2026-05-31) — refuse a prescreen for a job never matched/
  // pushed to this candidate, BEFORE config load + BEFORE supersede (so a foreign
  // jobId can neither create a session nor PAUSE a legit in-progress screen).
  // Bypassed for admin/broker/recovery/orchestrator/Apply (non-candidate-supplied
  // jobId) and public-page first-timers (pending-invite = match evidence).
  const matchedBypass = args.allowMatchedBypass === true || !!args.sourceRequestedUserId
  if (!matchedBypass) {
    const isMatched = args.isJobMatchedToUser ?? defaultIsJobMatchedToUser
    const matched = await isMatched(args.db, args.userId, args.jobId)
    if (!matched) {
      log("prescreen.not_matched", { jobId: args.jobId, userId: args.userId })
      return { ok: false, reason: "not_matched", sessionId }
    }
  }

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
        runtimeSource: "pa_prescreen_runtime",
        idempotencyKey: `prescreen_config_missing:${args.jobId}:${args.userId}`,
      })
    } catch (err) {
      log("prescreen.config_missing_notice_failed", {
        jobId: args.jobId,
        error: err instanceof Error ? err.message : String(err),
      })
      return { ok: false, reason: "send_failed", sessionId }
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
  await replaceUserPrescreenWorkSession({
    db: args.db,
    userId: args.userId,
    updatedAt: nowIso,
    workSession: {
      kind: "job_prescreen",
      status: "active",
      startedAt: nowIso,
      boundary: "trigger",
      sessionId,
      jobId: args.jobId,
    },
  })

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

  if (args.suppressFirstQuestion) {
    await sessRef.set(
      {
        firstQuestionSent: false,
        firstQuestionSuppressedByInitialReply: true,
        updatedAt: nowIso,
      },
      { merge: true },
    )
  } else {
    try {
      await sendSms({
        to: args.toE164,
        content: opener,
        userId: args.userId,
        db: args.db,
        runtimeSource: "pa_prescreen_runtime",
        idempotencyKey: `prescreen_start:${sessionId}:opener`,
      })
    } catch (err) {
      const message = errorMessage(err)
      await markSessionStartSendFailed({
        db: args.db,
        sessionId,
        userId: args.userId,
        occurredAt: nowIso,
        error: message,
      })
      log("prescreen.send_failed", {
        sessionId,
        error: message,
      })
      return { ok: false, reason: "send_failed", sessionId }
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
  } catch (err) {
    log("prescreen.mark_started_failed", {
      sessionId,
      error: errorMessage(err),
    })
  }

  log("prescreen.session_started", {
    sessionId,
    jobId: args.jobId,
    userId: args.userId,
    firstQuestionSent: !args.suppressFirstQuestion,
  })
  return {
    ok: true,
    reason: "started",
    sessionId,
    firstQuestionSent: !args.suppressFirstQuestion,
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
