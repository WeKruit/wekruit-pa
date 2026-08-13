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
import { readUserPrescreenSharedAnswers, AI_USAGE_SHARED_KEY } from "@pa/pa-orchestrator"
import { isYcPeopleUser } from "@pa/core-types"
import { sendRuntimeApprovedIMessage } from "./runtime-approved-outbox.js"
import { markFirstInterviewStarted } from "./prescreen-outcome-service.js"
import { hasResumeOrLinkedInProfileSignal } from "./prescreen-terminal-action.js"
import { isClaireEntryUxCanary } from "./claire-agent/canary.js"
import { isEnrichmentInFlight } from "./claire-agent/enrichment-inflight.js"
import {
  AI_QUESTION_QID,
  legacyAiQuestionConfig,
  roleFunctionFromJob,
  shouldSkipAiQuestion,
} from "./claire-agent/prescreen-ai-question.js"

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
   * Internal continuation path: once resume/LinkedIn enrichment completes, the pending start should
   * fire Q1 even if a stale in-flight marker has not cleared yet.
   */
  skipProfileReadinessHold?: boolean
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
  reason?:
    | "config_missing"
    | "config_invalid"
    | "send_failed"
    | "started"
    | "resumed"
    | "not_matched"
    /**
     * YC people lane (Adam-LOCKED 2026-07-24) — this user is a YC Startup School person
     * (founder / investor / operator). They get PEOPLE matching only: no job prescreen,
     * no job interview, no job questions. Nothing is sent.
     */
    | "yc_people_no_job_prescreen"
    /**
     * RULE 2 (2026-06-11 incident) — a session for this (userId, jobId) already
     * reached a non-null `terminal`. NEVER restart a completed screen; the
     * returned sessionId is the EXISTING terminal session's id. Nothing is sent.
     */
    | "already_completed"
    /**
     * RULE 2 race-closer — another start for the same (userId, jobId) holds the
     * in-flight lock right now (the 2026-06-11 sweep created 3 sessions in one
     * run). Friendly no-op: the concurrent start owns Q1.
     */
    | "start_in_progress"
    /**
     * Dev-phone entry UX: profile enrichment is still in flight, so Claire sent a short hold and stored
     * a pending start instead of creating a half-context prescreen session.
     */
    | "readiness_hold"
    /**
     * Candidate reached a STRICT screen (MUST_HAVE/PROBING) with NO résumé/LinkedIn on file and no
     * enrichment running (live victim Khloë 2026-06-21: token-pasted → account created → strict
     * HARD_STOP in 77s, never uploaded a résumé). Screening blind is structurally meaningless and
     * produces a fabricated rejection. Claire asks for the résumé/LinkedIn first and stores a
     * waiting_profile pending start; cutover's continuation auto-starts the screen once it lands.
     */
    | "awaiting_profile"
  sessionId: string
  firstQuestionSent?: boolean
}

const USER_JOB_RECOMMENDATIONS_COLLECTION = "pa-user-job-recommendations"
const PENDING_INVITES_COLLECTION = "pa-prescreen-pending-invites"
/**
 * ENTRY-UX PRD §2.6.3 — the readiness hold MUST offer a candidate-visible exit ("explicit
 * safe-fallback continue"), not just the internal completion event / TTL self-heal. The copy
 * advertises it; cutover's safe-fallback block and maybeHoldForProfileReadiness's
 * second-attempt continue honor it. Exported so the sims/tests assert the shipped copy.
 */
export const PROFILE_READINESS_HOLD_COPY =
  "i'm still reading through your resume/experience so i can start this screen with the right context - one sec. if you'd rather not wait, just reply and i'll start the screen right away"

const USERS_COLLECTION = "pa-users"
const PRESCREEN_SESSIONS_COLLECTION = "pa-prescreen-sessions"

/**
 * DEFAULT AI-acceleration question on the LEGACY/FSM prescreen path (Adam directive: EVERY screen
 * asks it "from now on"). The thin path already appends it (prescreen-config.ts buildThinPrescreenSeed);
 * this is the legacy analogue. REUSES the same role→prompt map + ask-once skip from
 * claire-agent/prescreen-ai-question.ts so both paths agree.
 *
 * Resolves the cross-session ask-once skip with the SAME signals as mode-selector (so a candidate who
 * answered on the thin path is not re-asked on legacy and vice versa):
 *   - the generalized global store pa-users.prescreenSharedAnswers["ai_usage"], OR
 *   - the legacy back-compat tag pa-users.tags.aiAccelerationUsage, OR
 *   - any PRIOR terminal/in-progress (other-job) session that already scored q_ai_acceleration.
 * Fail-open: on any read error → APPEND (better to ask than silently drop the Adam-mandated question).
 *
 * Returns the config to use for the session: the original config when skipping, else a SHALLOW COPY
 * with the synthetic NON-GATING q_ai_acceleration appended LAST. Injected AFTER zod parse (the schema
 * weight floor of 0.1 forbids weight:0 in a parsed config) and never re-validated, so weight 0 is safe.
 */
async function withLegacyAiQuestion(
  db: Firestore,
  userId: string,
  jobId: string,
  jobData: Record<string, unknown> | null,
  cfg: PrescreenConfig,
  log: (event: string, payload: Record<string, unknown>) => void,
): Promise<PrescreenConfig> {
  const logOpt = (event: string, payload?: Record<string, unknown>) => log(event, payload ?? {})
  // Config already declares the qId (defensive) → never double-append.
  if (cfg.questions.some((q) => q.qId === AI_QUESTION_QID)) return cfg

  let skip = false
  try {
    const [userSnap, sharedAnswers, priorScored] = await Promise.all([
      db.collection(USERS_COLLECTION).doc(userId).get(),
      readUserPrescreenSharedAnswers(db, userId, { log: logOpt }),
      hasPriorLegacyAiQuestionScored(db, userId, jobId),
    ])
    const userTags = (userSnap.exists ? userSnap.data()?.tags : null) as
      | Record<string, unknown>
      | null
    const aiUsageCarried = Boolean(sharedAnswers[AI_USAGE_SHARED_KEY]?.reply)
    skip = aiUsageCarried || shouldSkipAiQuestion(userTags, priorScored)
  } catch (err) {
    // fail-open: keep skip=false (append). Better to ask than drop the mandated question.
    log("prescreen.legacy_ai_question.skip_resolve_error", {
      jobId,
      error: err instanceof Error ? err.message : String(err),
    })
    skip = false
  }
  if (skip) {
    log("prescreen.legacy_ai_question.skipped", { jobId, userId })
    return cfg
  }
  const aiQ = legacyAiQuestionConfig(roleFunctionFromJob(jobData, cfg as unknown as Record<string, unknown>))
  log("prescreen.legacy_ai_question.appended", { jobId, userId, roleFunction: aiQ.prompt.en.slice(0, 40) })
  // Shallow copy + append LAST so gating MUST_HAVE/PROBING question order is untouched.
  return { ...cfg, questions: [...cfg.questions, aiQ as unknown as (typeof cfg.questions)[number]] }
}

/**
 * Cross-session ASK-ONCE backup signal for the legacy path: did any OTHER session already score
 * q_ai_acceleration? Mirrors mode-selector.hasPriorAiQuestionScored (userId-only query + in-memory
 * scan; the current in-progress same-job session is excluded). Fail-soft → false (default to asking).
 */
async function hasPriorLegacyAiQuestionScored(
  db: Firestore,
  userId: string,
  currentJobId: string,
): Promise<boolean> {
  try {
    const snap = await db
      .collection(PRESCREEN_SESSIONS_COLLECTION)
      .where("userId", "==", userId)
      .limit(20)
      .get()
    for (const doc of snap.docs) {
      const d = doc.data() as Record<string, unknown>
      // legacy FSM writes per-Q state under `questions`; thin writes `scored`/`scores`.
      const fromQuestions =
        d.questions && typeof d.questions === "object" && AI_QUESTION_QID in (d.questions as object)
          ? ((d.questions as Record<string, unknown>)[AI_QUESTION_QID] as Record<string, unknown>)
          : null
      const answeredInQuestions =
        fromQuestions != null && typeof fromQuestions.answeredAt === "string"
      const scored = (d.scored ?? d.scores) as Record<string, unknown> | undefined
      const answeredInScored =
        scored != null && typeof scored === "object" && AI_QUESTION_QID in scored
      if (answeredInQuestions || answeredInScored) {
        // ignore the current job's still-open session being re-counted as "prior"
        if (typeof d.jobId === "string" && d.jobId === currentJobId && d.terminal == null) continue
        return true
      }
    }
  } catch {
    /* fail-soft */
  }
  return false
}

type PendingPrescreenStart = {
  status?: unknown
  jobId?: unknown
  toE164?: unknown
  sourceRequestedUserId?: unknown
  allowMatchedBypass?: unknown
  resolvedAt?: unknown
}

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

/**
 * RULE 2 (2026-06-11 incident) — find an existing session for this exact
 * (userId, jobId) that already reached a non-null `terminal`. Same query shape
 * as defaultIsJobMatchedToUser's "done it" arm (userId== && jobId== equality,
 * no orderBy → no composite-index dependency). Bounded + filtered in memory.
 * Fail-OPEN on read error (a transient Firestore blip must not block a legit
 * start — the supersede query right after would throw anyway).
 */
const TERMINAL_SESSION_SCAN_LIMIT = 50

async function findTerminalSessionForJob(
  db: Firestore,
  userId: string,
  jobId: string,
  log: (event: string, payload: Record<string, unknown>) => void,
): Promise<{ id: string; terminal: string } | null> {
  try {
    const snap = await db
      .collection("pa-prescreen-sessions")
      .where("userId", "==", userId)
      .where("jobId", "==", jobId)
      .limit(TERMINAL_SESSION_SCAN_LIMIT)
      .get()
    for (const doc of snap.docs) {
      const data = doc.data() ?? {}
      // Ops-voided sessions (e.g. the 2026-06-11 replay duplicates) are not
      // real completions — the candidate never did that screen. They must not
      // trip the already_completed gate or the candidate gets told they
      // finished a screen they never saw.
      if (data.voidedByOps === true) continue
      const terminal = data.terminal
      if (terminal !== null && terminal !== undefined) {
        // PAUSE is a ROUTING terminal, not a completion (Adam 2026-06-12 / audit G11): a timed-out
        // or stepped-away screen is explicitly RESTARTABLE — expiredSessionText promises
        // "reply 'restart screen' and i'll start a fresh run". Treating PAUSE as already_completed
        // both blocked that promised restart AND sent the false "it's with the team for review"
        // notice for a screen that was never submitted. PASS/FAIL/HARD_STOP still gate (RULE 2's
        // actual target: never re-run a screen the candidate finished).
        if (String(terminal).toUpperCase() === "PAUSE") continue
        return { id: doc.id, terminal: String(terminal) }
      }
    }
    return null
  } catch (err) {
    log("prescreen.terminal_check_failed_open", {
      userId,
      jobId,
      error: errorMessage(err),
    })
    return null
  }
}

/**
 * RULE 2 race-closer — deterministic in-flight start lock. The session id is
 * timestamped (deriveSessionId), so two concurrent starts mint two different
 * doc ids and `set()` can't collide; the lock doc
 * `pa-prescreen-sessions-lock/<userId>_<jobId>` is `create()`-if-absent
 * (atomic ALREADY_EXISTS on the second writer) and deleted when the start
 * completes. A stale lock (crashed start, older than START_LOCK_STALE_MS) is
 * taken over so a one-off crash can't wedge the pair forever.
 */
const PRESCREEN_START_LOCK_COLLECTION = "pa-prescreen-sessions-lock"
const START_LOCK_STALE_MS = 3 * 60 * 1000

type StartLockOutcome =
  | { acquired: true }
  | { acquired: false; holderSessionId?: string }

async function acquirePrescreenStartLock(
  db: Firestore,
  args: { userId: string; jobId: string; sessionId: string; nowIso: string },
  log: (event: string, payload: Record<string, unknown>) => void,
): Promise<StartLockOutcome> {
  const lockRef = db
    .collection(PRESCREEN_START_LOCK_COLLECTION)
    .doc(`${args.userId}_${args.jobId}`)
  try {
    await lockRef.create({
      userId: args.userId,
      jobId: args.jobId,
      sessionId: args.sessionId,
      createdAt: args.nowIso,
    })
    return { acquired: true }
  } catch (err) {
    const code = (err as { code?: number }).code
    if (code !== 6 /* ALREADY_EXISTS */) {
      // Lock infra error → fail-open (the lock is belt-and-braces on top of the
      // terminal gate; never block a legit start on lock plumbing).
      log("prescreen.start_lock_error_fail_open", {
        userId: args.userId,
        jobId: args.jobId,
        error: errorMessage(err),
      })
      return { acquired: true }
    }
    try {
      const snap = await lockRef.get()
      const data = (snap.data() ?? {}) as { createdAt?: unknown; sessionId?: unknown }
      const createdMs = Date.parse(String(data.createdAt ?? ""))
      const fresh = Number.isFinite(createdMs) && Date.now() - createdMs < START_LOCK_STALE_MS
      if (fresh) {
        return {
          acquired: false,
          ...(typeof data.sessionId === "string" && data.sessionId
            ? { holderSessionId: data.sessionId }
            : {}),
        }
      }
      // Stale lock from a crashed start → take over.
      await lockRef.set({
        userId: args.userId,
        jobId: args.jobId,
        sessionId: args.sessionId,
        createdAt: args.nowIso,
        takenOverAt: args.nowIso,
      })
      return { acquired: true }
    } catch (readErr) {
      log("prescreen.start_lock_read_error_fail_open", {
        userId: args.userId,
        jobId: args.jobId,
        error: errorMessage(readErr),
      })
      return { acquired: true }
    }
  }
}

async function releasePrescreenStartLock(
  db: Firestore,
  args: { userId: string; jobId: string },
): Promise<void> {
  try {
    await db
      .collection(PRESCREEN_START_LOCK_COLLECTION)
      .doc(`${args.userId}_${args.jobId}`)
      .delete()
  } catch {
    /* best-effort — a leaked lock is reclaimed via START_LOCK_STALE_MS */
  }
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

function readPendingPrescreenStart(user: Record<string, unknown>): PendingPrescreenStart | null {
  const pending = user.pendingPrescreenStart
  if (!pending || typeof pending !== "object" || Array.isArray(pending)) return null
  return pending as PendingPrescreenStart
}

async function maybeHoldForProfileReadiness(args: {
  db: Firestore
  userId: string
  jobId: string
  toE164: string
  sourceRequestedUserId?: string
  allowMatchedBypass?: boolean
  suppressFirstQuestion?: boolean
  sessionId: string
  nowIso: string
  sendSms: RuntimeSmsSender
  log: (event: string, payload: Record<string, unknown>) => void
}): Promise<RunPreScreenResult | null> {
  if (!isClaireEntryUxCanary(args.userId)) return null
  if (args.suppressFirstQuestion) return null

  const userRef = args.db.collection("pa-users").doc(args.userId)
  const userSnap = await userRef.get()
  const user = (userSnap.exists ? userSnap.data() : {}) ?? {}
  if (!isEnrichmentInFlight(user)) return null

  // SAFE-FALLBACK CONTINUE (ENTRY-UX PRD §2.6.3) — the FIRST start attempt during an enrichment
  // window holds; a SECOND attempt for the SAME job while the hold is still waiting (a re-pasted
  // trigger token, a retried start) is the candidate explicitly choosing not to wait. The hold copy
  // advertises exactly this exit — honor it: resolve the pending start as a fallback-continue and
  // let THIS start proceed to Q1 instead of holding again (the old one-shot hold silently stranded
  // the candidate whenever the completion event was lost).
  const existingPending = readPendingPrescreenStart(user as Record<string, unknown>)
  if (
    existingPending &&
    existingPending.status === "waiting_profile" &&
    existingPending.jobId === args.jobId
  ) {
    await userRef.set(
      {
        pendingPrescreenStart: {
          ...existingPending,
          status: "fallback_continue",
          resolvedAt: args.nowIso,
          updatedAt: args.nowIso,
        },
        updatedAt: args.nowIso,
      },
      { merge: true },
    )
    args.log("prescreen.profile_readiness_hold_safe_fallback_continue", {
      userId: args.userId,
      jobId: args.jobId,
    })
    return null
  }

  const pendingStart = {
    status: "waiting_profile",
    reason: "enrichment_in_flight",
    userId: args.userId,
    jobId: args.jobId,
    toE164: args.toE164,
    sourceRequestedUserId: args.sourceRequestedUserId ?? null,
    allowMatchedBypass: args.allowMatchedBypass === true,
    createdAt: args.nowIso,
    updatedAt: args.nowIso,
  }

  await userRef.set(
    {
      pendingPrescreenStart: pendingStart,
      updatedAt: args.nowIso,
    },
    { merge: true },
  )

  try {
    await args.sendSms({
      to: args.toE164,
      content: PROFILE_READINESS_HOLD_COPY,
      userId: args.userId,
      db: args.db,
      runtimeSource: "pa_prescreen_runtime",
      idempotencyKey: `prescreen_profile_readiness_hold:${args.jobId}:${args.userId}`,
    })
  } catch (err) {
    await userRef.set(
      {
        pendingPrescreenStart: {
          ...pendingStart,
          status: "hold_send_failed",
          sendFailedAt: args.nowIso,
          sendFailedReason: errorMessage(err),
          updatedAt: args.nowIso,
        },
        updatedAt: args.nowIso,
      },
      { merge: true },
    )
    args.log("prescreen.profile_readiness_hold_send_failed", {
      userId: args.userId,
      jobId: args.jobId,
      error: errorMessage(err),
    })
    return { ok: false, reason: "send_failed", sessionId: args.sessionId, firstQuestionSent: false }
  }

  args.log("prescreen.profile_readiness_hold", { userId: args.userId, jobId: args.jobId })
  return { ok: false, reason: "readiness_hold", sessionId: args.sessionId, firstQuestionSent: false }
}

/**
 * Ask for a résumé/LinkedIn BEFORE running a strict screen on a candidate with no profile on file.
 * The public job page mints the start token AFTER a résumé upload, so reaching a strict screen with
 * ZERO profile is an anomaly (token-paste / phone-is-auth start that bypassed the upload gate — live
 * victim Khloë 2026-06-21). Screening blind → un-scorable rubric → fabricated HARD_STOP. Instead store
 * a waiting_profile pending start and ask for the résumé; cutover's resume continuation auto-starts the
 * screen WITH context once it lands. Fleet-wide (NOT canary-gated). Only fires for screens that have a
 * gating (MUST_HAVE/PROBING) question — lightweight intake-only screens don't need a résumé first.
 */
export const PROFILE_MISSING_HOLD_COPY =
  "before i run this screen i need a bit of background so i ask the right questions — share your résumé (or your LinkedIn URL) here and i'll start it with real context. (this keeps the screen fair instead of guessing.)"

async function maybeHoldForMissingProfile(args: {
  db: Firestore
  userId: string
  jobId: string
  toE164: string
  hasGatingQuestion: boolean
  suppressFirstQuestion?: boolean
  sessionId: string
  nowIso: string
  sendSms: RuntimeSmsSender
  log: (event: string, payload: Record<string, unknown>) => void
}): Promise<RunPreScreenResult | null> {
  if (args.suppressFirstQuestion) return null
  if (!args.hasGatingQuestion) return null

  const userRef = args.db.collection("pa-users").doc(args.userId)
  const userSnap = await userRef.get()
  const user = (userSnap.exists ? userSnap.data() : {}) ?? {}
  // Scope to the C-end candidate population (source:"candidate") — exactly who goes through the
  // public job page's résumé-upload gate, so a missing résumé here is the token-paste anomaly. Other
  // sources (recruiter upload, external LinkedIn supply) have their own intake + identity evidence.
  if (user.source !== "candidate") return null
  // Has a profile, or enrichment is actively running → proceed (the readiness hold / normal flow
  // covers the in-flight case; a present résumé is exactly what makes the screen scorable).
  if (hasResumeOrLinkedInProfileSignal(user)) return null
  if (isEnrichmentInFlight(user)) return null

  const pendingStart = {
    status: "waiting_profile",
    reason: "missing_profile",
    userId: args.userId,
    jobId: args.jobId,
    toE164: args.toE164,
    createdAt: args.nowIso,
    updatedAt: args.nowIso,
  }
  // Idempotent: if a missing-profile hold for this job is already pending, just stay held (do NOT
  // start blind on a re-paste — unlike the in-flight readiness hold, here we genuinely have no résumé).
  const existing = readPendingPrescreenStart(user as Record<string, unknown>)
  const alreadyWaiting =
    existing && existing.status === "waiting_profile" && existing.jobId === args.jobId
  if (!alreadyWaiting) {
    await userRef.set({ pendingPrescreenStart: pendingStart, updatedAt: args.nowIso }, { merge: true })
  }

  try {
    await args.sendSms({
      to: args.toE164,
      content: PROFILE_MISSING_HOLD_COPY,
      userId: args.userId,
      db: args.db,
      runtimeSource: "pa_prescreen_runtime",
      idempotencyKey: `prescreen_missing_profile_hold:${args.jobId}:${args.userId}`,
    })
  } catch (err) {
    args.log("prescreen.profile_missing_hold_send_failed", {
      userId: args.userId,
      jobId: args.jobId,
      error: errorMessage(err),
    })
    return { ok: false, reason: "send_failed", sessionId: args.sessionId, firstQuestionSent: false }
  }

  args.log("prescreen.profile_missing_hold", { userId: args.userId, jobId: args.jobId })
  return { ok: false, reason: "awaiting_profile", sessionId: args.sessionId, firstQuestionSent: false }
}

export async function resumePendingProfileReadinessPrescreenStart(args: {
  db: Firestore
  userId: string
  occurredAt?: string
  sendSms?: RuntimeSmsSender
  markStarted?: RunPreScreenArgs["markStarted"]
  log?: (event: string, payload: Record<string, unknown>) => void
}): Promise<{ attempted: boolean; result?: RunPreScreenResult; jobId?: string }> {
  const log = args.log ?? (() => {})
  const nowIso = args.occurredAt ?? new Date().toISOString()
  const userRef = args.db.collection("pa-users").doc(args.userId)
  const snap = await userRef.get()
  const user = (snap.exists ? snap.data() : {}) ?? {}
  const pending = readPendingPrescreenStart(user)
  if (!pending || pending.status !== "waiting_profile") return { attempted: false }

  const jobId = typeof pending.jobId === "string" ? pending.jobId : ""
  const toE164 = typeof pending.toE164 === "string" ? pending.toE164 : ""
  if (!jobId || !toE164) {
    await userRef.set(
      {
        pendingPrescreenStart: {
          ...pending,
          status: "start_failed",
          resultReason: "invalid_pending_start",
          resolvedAt: nowIso,
          updatedAt: nowIso,
        },
        updatedAt: nowIso,
      },
      { merge: true },
    )
    log("prescreen.pending_start_invalid", { userId: args.userId, jobId })
    return { attempted: true, jobId }
  }

  await userRef.set(
    {
      pendingPrescreenStart: {
        ...pending,
        status: "starting",
        resumedAt: nowIso,
        updatedAt: nowIso,
      },
      updatedAt: nowIso,
    },
    { merge: true },
  )

  const result = await runPreScreenForUser({
    db: args.db,
    userId: args.userId,
    jobId,
    toE164,
    ...(typeof pending.sourceRequestedUserId === "string" && pending.sourceRequestedUserId
      ? { sourceRequestedUserId: pending.sourceRequestedUserId }
      : {}),
    allowMatchedBypass: pending.allowMatchedBypass === true,
    skipProfileReadinessHold: true,
    ...(args.markStarted ? { markStarted: args.markStarted } : {}),
    ...(args.sendSms ? { sendSms: args.sendSms } : {}),
    log,
  })

  await userRef.set(
    {
      pendingPrescreenStart: {
        ...pending,
        status: result.ok ? "started" : "start_failed",
        resultReason: result.reason ?? null,
        sessionId: result.sessionId,
        firstQuestionSent: result.firstQuestionSent ?? null,
        resolvedAt: nowIso,
        updatedAt: nowIso,
      },
      updatedAt: nowIso,
    },
    { merge: true },
  )
  log("prescreen.pending_start_resolved", {
    userId: args.userId,
    jobId,
    ok: result.ok,
    reason: result.reason,
    sessionId: result.sessionId,
  })
  return { attempted: true, result, jobId }
}

/**
 * ENTRY-UX PRD §2.6.2 / §2.6.5 / §3 rule 6 — EVIDENCE-AWARE Q1.
 *
 * Before Q1, load the candidate's known evidence (the D8 single tag source: `pa-users.tags`,
 * written by résumé parse / LinkedIn-Coresignal merge / conversation extraction) and ADAPT the role
 * probe when evidence already exists: reference what Claire can already see (recent role @ company,
 * top skills) and ask for additions / corrections / fresher details instead of starting from zero.
 * A candidate with NO evidence on file gets the role's evidence probe directly (the §2.6.5 "if not"
 * branch — the unchanged template).
 *
 * DETERMINISTIC composition (PRD §3 rule 3 — process integrity stays deterministic): structured
 * field reads only, no LLM, no regex classification. Entry-UX-canary gated like the readiness hold;
 * fail-open — any read error degrades to the template opener so Q1 is never blocked on evidence.
 */
export const PRESCREEN_EVIDENCE_ADDITIONS_ASK =
  "Anything beyond what's already on your resume — fresh details, corrections, or additions — helps most."

function evidenceSkillNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const names: string[] = []
  for (const entry of raw) {
    const name =
      typeof entry === "string"
        ? entry
        : entry && typeof entry === "object" && typeof (entry as { name?: unknown }).name === "string"
          ? (entry as { name: string }).name
          : ""
    const trimmed = name.trim()
    if (trimmed) names.push(trimmed)
    if (names.length >= 3) break
  }
  return names
}

async function composePrescreenOpener(args: {
  db: Firestore
  userId: string
  company: string
  jobTitle: string
  firstQText: string
  log: (event: string, payload: Record<string, unknown>) => void
}): Promise<string> {
  const base = `Hi — Claire from ${args.company}. Quick screen for ${args.jobTitle}.`
  const fallback = `${base} ${args.firstQText}`
  if (!isClaireEntryUxCanary(args.userId)) return fallback
  try {
    const snap = await args.db.collection("pa-users").doc(args.userId).get()
    const user = (snap.exists ? snap.data() : {}) ?? {}
    const tags =
      user.tags && typeof user.tags === "object" && !Array.isArray(user.tags)
        ? (user.tags as Record<string, unknown>)
        : {}
    const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "")
    const role = str(tags.recentRoleTitle)
    const company = str(tags.recentCompany)
    const roleBit = role ? (company ? `${role} at ${company}` : role) : company
    const skills = evidenceSkillNames(tags.skills)
    const skillsBit = skills.length > 0 ? skills.join(", ") : ""
    const bits = [roleBit, skillsBit].filter(Boolean)
    if (bits.length === 0) return fallback
    const evidenceLine = `I've already been through your resume/profile — I can see ${bits.join(" and ")}, so we're not starting from zero.`
    args.log("prescreen.evidence_aware_opener", {
      userId: args.userId,
      hasRole: Boolean(roleBit),
      skillCount: skills.length,
    })
    return `${base} ${evidenceLine} ${args.firstQText} ${PRESCREEN_EVIDENCE_ADDITIONS_ASK}`
  } catch (err) {
    args.log("prescreen.evidence_opener_failed_open", {
      userId: args.userId,
      error: errorMessage(err),
    })
    return fallback
  }
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

  // 0.0 YC PEOPLE LANE (Adam-LOCKED 2026-07-24: "we don't wanna ask anything about the job") —
  // a YC Startup School person never enters a job prescreen. This is the SINGLE choke point every
  // prescreen start funnels through (copy-paste token trigger, broker trigger, agent tools, voice,
  // ATS pending trigger, Apply trigger, recovery sweep, cutover continuation), so one guard here
  // closes all of them — including the ATS pending-trigger path that REWRITES any inbound "hi"
  // into a job token, and the matched-gate bypass callers below.
  //
  // Runs FIRST, before the matched-gate, so `allowMatchedBypass` / `sourceRequestedUserId` cannot
  // route around it. Fail-OPEN on a read error: prescreen is the revenue path for ordinary
  // candidates and a Firestore blip must not block the whole fleet's interviews — the several
  // downstream YC guards still apply.
  try {
    const ycSnap = await args.db.collection("pa-users").doc(args.userId).get()
    if (isYcPeopleUser(ycSnap.data() ?? {})) {
      log("prescreen.yc_people_no_job_prescreen", { jobId: args.jobId, userId: args.userId })
      return { ok: false, reason: "yc_people_no_job_prescreen", sessionId }
    }
  } catch (err) {
    log("prescreen.yc_people_check_failed_open", {
      userId: args.userId,
      err: err instanceof Error ? err.message : String(err),
    })
  }

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

  // 0.5 RULE 2 (2026-06-11 incident) — NEVER restart a completed screen. A
  // session for this exact (userId, jobId) with a non-null terminal means the
  // candidate already finished (or the screen was terminally closed): return
  // the EXISTING session id and send NOTHING. Runs for EVERY caller — no
  // bypass (the live violation came through the recovery sweep, which sets
  // allowMatchedBypass=true). An ACTIVE (terminal null) session keeps the
  // existing supersede/new-work-session behavior unchanged.
  const completed = await findTerminalSessionForJob(args.db, args.userId, args.jobId, log)
  if (completed) {
    log("prescreen.already_completed", {
      jobId: args.jobId,
      userId: args.userId,
      sessionId: completed.id,
      terminal: completed.terminal,
    })
    return { ok: false, reason: "already_completed", sessionId: completed.id }
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

  if (!args.skipProfileReadinessHold) {
    const hold = await maybeHoldForProfileReadiness({
      db: args.db,
      userId: args.userId,
      jobId: args.jobId,
      toE164: args.toE164,
      ...(args.sourceRequestedUserId ? { sourceRequestedUserId: args.sourceRequestedUserId } : {}),
      allowMatchedBypass: args.allowMatchedBypass,
      suppressFirstQuestion: args.suppressFirstQuestion,
      sessionId,
      nowIso,
      sendSms,
      log,
    })
    if (hold) return hold

    // Khloë 2026-06-21 — a candidate with NO résumé/LinkedIn must not be run through a STRICT screen
    // blind (token-paste bypassed the public-page upload gate → un-scorable rubric → fabricated
    // HARD_STOP). Ask for the résumé first; the screen auto-starts once it lands.
    const hasGatingQuestion = cfg.questions.some(
      (q) => q.type === "MUST_HAVE" || q.type === "PROBING",
    )
    const missingProfileHold = await maybeHoldForMissingProfile({
      db: args.db,
      userId: args.userId,
      jobId: args.jobId,
      toE164: args.toE164,
      hasGatingQuestion,
      suppressFirstQuestion: args.suppressFirstQuestion,
      sessionId,
      nowIso,
      sendSms,
      log,
    })
    if (missingProfileHold) return missingProfileHold
  }

  // 1.5 RULE 2 race-closer (2026-06-11: one sweep run created THREE sessions
  // for the same user) — deterministic in-flight lock on (userId, jobId),
  // acquired right before the supersede+create block and released on
  // completion of the start. The second concurrent start gets a friendly
  // no-op instead of a duplicate session + duplicate Q1.
  const lock = await acquirePrescreenStartLock(
    args.db,
    { userId: args.userId, jobId: args.jobId, sessionId, nowIso },
    log,
  )
  if (!lock.acquired) {
    log("prescreen.start_in_progress", {
      jobId: args.jobId,
      userId: args.userId,
      holderSessionId: lock.holderSessionId ?? null,
    })
    return {
      ok: false,
      reason: "start_in_progress",
      sessionId: lock.holderSessionId ?? sessionId,
    }
  }
  try {
    // RULE 2 existence re-check INSIDE the lock, right before the create — a
    // concurrent start that won the race and already finished (terminal set)
    // must not be restarted by us.
    const completedInsideLock = await findTerminalSessionForJob(
      args.db,
      args.userId,
      args.jobId,
      log,
    )
    if (completedInsideLock) {
      log("prescreen.already_completed", {
        jobId: args.jobId,
        userId: args.userId,
        sessionId: completedInsideLock.id,
        terminal: completedInsideLock.terminal,
      })
      return { ok: false, reason: "already_completed", sessionId: completedInsideLock.id }
    }

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
  // DEFAULT AI-acceleration question (Adam directive) — append the role-tailored, NON-GATING
  // q_ai_acceleration LAST onto the legacy config (ask-once skip resolved here). The state build +
  // cfgSnapshot below BOTH read this augmented config, so the per-turn binding auto-asks it and the
  // FSM scores it with weight 0 (verdict unaffected). Q1 (firstQText) is untouched — append-only.
  const effectiveCfg = await withLegacyAiQuestion(args.db, args.userId, args.jobId, data ?? null, cfg, log)
  const firstQText = effectiveCfg.questions[0].prompt.en

  const state = emptyPreScreenState({
    sessionId,
    userId: args.userId,
    jobId: args.jobId,
    questions: configToStateQuestions(effectiveCfg),
    threshold: effectiveCfg.threshold,
    confidenceThreshold: effectiveCfg.confidenceThreshold,
    maxClarifyRounds: Math.max(effectiveCfg.maxClarifyRounds, MIN_PRESCREEN_PROBE_ROUNDS),
    nowIso,
  })
  // cold_prescreen_no_profile flag (live victims Khloë/Robert 2026-06-19): a
  // candidate with NO résumé/LinkedIn/skills on file token-pasted into a strict
  // MUST_HAVE screen is structurally hard to score → near-guaranteed HARD_STOP
  // that the operator should NOT read as a real reject. Flag the session so the
  // human-review record / auto-draft is marked low-confidence. Best-effort; a
  // read failure just leaves the flag off. (Does NOT change terminal routing —
  // the deeper "collect résumé before screening" flow is an Adam decision.)
  let lowConfidenceColdProfile = false
  try {
    const startUserSnap = await args.db.collection("pa-users").doc(args.userId).get()
    const startUser = (startUserSnap.data() ?? {}) as Record<string, unknown>
    lowConfidenceColdProfile = !hasResumeOrLinkedInProfileSignal(startUser)
  } catch {
    // default false — never block the start
  }
  await sessRef.set({
    ...state,
    cfgSnapshot: effectiveCfg, // snapshot of (augmented) config at session start
    ...(lowConfidenceColdProfile ? { lowConfidenceColdProfile: true } : {}),
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

  // 4. Send first question — evidence-aware when the candidate's profile already carries
  // resume/LinkedIn evidence (PRD §2.6.2/§2.6.5: reference the covering evidence + ask for
  // additions, never the zero-context template for a known candidate). Canary-gated + fail-open
  // inside the composer; non-canary / no-evidence users keep the exact legacy template.
  const opener = await composePrescreenOpener({
    db: args.db,
    userId: args.userId,
    company: cfg.company ?? "WeKruit",
    jobTitle: cfg.jobTitle,
    firstQText,
    log,
  })

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
  } finally {
    await releasePrescreenStartLock(args.db, { userId: args.userId, jobId: args.jobId })
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
