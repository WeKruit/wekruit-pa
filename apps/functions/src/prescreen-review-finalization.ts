import type { Firestore } from "firebase-admin/firestore"
import {
  prescreenReviewPendingAckText,
  prescreenSessionToEvaluationAttempt,
  type PreScreenState,
} from "@pa/pa-orchestrator"
import { saveEvaluationAttempt } from "@pa/pa-persistence"
import { sendRuntimeApprovedIMessage } from "./runtime-approved-outbox.js"
import { writePrescreenMemoryUpdate } from "./prescreen-terminal-action.js"
import {
  markPrescreenReviewPending,
  type MarkPrescreenReviewPendingArgs,
} from "./prescreen-outcome-service.js"

export type PrescreenHumanReviewTerminal = "PASS" | "FAIL" | "HARD_STOP"

export type RuntimeSmsSender = (args: {
  to: string
  content: string
  userId?: string
  db?: Firestore
  runtimeSource?: string
  idempotencyKey?: string
}) => Promise<unknown>

type LogFn = (event: string, payload: Record<string, unknown>) => void

function readOutboundId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  if (typeof record.outboundId === "string" && record.outboundId.trim()) return record.outboundId
  if (typeof record.id === "string" && record.id.trim()) return record.id
  return undefined
}

export async function finalizePrescreenForHumanReview(args: {
  db: Firestore
  state: PreScreenState
  cfgSnapshot?: { questions?: unknown[]; threshold?: number; confidenceThreshold?: number }
  terminal: PrescreenHumanReviewTerminal
  toE164: string
  lang: "zh" | "en"
  sendSms?: RuntimeSmsSender
  markReviewPending?: (args: MarkPrescreenReviewPendingArgs) => Promise<unknown>
  log?: LogFn
}): Promise<{
  attemptId: string
  pendingAckText: string
  pendingAckOutboundId?: string
}> {
  const log = args.log ?? (() => {})
  const nowIso = args.state.updatedAt ?? new Date().toISOString()
  await writePrescreenMemoryUpdate({
    db: args.db,
    sessionId: args.state.sessionId,
    userId: args.state.userId,
    jobId: args.state.jobId,
    terminal: args.terminal,
    occurredAt: nowIso,
    log,
  })

  const attempt = prescreenSessionToEvaluationAttempt({
    state: args.state,
    cfgSnapshot: args.cfgSnapshot as Parameters<typeof prescreenSessionToEvaluationAttempt>[0]["cfgSnapshot"],
    terminal: args.terminal,
    nowIso,
    evaluator: { kind: "hybrid", promptVersion: "prescreen-keyword-set-v2-strict" },
  })
  await saveEvaluationAttempt(args.db, attempt)

  await (args.markReviewPending ?? markPrescreenReviewPending)({
    db: args.db,
    sessionId: args.state.sessionId,
    userId: args.state.userId,
    jobId: args.state.jobId,
    terminal: args.terminal,
    occurredAt: nowIso,
  })

  const pendingAckText = prescreenReviewPendingAckText(args.lang)
  const sendResult = await (args.sendSms ?? sendRuntimeApprovedIMessage)({
    to: args.toE164,
    content: pendingAckText,
    userId: args.state.userId,
    db: args.db,
    runtimeSource: "pa_prescreen_runtime",
    idempotencyKey: `prescreen_review_pending:${args.state.sessionId}`,
  })
  const pendingAckOutboundId = readOutboundId(sendResult)

  await args.db.collection("pa-prescreen-sessions").doc(args.state.sessionId).set(
    {
      evaluationAttemptId: attempt.attemptId,
      terminalActionPendingReview: true,
      review: {
        status: "pending",
        evaluationAttemptId: attempt.attemptId,
        proposedTerminal: args.terminal,
        pendingAt: nowIso,
        updatedAt: nowIso,
        ...(pendingAckOutboundId ? { pendingAckOutboundId } : {}),
      },
      updatedAt: nowIso,
    },
    { merge: true },
  )

  await args.db.collection("pa-users").doc(args.state.userId).set(
    {
      postMatchRetention: null,
      updatedAt: nowIso,
    },
    { merge: true },
  )

  log("prescreen.review_pending.created", {
    sessionId: args.state.sessionId,
    attemptId: attempt.attemptId,
    terminal: args.terminal,
    pendingAckOutboundId: pendingAckOutboundId ?? null,
  })

  return { attemptId: attempt.attemptId, pendingAckText, pendingAckOutboundId }
}
