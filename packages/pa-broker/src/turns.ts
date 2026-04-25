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
