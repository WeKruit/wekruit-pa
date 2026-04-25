import { createHash } from "node:crypto"
import type { ChatMessage } from "@pa/core-types"

export type ArchivedMessageJson = {
  eventId?: string
  sessionId: string
  role: ChatMessage["role"]
  body: string
  createdAt: string
  source: string
  sha256: string
  archivedAt: string
}

export function archiveMonth(createdAt: string): string {
  const d = new Date(createdAt)
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid archive timestamp: ${createdAt}`)
  return d.toISOString().slice(0, 7)
}

export function buildArchivePath(input: { userId: string; createdAt: string }) {
  return `pa-archives/users/${input.userId}/${archiveMonth(input.createdAt)}/messages.jsonl`
}

export function toArchiveJsonLine(message: ChatMessage, archivedAt = new Date().toISOString()) {
  const eventId = typeof message.rawMeta?.eventId === "string" ? message.rawMeta.eventId : undefined
  const source = typeof message.rawMeta?.source === "string" ? message.rawMeta.source : "pa_messages"
  const sha256 = createHash("sha256")
    .update(`${message.sessionId}|${message.role}|${message.body}|${message.createdAt}`)
    .digest("hex")
  const row: ArchivedMessageJson = {
    ...(eventId ? { eventId } : {}),
    sessionId: message.sessionId,
    role: message.role,
    body: message.body,
    createdAt: message.createdAt,
    source,
    sha256,
    archivedAt,
  }
  return `${JSON.stringify(row)}\n`
}
