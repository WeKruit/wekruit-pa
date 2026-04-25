import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { getDirectMessagesAfterRowId } from "./chat-db.js"
import { Database } from "./sqlite.js"

test("chat.db repair reader maps ROWID messages into iMessage DM payloads", () => {
  const dir = mkdtempSync(join(tmpdir(), "pa-chat-db-"))
  const path = join(dir, "chat.db")
  const db = new Database(path)
  try {
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT NOT NULL);
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY,
        guid TEXT NOT NULL,
        text TEXT,
        handle_id INTEGER,
        is_from_me INTEGER NOT NULL,
        associated_message_type INTEGER
      );
    `)
    db.prepare("INSERT INTO handle(ROWID, id) VALUES (1, ?)").run("admin1@wekruit.com")
    db.prepare(
      "INSERT INTO message(ROWID, guid, text, handle_id, is_from_me, associated_message_type) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(19308, "B1E98142-ROW-19308", "记住 我喜欢拿铁", 1, 0, 0)
    db.prepare(
      "INSERT INTO message(ROWID, guid, text, handle_id, is_from_me, associated_message_type) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(19309, "FROM-ME", "ignore", 1, 1, 0)
  } finally {
    db.close()
  }

  try {
    const rows = getDirectMessagesAfterRowId(19307, path)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.rowId, 19308)
    assert.equal(rows[0]!.id, "B1E98142-ROW-19308")
    assert.equal(rows[0]!.participant, "admin1@wekruit.com")
    assert.equal(rows[0]!.chatId, "iMessage;-;admin1@wekruit.com")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
