import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { Message } from "@photon-ai/imessage-kit"
import { syncRetryableInbox } from "./inbox-sync.js"
import { openLocalQueue } from "./local-queue.js"

test("local inbox sync retries after Firestore failure and enqueues exactly once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pa-inbox-sync-"))
  const q = openLocalQueue(join(dir, "queue.sqlite"))
  const calls: string[] = []
  try {
    q.storeInboxMessage({
      rowId: 19308,
      id: "B1E98142-ROW-19308",
      participant: "admin1@wekruit.com",
      chatId: "iMessage;-;admin1@wekruit.com",
      text: "记住 我喜欢拿铁",
      isFromMe: false,
    } as Message)

    await syncRetryableInbox(q, async (row) => {
      calls.push(row.guid)
      throw new Error("Firestore unavailable")
    })
    assert.deepEqual(calls, ["B1E98142-ROW-19308"])
    assert.equal(q.listRetryableInbox()[0]!.status, "sync_failed")

    await syncRetryableInbox(q, async (row) => {
      calls.push(row.guid)
    })
    await syncRetryableInbox(q, async (row) => {
      calls.push(row.guid)
    })

    assert.deepEqual(calls, ["B1E98142-ROW-19308", "B1E98142-ROW-19308"])
    assert.equal(q.listRetryableInbox().length, 0)
  } finally {
    q.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
