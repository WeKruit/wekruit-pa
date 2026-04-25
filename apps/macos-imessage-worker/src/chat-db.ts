import { homedir } from "node:os"
import { join } from "node:path"
import type { Message } from "@photon-ai/imessage-kit"
import { Database } from "./sqlite.js"

export type ChatDbMessageRow = {
  rowId: number
  guid: string
  text: string
  participant: string
}

export function defaultChatDbPath() {
  return join(homedir(), "Library/Messages/chat.db")
}

export function getLatestMessageRowId(chatDbPath = defaultChatDbPath()): number {
  const db = new Database(chatDbPath, { readonly: true, fileMustExist: true })
  try {
    const row = db.prepare("SELECT max(ROWID) AS maxRowId FROM message").get() as
      | { maxRowId?: number | bigint | null }
      | undefined
    const maxRowId = row?.maxRowId
    return typeof maxRowId === "bigint" ? Number(maxRowId) : maxRowId ?? 0
  } finally {
    db.close()
  }
}

export function getDirectMessagesAfterRowId(
  rowId: number,
  chatDbPath = defaultChatDbPath(),
  limit = 100
): Message[] {
  const db = new Database(chatDbPath, { readonly: true, fileMustExist: true })
  try {
    const rows = db
      .prepare(
        `
        SELECT
          message.ROWID AS rowId,
          message.guid AS guid,
          message.text AS text,
          handle.id AS participant
        FROM message
        LEFT JOIN handle ON message.handle_id = handle.ROWID
        WHERE message.ROWID > ?
          AND message.is_from_me = 0
          AND handle.id IS NOT NULL
          AND message.text IS NOT NULL
          AND (message.associated_message_type IS NULL OR message.associated_message_type = 0)
        ORDER BY message.ROWID ASC
        LIMIT ?
        `
      )
      .all(rowId, limit) as ChatDbMessageRow[]

    return rows.map((row) => ({
      rowId: row.rowId,
      id: row.guid,
      text: row.text,
      participant: row.participant,
      isFromMe: false,
      chatKind: "dm",
      chatId: `iMessage;-;${row.participant}`,
    })) as Message[]
  } finally {
    db.close()
  }
}
