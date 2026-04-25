import assert from "node:assert/strict"
import test from "node:test"
import type { ChatMessage } from "@pa/core-types"
import { archiveMonth, buildArchivePath, toArchiveJsonLine } from "./archive.js"

const message: ChatMessage = {
  id: "m1",
  userId: "u1",
  sessionId: "s1",
  role: "user",
  body: "hello",
  createdAt: "2026-04-25T12:00:00.000Z",
  rawMeta: { eventId: "evt1", source: "pa_inbound_event" },
}

test("archive path uses user and yyyy-mm", () => {
  assert.equal(archiveMonth(message.createdAt), "2026-04")
  assert.equal(buildArchivePath({ userId: "u1", createdAt: message.createdAt }), "pa-archives/users/u1/2026-04/messages.jsonl")
})

test("archive JSONL includes audit fields and stable hash", () => {
  const line = toArchiveJsonLine(message, "2026-04-25T13:00:00.000Z")
  const parsed = JSON.parse(line) as { eventId: string; sha256: string; archivedAt: string }
  assert.equal(parsed.eventId, "evt1")
  assert.equal(parsed.archivedAt, "2026-04-25T13:00:00.000Z")
  assert.match(parsed.sha256, /^[a-f0-9]{64}$/)
  assert.equal(line.endsWith("\n"), true)
})
