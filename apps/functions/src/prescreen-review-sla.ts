/**
 * prescreen-review-sla.ts — 2026-06-10 trust audit, fixes 9 + 10.
 *
 * Pure handler for the `paPrescreenReviewSlaDaily` scheduled CF (09:00 UTC):
 *
 *   (9) pendingReview SLA alarm — count pa-prescreen-sessions with
 *       terminalActionPendingReview==true older than 48h; log
 *       `pa.prescreen.review_sla_breach` with count + oldest age + per-job
 *       breakdown; Slack alert when the webhook is configured (fail-soft).
 *       READ-ONLY — never mutates sessions.
 *
 *   (10) Stalled-screen 24h nudge — CANARY-GATED (isPrescreenNudgeCanary,
 *       dev cohort only; deliberately NOT the ramped isCanaryUser): open
 *       sessions (terminal==null) idle >24h get ONE warm nudge, idempotent
 *       per session via enqueueOutbound's idempotencyKey
 *       `prescreen-nudge-<sessionId>` (doc id = hash(key) → a re-run can
 *       never double-send) + a best-effort `nudgeSentAt` stamp on the session.
 *
 * Deps-injected (db / now / alert / enqueue) so tests run against a fake db.
 */
import { onSchedule } from "firebase-functions/v2/scheduler"
import { logger } from "firebase-functions/v2"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { enqueueOutbound as defaultEnqueueOutbound } from "@pa/pa-broker"
import { postSlackAlert as defaultPostSlackAlert } from "./lib/slack-alert.js"
import { isPrescreenNudgeCanary } from "./claire-agent/canary.js"
import { generateAndStorePrescreenAutoDraft } from "./evaluation-attempts.js"
import { ANTHROPIC_API_KEY } from "./orchestrator-deps.js"
import { defineSecret } from "firebase-functions/params"

const SESSIONS = "pa-prescreen-sessions"
const USERS = "pa-users"

const PA_OPENAI_AGENT_API_KEY = defineSecret("PA_OPENAI_AGENT_API_KEY")

export const REVIEW_SLA_MS = 48 * 60 * 60 * 1000
export const STALLED_SCREEN_NUDGE_AFTER_MS = 24 * 60 * 60 * 1000
/** Backstop: draft for ANY pending-review session still missing a draft. Capped per run for cost. */
const AUTODRAFT_BACKSTOP_MAX = 25
const SCAN_LIMIT = 500
const NUDGE_SCAN_LIMIT = 200

export const PRESCREEN_NUDGE_COPY =
  "want to pick that screen back up? just reply here and we'll continue where we left off — no restart needed."

export type PrescreenReviewSlaDeps = {
  db: Firestore
  now?: () => Date
  log?: (event: string, payload?: Record<string, unknown>) => void
  postSlackAlert?: typeof defaultPostSlackAlert
  enqueueOutbound?: typeof defaultEnqueueOutbound
  /** Canary gate seam (tests). Default = isPrescreenNudgeCanary (dev cohort). */
  isNudgeCanary?: (userId: string) => boolean
  /** Backstop draft generator (tests inject a stub). Default = real LLM draft. */
  generateAutoDraft?: typeof generateAndStorePrescreenAutoDraft
}

export type PrescreenReviewSlaResult = {
  pendingReviewTotal: number
  slaBreached: number
  oldestAgeHours: number | null
  perJob: Record<string, number>
  nudgeCandidates: number
  nudgesSent: number
  nudgesSkippedCanary: number
  nudgesSkippedIdempotent: number
  /** Pending-review sessions that had no draft and got one this run (never sent). */
  backstopDrafted: number
  backstopDraftFailed: number
  errors: number
}

type SessionRow = { id: string; data: Record<string, unknown> }

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : ""
}

/** Best timestamp for "when did this session last move". */
function sessionStampMs(data: Record<string, unknown>): number {
  for (const key of ["terminalActionFiredAt", "updatedAt", "createdAt"] as const) {
    const t = Date.parse(str(data[key]))
    if (Number.isFinite(t)) return t
  }
  return NaN
}

async function querySessions(
  db: Firestore,
  field: string,
  value: unknown,
  limit: number,
): Promise<SessionRow[]> {
  const snap = await db.collection(SESSIONS).where(field, "==", value).limit(limit).get()
  return (snap.docs as Array<{ id: string; data: () => Record<string, unknown> | undefined }>).map(
    (d) => ({ id: d.id, data: (d.data() ?? {}) as Record<string, unknown> }),
  )
}

export async function paPrescreenReviewSlaHandler(
  deps: PrescreenReviewSlaDeps,
): Promise<PrescreenReviewSlaResult> {
  const log = deps.log ?? (() => {})
  const now = deps.now ?? (() => new Date())
  const nowMs = now().getTime()
  const alert = deps.postSlackAlert ?? defaultPostSlackAlert
  const enqueue = deps.enqueueOutbound ?? defaultEnqueueOutbound
  const isCanary = deps.isNudgeCanary ?? isPrescreenNudgeCanary

  const result: PrescreenReviewSlaResult = {
    pendingReviewTotal: 0,
    slaBreached: 0,
    oldestAgeHours: null,
    perJob: {},
    nudgeCandidates: 0,
    nudgesSent: 0,
    nudgesSkippedCanary: 0,
    nudgesSkippedIdempotent: 0,
    backstopDrafted: 0,
    backstopDraftFailed: 0,
    errors: 0,
  }

  // ── (9) pendingReview SLA alarm — READ-ONLY ──────────────────────────────
  try {
    const rows = await querySessions(deps.db, "terminalActionPendingReview", true, SCAN_LIMIT)
    result.pendingReviewTotal = rows.length
    let oldestMs: number | null = null
    for (const row of rows) {
      const stamp = sessionStampMs(row.data)
      if (!Number.isFinite(stamp)) continue
      const age = nowMs - stamp
      if (age <= REVIEW_SLA_MS) continue
      result.slaBreached++
      const jobId = str(row.data.jobId) || "(unknown-job)"
      result.perJob[jobId] = (result.perJob[jobId] ?? 0) + 1
      if (oldestMs === null || stamp < oldestMs) oldestMs = stamp
    }
    if (oldestMs !== null) {
      result.oldestAgeHours = Math.round(((nowMs - oldestMs) / 3_600_000) * 10) / 10
    }
    if (result.slaBreached > 0) {
      log("pa.prescreen.review_sla_breach", {
        severity: "ERROR",
        count: result.slaBreached,
        pendingReviewTotal: result.pendingReviewTotal,
        oldestAgeHours: result.oldestAgeHours,
        perJob: result.perJob,
      })
      try {
        await alert({
          level: "warn",
          title: "Prescreen review SLA breach",
          message:
            `${result.slaBreached} prescreen session(s) have been pendingReview for >48h ` +
            `(oldest ≈ ${result.oldestAgeHours}h). Candidates were told a human is reviewing.`,
          fields: Object.entries(result.perJob)
            .slice(0, 10)
            .map(([jobId, count]) => ({ name: jobId, value: String(count) })),
        })
      } catch {
        /* alert is never load-bearing */
      }
    } else {
      log("pa.prescreen.review_sla_ok", { pendingReviewTotal: result.pendingReviewTotal })
    }
  } catch (err) {
    result.errors++
    log("pa.prescreen.review_sla_query_failed", {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // ── (11) Auto-draft BACKSTOP — Adam 2026-06-14 ───────────────────────────
  // The inline finalization hook drafts at terminal; this backstop catches any
  // miss (inline LLM failure, legacy pre-feature sessions). For pending-review
  // sessions still missing review.autoDraft, generate + store the two-tier draft.
  // NEVER sends — a human still commits from the dashboard. Capped per run.
  try {
    const genDraft = deps.generateAutoDraft ?? generateAndStorePrescreenAutoDraft
    const rows = await querySessions(deps.db, "terminalActionPendingReview", true, SCAN_LIMIT)
    for (const row of rows) {
      if (result.backstopDrafted >= AUTODRAFT_BACKSTOP_MAX) break
      const data = row.data
      const review = (data.review ?? {}) as Record<string, unknown>
      if (review.autoDraft) continue // already has a draft (inline path or a prior run)
      const terminal =
        str(review.proposedTerminal) || str(data.terminal) || str(review.finalTerminal)
      if (terminal !== "PASS" && terminal !== "FAIL" && terminal !== "HARD_STOP") continue
      const candidateId = str(data.userId)
      const jobId = str(data.jobId)
      if (!candidateId || !jobId) continue
      try {
        const out = await genDraft({
          db: deps.db,
          sessionId: row.id,
          candidateId,
          jobId,
          attemptId: str(data.evaluationAttemptId) || str(review.evaluationAttemptId) || undefined,
          terminal,
          proposedTerminal: terminal,
          score: typeof data.score === "number" ? data.score : undefined,
          scoreMax: typeof data.scoreMax === "number" ? data.scoreMax : undefined,
          threshold: typeof data.threshold === "number" ? data.threshold : undefined,
          terminalReason: str(data.terminalReason) || undefined,
          now: now().toISOString(),
          // The screen happened at terminal time, not now (the sweep runs days later).
          screenDateIso: str(data.terminalActionFiredAt) || str(data.updatedAt) || undefined,
          log,
        })
        if (out.stored) result.backstopDrafted++
        else result.backstopDraftFailed++
      } catch (err) {
        result.backstopDraftFailed++
        log("pa.prescreen.autodraft_backstop_row_failed", {
          sessionId: row.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    if (result.backstopDrafted > 0 || result.backstopDraftFailed > 0) {
      log("pa.prescreen.autodraft_backstop", {
        drafted: result.backstopDrafted,
        failed: result.backstopDraftFailed,
      })
    }
  } catch (err) {
    result.errors++
    log("pa.prescreen.autodraft_backstop_failed", {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // ── (10) Stalled-screen 24h nudge — canary-gated, once per session ───────
  try {
    const rows = await querySessions(deps.db, "terminal", null, NUDGE_SCAN_LIMIT)
    for (const row of rows) {
      const data = row.data
      const stamp = sessionStampMs(data)
      if (!Number.isFinite(stamp) || nowMs - stamp <= STALLED_SCREEN_NUDGE_AFTER_MS) continue
      result.nudgeCandidates++
      // Belt-and-suspenders idempotency: skip sessions already stamped.
      if (str(data.nudgeSentAt)) {
        result.nudgesSkippedIdempotent++
        continue
      }
      const userId = str(data.userId)
      if (!userId || !isCanary(userId)) {
        result.nudgesSkippedCanary++
        continue
      }
      // Resolve the destination: session e164, falling back to the user doc.
      let toE164 = str(data.e164)
      if (!toE164) {
        try {
          const userSnap = await deps.db.collection(USERS).doc(userId).get()
          toE164 = str((userSnap.data() as Record<string, unknown> | undefined)?.phoneE164)
        } catch {
          toE164 = ""
        }
      }
      if (!toE164) {
        log("pa.prescreen.nudge_no_phone", { sessionId: row.id, userId })
        continue
      }
      try {
        // PRIMARY idempotency: enqueueOutbound's doc id = hash(idempotencyKey),
        // so a re-run (or a concurrent sweep) creates the SAME row → created:false.
        const enq = await enqueue(deps.db, {
          userId,
          toE164,
          body: PRESCREEN_NUDGE_COPY,
          idempotencyKey: `prescreen-nudge-${row.id}`,
          runtimeApproved: true,
          runtimeSource: "pa_prescreen_runtime",
        })
        if (enq.created) {
          result.nudgesSent++
          log("pa.prescreen.nudge_sent", { sessionId: row.id, userId, outboundId: enq.id })
        } else {
          result.nudgesSkippedIdempotent++
          log("pa.prescreen.nudge_already_sent", { sessionId: row.id, userId, outboundId: enq.id })
        }
        // Best-effort stamp so future sweeps skip without the enqueue round-trip.
        await deps.db
          .collection(SESSIONS)
          .doc(row.id)
          .set({ nudgeSentAt: now().toISOString() }, { merge: true })
          .catch(() => {})
      } catch (err) {
        result.errors++
        log("pa.prescreen.nudge_failed", {
          sessionId: row.id,
          userId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  } catch (err) {
    result.errors++
    log("pa.prescreen.nudge_query_failed", {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  return result
}

// ---------------------------------------------------------------------------
// Thin CF shim — pure logic above is deps-injected for tests.
// ---------------------------------------------------------------------------
export const paPrescreenReviewSlaDaily = onSchedule(
  {
    schedule: "0 9 * * *",
    timeZone: "UTC",
    memory: "512MiB",
    timeoutSeconds: 540,
    region: "us-central1",
    // PA_OPENAI_AGENT_API_KEY (+ Anthropic fallback) power the (11) auto-draft
    // backstop. Unset → the draft fails-open (no draft this run), sweep unaffected.
    secrets: ["PA_SLACK_ALERT_WEBHOOK", PA_OPENAI_AGENT_API_KEY, ANTHROPIC_API_KEY],
    retryCount: 0,
  },
  async () => {
    try {
      const k = PA_OPENAI_AGENT_API_KEY.value().trim()
      if (k) process.env.PA_OPENAI_AGENT_API_KEY = k
    } catch {
      /* unset → backstop draft fails open */
    }
    try {
      const a = ANTHROPIC_API_KEY.value().trim()
      if (a && a !== "__UNSET__") process.env.ANTHROPIC_API_KEY = a
    } catch {
      /* unset → no Anthropic fallback */
    }
    const result = await paPrescreenReviewSlaHandler({
      db: getFirestore(),
      log: (event, payload) => logger.info(`[prescreen-review-sla] ${event}`, payload ?? {}),
    })
    logger.info("[prescreen-review-sla] done", result)
  },
)
