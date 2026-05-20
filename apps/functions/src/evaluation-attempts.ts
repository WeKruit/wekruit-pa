import { HttpsError, onCall } from "firebase-functions/v2/https"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { z } from "zod"
import {
  EvaluationOutcomeSchema,
  HumanReviewStatusSchema,
  PA_COLLECTIONS,
  type EvaluationAttempt,
  type EvaluationOutcome,
} from "@pa/core-types"
import { getEvaluationAttempt, saveHumanReview } from "@pa/pa-persistence"
import { requireExternalSupplyAdmin } from "./external-supply/resolve-identity.js"
import { runPrescreenTerminalAction } from "./prescreen-terminal-action.js"

const ReviewEvaluationAttemptInputSchema = z.object({
  attemptId: z.string().min(1),
  status: HumanReviewStatusSchema,
  finalOutcome: EvaluationOutcomeSchema.optional(),
  note: z.string().max(2_000).optional(),
  correctionReason: z.string().max(2_000).optional(),
})

export type ReviewEvaluationAttemptInput = z.infer<typeof ReviewEvaluationAttemptInputSchema>

export interface ReviewEvaluationAttemptResult {
  ok: true
  attemptId: string
  status: ReviewEvaluationAttemptInput["status"]
  finalOutcome?: EvaluationOutcome
  correctionEventId?: string
  prescreenTerminalActionFired?: boolean
  externalEvaluationUpdated?: boolean
}

export interface ReviewEvaluationAttemptDeps {
  db: Firestore
  now?: () => string
  runTerminalAction?: typeof runPrescreenTerminalAction
}

type CallableAuth = Parameters<typeof requireExternalSupplyAdmin>[0]

export async function runReviewEvaluationAttempt(
  data: unknown,
  auth: CallableAuth,
  deps: ReviewEvaluationAttemptDeps,
): Promise<ReviewEvaluationAttemptResult> {
  const { uid } = requireExternalSupplyAdmin(auth)
  const input = ReviewEvaluationAttemptInputSchema.parse(data)
  const nowIso = deps.now?.() ?? new Date().toISOString()
  const attempt = await getEvaluationAttempt(deps.db, input.attemptId)
  if (!attempt) throw new HttpsError("not-found", `Evaluation attempt ${input.attemptId} not found.`)
  const finalOutcome = resolveFinalOutcome(input, attempt)

  const saved = await saveHumanReview(deps.db, {
    attemptId: attempt.attemptId,
    reviewer: uid,
    nowIso,
    correctionReason: input.correctionReason ?? `operator_${input.status}`,
    review: {
      status: input.status,
      finalOutcome,
      note: input.note,
    },
  })

  let prescreenTerminalActionFired = false
  let externalEvaluationUpdated = false

  if (input.status === "approved" || input.status === "overridden") {
    if (attempt.source === "prescreen" && attempt.purpose === "employment_prescreen") {
      prescreenTerminalActionFired = await commitPrescreenOutcome({
        db: deps.db,
        attempt: saved.attempt,
        finalOutcome,
        runTerminalAction: deps.runTerminalAction ?? runPrescreenTerminalAction,
      })
    }
    if (attempt.source === "external_supply") {
      externalEvaluationUpdated = await commitExternalSupplyProjection({
        db: deps.db,
        attempt: saved.attempt,
        finalOutcome,
        reviewer: uid,
        reviewedAt: nowIso,
        note: input.note,
      })
    }
  }

  return {
    ok: true,
    attemptId: attempt.attemptId,
    status: input.status,
    finalOutcome,
    correctionEventId: saved.correctionEvent?.eventId,
    prescreenTerminalActionFired,
    externalEvaluationUpdated,
  }
}

function resolveFinalOutcome(
  input: ReviewEvaluationAttemptInput,
  attempt: EvaluationAttempt,
): EvaluationOutcome | undefined {
  if (input.status === "approved") return input.finalOutcome ?? attempt.proposedOutcome
  if (input.status === "overridden") {
    if (!input.finalOutcome) {
      throw new HttpsError("invalid-argument", "finalOutcome is required when overriding an evaluation.")
    }
    return input.finalOutcome
  }
  return input.finalOutcome
}

async function commitPrescreenOutcome(args: {
  db: Firestore
  attempt: EvaluationAttempt
  finalOutcome?: EvaluationOutcome
  runTerminalAction: typeof runPrescreenTerminalAction
}): Promise<boolean> {
  const terminal = args.finalOutcome?.prescreenTerminal
  if (!terminal || !args.attempt.prescreenSessionId || !args.attempt.candidateId || !args.attempt.jobId) return false
  const snap = await args.db.collection("pa-prescreen-sessions").doc(args.attempt.prescreenSessionId).get()
  const data = snap.data() ?? {}
  const toE164 = typeof data.e164 === "string" ? data.e164 : ""
  if (!toE164) {
    throw new HttpsError("failed-precondition", `Prescreen session ${args.attempt.prescreenSessionId} has no e164.`)
  }
  await args.runTerminalAction({
    db: args.db,
    sessionId: args.attempt.prescreenSessionId,
    terminal,
    userId: args.attempt.candidateId,
    jobId: args.attempt.jobId,
    toE164,
    lang: "en",
  })
  await args.db.collection(PA_COLLECTIONS.evaluationAttempts).doc(args.attempt.attemptId).set(
    {
      downstreamCommit: {
        kind: "prescreen_terminal_action",
        terminal,
        committedAt: new Date().toISOString(),
      },
      updatedAt: new Date().toISOString(),
    },
    { merge: true },
  )
  return true
}

async function commitExternalSupplyProjection(args: {
  db: Firestore
  attempt: EvaluationAttempt
  finalOutcome?: EvaluationOutcome
  reviewer: string
  reviewedAt: string
  note?: string
}): Promise<boolean> {
  const finalTier = args.finalOutcome?.supplyTier
  if (!finalTier || !args.attempt.externalEvaluationId) return false
  await args.db
    .collection(PA_COLLECTIONS.candidateCompanyJobEvaluations)
    .doc(args.attempt.externalEvaluationId)
    .set(
      {
        reviewerDecision: {
          finalTier,
          reviewer: args.reviewer,
          reviewedAt: args.reviewedAt,
          ...(args.note ? { note: args.note } : {}),
        },
        updatedAt: args.reviewedAt,
      },
      { merge: true },
    )
  return true
}

export const paReviewEvaluationAttempt = onCall(
  { region: "us-central1", memory: "256MiB", timeoutSeconds: 60 },
  async (req): Promise<ReviewEvaluationAttemptResult> => {
    return runReviewEvaluationAttempt(req.data, req.auth, { db: getFirestore() })
  },
)
