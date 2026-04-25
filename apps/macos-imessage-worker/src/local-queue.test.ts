import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { Message } from "@photon-ai/imessage-kit"
import { openLocalQueue } from "./local-queue.js"

function tempQueue() {
  const dir = mkdtempSync(join(tmpdir(), "pa-local-queue-"))
  const q = openLocalQueue(join(dir, "queue.sqlite"))
  return {
    q,
    cleanup: () => {
      q.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function msg(input: Partial<Message> = {}): Message {
  return {
    rowId: 19308,
    id: "B1E98142-ROW-19308",
    participant: "admin1@wekruit.com",
    chatId: "iMessage;-;admin1@wekruit.com",
    text: "  记住 我喜欢拿铁  ",
    isFromMe: false,
    ...input,
  } as Message
}

test("local inbox dedupes duplicate watcher/repair discoveries by guid", () => {
  const { q, cleanup } = tempQueue()
  try {
    q.storeInboxMessage(msg({ rowId: 19308 }), "2026-04-25T12:00:00.000Z")
    q.storeInboxMessage(msg({ rowId: 19309 }), "2026-04-25T12:01:00.000Z")

    const rows = q.listRetryableInbox()
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.guid, "B1E98142-ROW-19308")
    assert.equal(rows[0]!.rowId, 19309)
    assert.equal(rows[0]!.status, "stored_local")
  } finally {
    cleanup()
  }
})

test("Firestore sync failure remains retryable and success records enqueuedAt", () => {
  const { q, cleanup } = tempQueue()
  try {
    q.storeInboxMessage(msg(), "2026-04-25T12:00:00.000Z")
    q.markInboxSyncing(19308, "2026-04-25T12:00:01.000Z")
    q.markInboxSyncFailed(19308, "Firestore unavailable", "2026-04-25T12:00:02.000Z")

    let rows = q.listRetryableInbox()
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.status, "sync_failed")
    assert.equal(rows[0]!.attempts, 1)
    assert.equal(rows[0]!.lastError, "Firestore unavailable")

    q.markInboxSyncing(19308, "2026-04-25T12:00:03.000Z")
    q.markInboxEnqueued(19308, "2026-04-25T12:00:04.000Z", "imessage-B1E98142-ROW-19308")
    rows = q.listRetryableInbox()
    assert.equal(rows.length, 0)

    const enqueued = q.listEnqueuedInbox()
    assert.equal(enqueued[0]!.eventId, "imessage-B1E98142-ROW-19308")
    let stored = q.db.prepare("SELECT * FROM local_inbox WHERE rowId = ?").get(19308) as { status: string; enqueuedAt: string }
    assert.equal(stored.status, "enqueued_firestore")
    assert.equal(stored.enqueuedAt, "2026-04-25T12:00:04.000Z")

    q.markInboxProcessed(19308, "2026-04-25T12:00:05.000Z")
    stored = q.db.prepare("SELECT * FROM local_inbox WHERE rowId = ?").get(19308) as { status: string; enqueuedAt: string }
    assert.equal(stored.status, "processed")
  } finally {
    cleanup()
  }
})
