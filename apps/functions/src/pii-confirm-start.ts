/**
 * v1.9 Phase 85 — runPiiConfirmForUser.
 *
 * Bootstrap for the PiiConfirmPipeline (3-Q legal name / email / phone)
 * fired AFTER an Apply trigger resolves to a verified-PASS candidate.
 *
 * Reuses iter34 P1 OnboardingPipeline + PiiConfirmPipeline factory.
 * State lives in `pa-pii-confirm-state/{userId}` (separate from onboarding
 * state) so concurrent onboarding doesn't collide.
 *
 * Skip-if-present: caller (Apply trigger handler) MAY short-circuit before
 * this is called by checking pa-users.{uid}.contactPII.consentedAt. We also
 * check here defensively to avoid duplicate collection.
 */

import type { Firestore } from "firebase-admin/firestore"
import { FieldValue } from "firebase-admin/firestore"
import {
  createPiiConfirmPipeline,
  type PiiConfirmAnswers,
} from "@pa/pa-orchestrator"
import type {
  PipelineState,
  PipelineStateProvider,
} from "@pa/pa-orchestrator"
import { sendImessage } from "./sendblue/sendblue-client.js"

/** v1.9 — extended state stash for tracking what source the PII flow is for. */
const PII_META_COLL = "pa-pii-confirm-meta"

const PII_STATE_COLL = "pa-pii-confirm-state"

class FirestorePiiState implements PipelineStateProvider {
  constructor(private readonly db: Firestore) {}
  async load(userId: string): Promise<PipelineState> {
    const snap = await this.db.collection(PII_STATE_COLL).doc(userId).get()
    if (!snap.exists) {
      return {
        currentQId: null,
        collected: {},
        attempts: {},
        halted: null,
        lang: "en",
        completed: false,
      }
    }
    return snap.data() as PipelineState
  }
  async save(userId: string, state: PipelineState): Promise<void> {
    await this.db.collection(PII_STATE_COLL).doc(userId).set(state, { merge: false })
  }
}

export interface RunPiiConfirmStartArgs {
  db: Firestore
  userId: string
  toE164: string
  jobId: string
  sourceSessionId: string
  /** Frames PII ask copy: "pass" = employer share, "fail" = future matching. */
  source?: "pass" | "fail"
  /**
   * Optional callback fired AFTER PII is fully collected. Use to chain
   * generateJobRecs / other downstream actions per Adam's spec:
   * FAIL/HARD_STOP path = PII confirm + matching.
   */
  onComplete?: (args: { userId: string; toE164: string; jobId: string }) => Promise<void>
  log?: (event: string, payload: Record<string, unknown>) => void
}

export interface RunPiiConfirmStartResult {
  ok: boolean
  skipped: boolean
  reason?: string
}

/**
 * Entry from Apply trigger. Sends the first Q (legal name). Subsequent
 * replies flow through `runPiiConfirmTurnIfActive` (parallel to prescreen
 * turn handler).
 */
export async function runPiiConfirmForUser(
  args: RunPiiConfirmStartArgs
): Promise<RunPiiConfirmStartResult> {
  const log = args.log ?? (() => undefined)

  // Skip-if-present: PII already consented.
  const userSnap = await args.db.collection("pa-users").doc(args.userId).get()
  const existing = userSnap.data()?.contactPII as
    | { consentedAt?: string }
    | undefined
  if (existing?.consentedAt) {
    log("pii_confirm.skip_existing", {
      userId: args.userId,
      consentedAt: existing.consentedAt,
    })
    try {
      await sendImessage({
        to: args.toE164,
        content:
          "We already have your contact details on file — the employer will reach out directly.",
      })
    } catch (err) {
      log("pii_confirm.skip_send_failed", { error: String(err) })
    }
    return { ok: true, skipped: true, reason: "already_consented" }
  }

  // Stash meta so subsequent turn handler knows source + onComplete deps.
  await args.db.collection(PII_META_COLL).doc(args.userId).set({
    source: args.source ?? "pass",
    jobId: args.jobId,
    sourceSessionId: args.sourceSessionId,
    toE164: args.toE164,
    startedAt: new Date().toISOString(),
  })

  const pipeline = buildPipeline({
    db: args.db,
    userId: args.userId,
    toE164: args.toE164,
    jobId: args.jobId,
    sourceSessionId: args.sourceSessionId,
    source: args.source ?? "pass",
    onComplete: args.onComplete,
    log,
  })

  // Kick off — pipeline emits Q1 prompt
  const result = await pipeline.startTurn({
    userId: args.userId,
    turnId: `pii_start_${Date.now()}`,
    reply: "",
  })
  log("pii_confirm.started", {
    userId: args.userId,
    currentQId: result.currentQId,
    emitted: result.emitted?.slice(0, 80),
  })
  return { ok: true, skipped: false }
}

/** Build the pipeline with the right hooks for both start + turn handlers. */
function buildPipeline(args: {
  db: Firestore
  userId: string
  toE164: string
  jobId: string
  sourceSessionId: string
  source: "pass" | "fail"
  onComplete?: (args: { userId: string; toE164: string; jobId: string }) => Promise<void>
  log: (event: string, payload: Record<string, unknown>) => void
}) {
  const state = new FirestorePiiState(args.db)
  return createPiiConfirmPipeline({
    state,
    source: args.source,
    emit: async (text) => {
      try {
        await sendImessage({ to: args.toE164, content: text })
      } catch (err) {
        args.log("pii_confirm.emit_failed", { error: String(err) })
      }
    },
    hooks: {
      onAllCollected: async (answers: PiiConfirmAnswers) => {
        const consentedAt = new Date().toISOString()
        await args.db
          .collection("pa-users")
          .doc(args.userId)
          .set(
            {
              contactPII: {
                legalName: answers.legalName,
                email: answers.email,
                phone: answers.phone,
                consentedAt,
                source: args.source === "fail" ? "prescreen_fail_followup" : "prescreen_pass",
                sourceSessionId: args.sourceSessionId,
              },
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
          )
        await args.db.collection("pa-audit-events").add({
          kind: "pii_confirm.collected",
          userId: args.userId,
          jobId: args.jobId,
          sourceSessionId: args.sourceSessionId,
          source: args.source,
          consentedAt,
          ts: consentedAt,
        })
        args.log("pii_confirm.collected", { userId: args.userId, source: args.source })

        // Chain → generateJobRecs (matching) once PII collected.
        if (args.onComplete) {
          try {
            await args.onComplete({
              userId: args.userId,
              toE164: args.toE164,
              jobId: args.jobId,
            })
          } catch (err) {
            args.log("pii_confirm.onComplete_failed", { error: String(err) })
          }
        }
      },
    },
    log: args.log,
  })
}

/**
 * Handle inbound iMessage when user has active PII confirm pipeline.
 * Mirrors runPrescreenTurnIfActive but for PII state. Returns handled=false
 * when no active session (pipeline not started OR already completed).
 */
export interface RunPiiConfirmTurnArgs {
  db: Firestore
  userId: string
  toE164: string
  replyText: string
  log?: (event: string, payload: Record<string, unknown>) => void
}

export async function runPiiConfirmTurnIfActive(
  args: RunPiiConfirmTurnArgs
): Promise<{ handled: boolean; completed?: boolean }> {
  const log = args.log ?? (() => undefined)
  // Check if user has live PII session: state has currentQId != null AND
  // not yet completed.
  const stateSnap = await args.db
    .collection("pa-pii-confirm-state")
    .doc(args.userId)
    .get()
  if (!stateSnap.exists) return { handled: false }
  const stateData = stateSnap.data() as { currentQId?: string | null; completed?: boolean } | undefined
  if (!stateData || stateData.completed || !stateData.currentQId) {
    return { handled: false }
  }
  // Read meta to recover source + sourceSessionId + onComplete hook target.
  const metaSnap = await args.db.collection(PII_META_COLL).doc(args.userId).get()
  const meta = metaSnap.data() as
    | { source?: "pass" | "fail"; jobId?: string; sourceSessionId?: string; toE164?: string }
    | undefined
  if (!meta) return { handled: false }

  // Default onComplete fires generateJobRecs ("matching" link per Adam).
  const onComplete = async (a: { userId: string; toE164: string; jobId: string }) => {
    try {
      const { getFirestore } = await import("firebase-admin/firestore")
      const { queryMatchingJobsV16 } = await import("@pa/job-rec")
      const { sendImessage: send } = await import("@pa/job-rec")
      const db = getFirestore()
      const result = await queryMatchingJobsV16(
        { userId: a.userId, limit: 5 },
        { db, log: () => undefined }
      )
      if (!result.jobs || result.jobs.length === 0) {
        await sendImessage({
          to: a.toE164,
          content:
            "Thanks for the details — I'll text you when a stronger fit comes through.",
        })
        return
      }
      const lines: string[] = ["Here are roles I think fit better:"]
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
      await send(
        {
          userId: a.userId,
          content: lines.join("\n\n"),
          idempotencyKey: `${a.userId}-${new Date().toISOString().slice(0, 16)}-pii-postcollect`,
        },
        { db, log: () => undefined }
      )
    } catch (err) {
      log("pii_confirm.recs_chain_failed", { error: String(err) })
    }
  }

  const pipeline = buildPipeline({
    db: args.db,
    userId: args.userId,
    toE164: args.toE164,
    jobId: meta.jobId ?? "",
    sourceSessionId: meta.sourceSessionId ?? "",
    source: meta.source ?? "pass",
    onComplete,
    log,
  })

  const result = await pipeline.startTurn({
    userId: args.userId,
    turnId: `pii_turn_${Date.now()}`,
    reply: args.replyText,
  })
  log("pii_confirm.turn_handled", {
    userId: args.userId,
    completed: result.completed,
    currentQId: result.currentQId,
  })
  return { handled: true, completed: result.completed }
}
