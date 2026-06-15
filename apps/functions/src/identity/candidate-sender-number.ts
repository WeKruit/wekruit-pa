import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import {
  activeUserAccessibleNumbers,
  findSendbluePoolNumber,
  loadSendbluePool,
  selectLeastLoadedAssignmentNumber,
  sendblueGroupId,
  type AssignmentNumberStat,
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

/**
 * Balanced assignment for a NEW candidate: pick the least-loaded active public
 * number, by LIVE attached count (self-healing — no drift like the old
 * assignedNewUsers counter). The number is then sticky to the candidate's thread
 * (the early-return above). A number added later drains the historical skew toward
 * an even split. Returns null only when there is no candidate-facing number.
 */
async function selectAssignmentNumber(
  db: Firestore,
  pool: SendbluePoolConfig | null,
): Promise<string | null> {
  const candidates = activeUserAccessibleNumbers(pool)
  if (candidates.length === 0) return null
  const stats = await Promise.all(
    candidates.map(async (n): Promise<AssignmentNumberStat> => {
      let totalAttached = 0
      try {
        totalAttached = (
          await db.collection(PA_COLLECTIONS.users).where("senderNumber", "==", n.number).count().get()
        ).data().count
      } catch {
        totalAttached = 0
      }
      return { number: n.number, totalAttached }
    }),
  )
  return selectLeastLoadedAssignmentNumber(stats)
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
  const senderNumber = await selectAssignmentNumber(db, pool)
  // null = no active number, or every number is at its daily new-contact cap.
  // Honor the cap: do NOT assign (no number that day) rather than overflow.
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
