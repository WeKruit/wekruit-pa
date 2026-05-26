import type { Firestore } from "firebase-admin/firestore"

export type BlockingPrescreenSessionReason =
  | "active_session"
  | "pending_review_for_job"
  | "recent_terminal_for_job"

export type BlockingPrescreenSession =
  | {
      blocked: true
      reason: BlockingPrescreenSessionReason
      sessionId: string
      jobId?: string
      terminal?: string | null
    }
  | { blocked: false }

export type BlockingPrescreenSessionOptions = {
  jobIds?: string[]
}

function readIsoMillis(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function normalizeJobIds(jobIds: string[] | undefined): Set<string> {
  const out = new Set<string>()
  for (const raw of jobIds ?? []) {
    const id = typeof raw === "string" ? raw.trim() : ""
    if (id) out.add(id)
  }
  return out
}

function isSameTargetJob(sessionJobId: unknown, targetJobIds: Set<string>): boolean {
  if (targetJobIds.size === 0) return true
  if (typeof sessionJobId !== "string" || !sessionJobId.trim()) return true
  return targetJobIds.has(sessionJobId.trim())
}

export async function findBlockingPrescreenSession(
  db: Firestore,
  userId: string,
  nowIso: string,
  options: BlockingPrescreenSessionOptions = {}
): Promise<BlockingPrescreenSession> {
  const recentCutoffMs = Date.parse(nowIso) - 14 * 24 * 60 * 60 * 1000
  const targetJobIds = normalizeJobIds(options.jobIds)
  try {
    const snap = await db
      .collection("pa-prescreen-sessions")
      .where("userId", "==", userId)
      .limit(20)
      .get()
    for (const doc of snap.docs) {
      const data = doc.data() as Record<string, unknown>
      const sessionId = typeof doc.id === "string" ? doc.id : ""
      const jobId = typeof data.jobId === "string" && data.jobId.trim() ? data.jobId.trim() : undefined
      const terminal = typeof data.terminal === "string" ? data.terminal : null
      const sameTargetJob = isSameTargetJob(jobId, targetJobIds)

      if (!terminal) {
        return {
          blocked: true,
          reason: "active_session",
          sessionId,
          ...(jobId ? { jobId } : {}),
          terminal,
        }
      }

      if (data.terminalActionPendingReview === true && sameTargetJob) {
        return {
          blocked: true,
          reason: "pending_review_for_job",
          sessionId,
          ...(jobId ? { jobId } : {}),
          terminal,
        }
      }

      if (
        sameTargetJob &&
        (terminal === "PASS" || terminal === "FAIL" || terminal === "HARD_STOP")
      ) {
        const updatedMs = readIsoMillis(data.updatedAt) ?? readIsoMillis(data.createdAt)
        if (updatedMs == null || updatedMs >= recentCutoffMs) {
          return {
            blocked: true,
            reason: "recent_terminal_for_job",
            sessionId,
            ...(jobId ? { jobId } : {}),
            terminal,
          }
        }
      }
    }
  } catch {
    return { blocked: false }
  }
  return { blocked: false }
}

export async function hasBlockingPrescreenSession(
  db: Firestore,
  userId: string,
  nowIso: string,
  options: BlockingPrescreenSessionOptions = {}
): Promise<boolean> {
  const block = await findBlockingPrescreenSession(db, userId, nowIso, options)
  return block.blocked
}
