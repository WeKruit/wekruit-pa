/**
 * Durable poll cursor for the iMessage worker.
 *
 * Stored at `pa_worker_cursors/{workerId}` so an offline → online restart
 * resumes from the last persisted ROWID instead of jumping to the latest
 * row (which would silently drop messages received while offline).
 *
 * Idempotency: replay is safe because `handleDirectMessage` keys outbound
 * dedup on `imessage-in-${rowId}` (`appendMessage` collision merge +
 * `findMessageByIdempotencyKey("out-${k}")` early skip).
 *
 * Operator escape hatches:
 *   - `PA_IMESSAGE_POLL_FROM_ROW` env still wins (manual override).
 *   - `PA_IMESSAGE_CURSOR_DISABLED=1` falls back to legacy "latest only".
 *   - `PA_WORKER_ID` distinguishes multiple workers (default: "imessage-default").
 */
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"

export const DEFAULT_WORKER_ID = "imessage-default"

export function getWorkerId(): string {
  return process.env.PA_WORKER_ID?.trim() || DEFAULT_WORKER_ID
}

export function isCursorDisabled(): boolean {
  return process.env.PA_IMESSAGE_CURSOR_DISABLED === "1"
}

export type WorkerCursor = {
  workerId: string
  channel: "imessage"
  lastRowId: number
  updatedAt: string
}

export async function loadWorkerCursor(
  db: Firestore,
  workerId: string
): Promise<WorkerCursor | null> {
  try {
    const ref = db.collection(PA_COLLECTIONS.workerCursors).doc(workerId)
    const snap = await ref.get()
    if (!snap.exists) return null
    const data = snap.data() as Partial<WorkerCursor> | undefined
    const lastRowId =
      typeof data?.lastRowId === "number" && Number.isFinite(data.lastRowId)
        ? data.lastRowId
        : null
    if (lastRowId === null) return null
    return {
      workerId,
      channel: "imessage",
      lastRowId,
      updatedAt: data?.updatedAt ?? new Date(0).toISOString(),
    }
  } catch {
    return null
  }
}

export async function saveWorkerCursor(
  db: Firestore,
  workerId: string,
  rowId: number
): Promise<void> {
  if (!Number.isFinite(rowId) || rowId < 0) return
  const ref = db.collection(PA_COLLECTIONS.workerCursors).doc(workerId)
  await ref.set(
    {
      workerId,
      channel: "imessage",
      lastRowId: rowId,
      updatedAt: new Date().toISOString(),
    } satisfies WorkerCursor,
    { merge: true }
  )
}
