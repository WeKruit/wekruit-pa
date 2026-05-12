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

  const state = new FirestorePiiState(args.db)
  const pipeline = createPiiConfirmPipeline({
    state,
    emit: async (text) => {
      try {
        await sendImessage({ to: args.toE164, content: text })
      } catch (err) {
        log("pii_confirm.emit_failed", { error: String(err) })
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
                source: "prescreen_pass",
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
          consentedAt,
          ts: consentedAt,
        })
        log("pii_confirm.collected", { userId: args.userId })
      },
    },
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
