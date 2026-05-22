import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import {
  findSendbluePoolNumber,
  loadSendbluePool,
  pickFromNumber,
  sendblueGroupId,
  type SendbluePoolConfig,
} from "../sendblue/pool.js"

export type CandidateSenderNumber = {
  senderNumber?: string
  senderGroupId?: string
}

type SendbluePoolLoader = (db: Firestore) => Promise<SendbluePoolConfig | null>

function cleanString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max) return undefined
  return trimmed
}

function groupIdForNumber(pool: SendbluePoolConfig | null, senderNumber: string): string {
  return sendblueGroupId(findSendbluePoolNumber(pool, senderNumber) ?? { number: senderNumber, status: "active" })
}

export async function assignCandidateSenderNumber(
  db: Firestore,
  candidateId: string,
  user: Record<string, unknown> | null,
  poolLoader: SendbluePoolLoader = loadSendbluePool
): Promise<CandidateSenderNumber> {
  const existingNumber = cleanString(user?.senderNumber, 32)
  const existingGroupId = cleanString(user?.senderGroupId, 160)
  if (existingNumber) {
    return {
      senderNumber: existingNumber,
      ...(existingGroupId ? { senderGroupId: existingGroupId } : {}),
    }
  }

  const pool = await poolLoader(db)
  const senderNumber = pickFromNumber(pool, candidateId, { requireNewUserCapacity: true })
  if (!senderNumber) return {}
  const senderGroupId = groupIdForNumber(pool, senderNumber)
  const nowIso = new Date().toISOString()
  await db.collection(PA_COLLECTIONS.users).doc(candidateId).set({
    senderNumber,
    senderGroupId,
    senderAssignedAt: nowIso,
    senderAssignedSource: "candidate_identity",
    updatedAt: nowIso,
  }, { merge: true })
  return { senderNumber, senderGroupId }
}
