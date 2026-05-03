import { randomUUID } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS, type AgentTurnStatus, type PaAgentTurn, type AgentTurnStep } from "@pa/core-types"

const TURNS = PA_COLLECTIONS.agentTurns

export function suggestedTurnId(inboundEventId: string): string {
  return `turn_${inboundEventId}`
}

export async function createAgentTurn(
  db: Firestore,
  input: {
    inboundEventId: string
    userId: string
    sessionId: string
    agentId: string
    idempotencyKey: string
  }
): Promise<PaAgentTurn> {
  // Invariant — Firestore rejects "undefined" for any field on the doc, so
  // catching the missing identifier *before* the write produces a clear
  // engineering error instead of an opaque Firestore validation crash. See
  // v1.5 Stream-D Bug 1: coalescer used to synthesize inbound events without
  // resolving sessionId, which surfaced here as
  //   "Cannot use \"undefined\" as a Firestore value (found in field \"sessionId\")".
  // Fail loud at the boundary so the upstream gap is fixed, not papered over.
  if (!input.userId) {
    throw new Error("createAgentTurn: userId is required (received undefined/empty)")
  }
  if (!input.sessionId) {
    throw new Error("createAgentTurn: sessionId is required (received undefined/empty)")
  }
  const id = suggestedTurnId(input.inboundEventId)
  const ref = db.collection(TURNS).doc(id)
  const now = new Date().toISOString()
  const turn: PaAgentTurn = {
    id,
    inboundEventId: input.inboundEventId,
    userId: input.userId,
    sessionId: input.sessionId,
    agentId: input.agentId,
    status: "pending",
    createdAt: now,
    idempotencyKey: input.idempotencyKey,
    attemptCount: 0,
    steps: [{ at: now, name: "turn_created" }],
  }
  try {
    await ref.create(turn)
  } catch (e: unknown) {
    const code = (e as { code?: number })?.code
    if (code === 6) {
      const snap = await ref.get()
      return { id, ...snap.data() } as PaAgentTurn
    }
    throw e
  }
  return turn
}

export async function updateAgentTurn(
  db: Firestore,
  turnId: string,
  patch: Partial<PaAgentTurn> & { appendStep?: AgentTurnStep }
) {
  const ref = db.collection(TURNS).doc(turnId)
  const { appendStep, ...rest } = patch
  await db.runTransaction(async (t) => {
    const snap = await t.get(ref)
    const now = new Date().toISOString()
    if (!snap.exists) return
    const cur = snap.data() as PaAgentTurn
    const steps = [...(cur.steps ?? [])]
    if (appendStep) steps.push(appendStep)
    t.update(ref, {
      ...rest,
      ...(appendStep ? { steps } : {}),
      updatedAt: now,
    } as Record<string, unknown>)
  })
}

export async function setTurnStatus(
  db: Firestore,
  turnId: string,
  status: AgentTurnStatus,
  extra?: { lastError?: string; deadLetterReason?: string }
) {
  const step: AgentTurnStep = {
    at: new Date().toISOString(),
    name: `status_${status}`,
    ...(extra ? { detail: extra } : {}),
  }
  await updateAgentTurn(db, turnId, {
    status,
    ...extra,
    appendStep: step,
  })
}

export async function getAgentTurn(db: Firestore, turnId: string): Promise<PaAgentTurn | null> {
  const s = await db.collection(TURNS).doc(turnId).get()
  if (!s.exists) return null
  return { id: s.id, ...s.data() } as PaAgentTurn
}

export function newCorrelationId() {
  return randomUUID()
}
