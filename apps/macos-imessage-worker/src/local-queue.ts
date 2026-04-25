import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { Message } from "@photon-ai/imessage-kit"
import { Database, type SqliteDatabase } from "./sqlite.js"

export type LocalInboxStatus =
  | "discovered"
  | "stored_local"
  | "syncing"
  | "sync_failed"
  | "enqueued_firestore"
  | "processed"

export type LocalInboxRow = {
  rowId: number
  guid: string
  participant: string
  chatId: string | null
  text: string
  eventId: string | null
  status: LocalInboxStatus
  attempts: number
  lastError: string | null
  firstSeenAt: string
  storedAt: string
  syncingAt: string | null
  enqueuedAt: string | null
  updatedAt: string
}

export type LocalQueue = {
  db: SqliteDatabase
  close(): void
  storeInboxMessage(msg: Message, nowIso?: string): LocalInboxRow | null
  listRetryableInbox(limit?: number): LocalInboxRow[]
  markInboxSyncing(rowId: number, nowIso?: string): void
  markInboxEnqueued(rowId: number, nowIso?: string, eventId?: string): void
  markInboxSyncFailed(rowId: number, error: string, nowIso?: string): void
  listEnqueuedInbox(limit?: number): LocalInboxRow[]
  markInboxProcessed(rowId: number, nowIso?: string): void
  getCursor(name: string): number | null
  setCursor(name: string, rowId: number, nowIso?: string): void
  recordOutboundClaim(input: { outboundId: string; userId?: string; toE164?: string; body?: string }, nowIso?: string): void
  recordOutboundSent(outboundId: string, nowIso?: string): void
  recordOutboundFailed(outboundId: string, error: string, nowIso?: string): void
}

export function defaultLocalQueuePath() {
  return join(homedir(), "Library/Application Support/WeKruit PA/local-queue.sqlite")
}

function now() {
  return new Date().toISOString()
}

function coerceRow(row: unknown): LocalInboxRow {
  const r = row as Record<string, unknown>
  return {
    rowId: Number(r.rowId),
    guid: String(r.guid),
    participant: String(r.participant),
    chatId: typeof r.chatId === "string" ? r.chatId : null,
    text: String(r.text),
    eventId: typeof r.eventId === "string" ? r.eventId : null,
    status: String(r.status) as LocalInboxStatus,
    attempts: Number(r.attempts ?? 0),
    lastError: typeof r.lastError === "string" ? r.lastError : null,
    firstSeenAt: String(r.firstSeenAt),
    storedAt: String(r.storedAt),
    syncingAt: typeof r.syncingAt === "string" ? r.syncingAt : null,
    enqueuedAt: typeof r.enqueuedAt === "string" ? r.enqueuedAt : null,
    updatedAt: String(r.updatedAt),
  }
}

export function openLocalQueue(path = process.env.PA_LOCAL_QUEUE_PATH || defaultLocalQueuePath()): LocalQueue {
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.pragma("journal_mode = WAL")
  db.pragma("synchronous = NORMAL")
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_inbox (
      rowId INTEGER PRIMARY KEY,
      guid TEXT NOT NULL UNIQUE,
      participant TEXT NOT NULL,
      chatId TEXT,
      text TEXT NOT NULL,
      eventId TEXT,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      lastError TEXT,
      firstSeenAt TEXT NOT NULL,
      storedAt TEXT NOT NULL,
      syncingAt TEXT,
      enqueuedAt TEXT,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_local_inbox_status_row ON local_inbox(status, rowId);

    CREATE TABLE IF NOT EXISTS local_outbox (
      outboundId TEXT PRIMARY KEY,
      userId TEXT,
      toE164 TEXT,
      body TEXT,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      lastError TEXT,
      claimedAt TEXT,
      sentAt TEXT,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS local_cursors (
      name TEXT PRIMARY KEY,
      rowId INTEGER NOT NULL,
      updatedAt TEXT NOT NULL
    );
  `)
  const inboxColumns = new Set(
    (db.prepare("PRAGMA table_info(local_inbox)").all() as Array<{ name: string }>).map((row) => row.name)
  )
  if (!inboxColumns.has("eventId")) {
    db.exec("ALTER TABLE local_inbox ADD COLUMN eventId TEXT")
  }

  return {
    db,
    close() {
      db.close()
    },
    storeInboxMessage(msg, nowIso = now()) {
      if (msg.isFromMe) return null
      const participant = msg.participant?.trim()
      const text = msg.text?.trim()
      const guid = String(msg.id || msg.rowId || "").trim()
      if (!participant || !text || !guid) return null
      db.prepare(
        `
        INSERT INTO local_inbox (
          rowId, guid, participant, chatId, text, eventId, status, attempts,
          lastError, firstSeenAt, storedAt, syncingAt, enqueuedAt, updatedAt
        )
        VALUES (?, ?, ?, ?, ?, NULL, 'stored_local', 0, NULL, ?, ?, NULL, NULL, ?)
        ON CONFLICT(guid) DO UPDATE SET
          rowId = excluded.rowId,
          participant = excluded.participant,
          chatId = COALESCE(excluded.chatId, local_inbox.chatId),
          text = excluded.text,
          updatedAt = excluded.updatedAt
        `
      ).run(
        msg.rowId,
        guid,
        participant,
        msg.chatId ?? `iMessage;-;${participant}`,
        text,
        nowIso,
        nowIso,
        nowIso
      )
      return coerceRow(db.prepare("SELECT * FROM local_inbox WHERE guid = ?").get(guid))
    },
    listRetryableInbox(limit = 50) {
      return db
        .prepare(
          `
          SELECT * FROM local_inbox
          WHERE status IN ('stored_local', 'sync_failed')
          ORDER BY rowId ASC
          LIMIT ?
          `
        )
        .all(limit)
        .map(coerceRow)
    },
    markInboxSyncing(rowId, nowIso = now()) {
      db.prepare(
        `
        UPDATE local_inbox
        SET status = 'syncing', attempts = attempts + 1, syncingAt = ?, updatedAt = ?
        WHERE rowId = ? AND status IN ('stored_local', 'sync_failed')
        `
      ).run(nowIso, nowIso, rowId)
    },
    markInboxEnqueued(rowId, nowIso = now(), eventId) {
      db.prepare(
        `
        UPDATE local_inbox
        SET status = 'enqueued_firestore', eventId = COALESCE(?, eventId), enqueuedAt = ?, lastError = NULL, updatedAt = ?
        WHERE rowId = ?
        `
      ).run(eventId ?? null, nowIso, nowIso, rowId)
    },
    markInboxSyncFailed(rowId, error, nowIso = now()) {
      db.prepare(
        `
        UPDATE local_inbox
        SET status = 'sync_failed', lastError = ?, updatedAt = ?
        WHERE rowId = ?
        `
      ).run(error.slice(0, 1000), nowIso, rowId)
    },
    listEnqueuedInbox(limit = 50) {
      return db
        .prepare(
          `
          SELECT * FROM local_inbox
          WHERE status = 'enqueued_firestore' AND eventId IS NOT NULL
          ORDER BY rowId ASC
          LIMIT ?
          `
        )
        .all(limit)
        .map(coerceRow)
    },
    markInboxProcessed(rowId, nowIso = now()) {
      db.prepare(
        `
        UPDATE local_inbox
        SET status = 'processed', updatedAt = ?
        WHERE rowId = ? AND status = 'enqueued_firestore'
        `
      ).run(nowIso, rowId)
    },
    getCursor(name) {
      const row = db.prepare("SELECT rowId FROM local_cursors WHERE name = ?").get(name) as
        | { rowId?: number | bigint }
        | undefined
      if (!row) return null
      return typeof row.rowId === "bigint" ? Number(row.rowId) : row.rowId ?? null
    },
    setCursor(name, rowId, nowIso = now()) {
      db.prepare(
        `
        INSERT INTO local_cursors(name, rowId, updatedAt)
        VALUES (?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET rowId = excluded.rowId, updatedAt = excluded.updatedAt
        `
      ).run(name, rowId, nowIso)
    },
    recordOutboundClaim(input, nowIso = now()) {
      db.prepare(
        `
        INSERT INTO local_outbox(outboundId, userId, toE164, body, status, attempts, lastError, claimedAt, sentAt, updatedAt)
        VALUES (?, ?, ?, ?, 'sending', 1, NULL, ?, NULL, ?)
        ON CONFLICT(outboundId) DO UPDATE SET
          userId = excluded.userId,
          toE164 = excluded.toE164,
          body = excluded.body,
          status = 'sending',
          attempts = local_outbox.attempts + 1,
          lastError = NULL,
          claimedAt = excluded.claimedAt,
          updatedAt = excluded.updatedAt
        `
      ).run(input.outboundId, input.userId ?? null, input.toE164 ?? null, input.body ?? null, nowIso, nowIso)
    },
    recordOutboundSent(outboundId, nowIso = now()) {
      db.prepare(
        `
        INSERT INTO local_outbox(outboundId, status, attempts, sentAt, updatedAt)
        VALUES (?, 'sent', 0, ?, ?)
        ON CONFLICT(outboundId) DO UPDATE SET status = 'sent', sentAt = excluded.sentAt, updatedAt = excluded.updatedAt
        `
      ).run(outboundId, nowIso, nowIso)
    },
    recordOutboundFailed(outboundId, error, nowIso = now()) {
      db.prepare(
        `
        INSERT INTO local_outbox(outboundId, status, attempts, lastError, updatedAt)
        VALUES (?, 'failed', 0, ?, ?)
        ON CONFLICT(outboundId) DO UPDATE SET status = 'failed', lastError = excluded.lastError, updatedAt = excluded.updatedAt
        `
      ).run(outboundId, error.slice(0, 1000), nowIso)
    },
  }
}
