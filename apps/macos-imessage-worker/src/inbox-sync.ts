import type { LocalInboxRow, LocalQueue } from "./local-queue.js"

export type InboxSyncQueue = Pick<
  LocalQueue,
  "listRetryableInbox" | "markInboxSyncing" | "markInboxEnqueued" | "markInboxSyncFailed"
>

export async function syncRetryableInbox(
  queue: InboxSyncQueue,
  syncOne: (row: LocalInboxRow) => Promise<string | void>,
  input?: { limit?: number; log?: (...args: unknown[]) => void }
): Promise<number> {
  const rows = queue.listRetryableInbox(input?.limit ?? 50)
  let enqueued = 0
  for (const row of rows) {
    queue.markInboxSyncing(row.rowId)
    try {
      const eventId = await syncOne(row)
      queue.markInboxEnqueued(row.rowId, undefined, typeof eventId === "string" ? eventId : undefined)
      enqueued += 1
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      queue.markInboxSyncFailed(row.rowId, error)
      input?.log?.("[local-inbox] sync failed", { rowId: row.rowId, guid: row.guid, error })
    }
  }
  return enqueued
}
