/**
 * v2.2 — PrescreenTurnRecorder.
 *
 * Channel-agnostic writer for `pa-prescreen-sessions/{sessionId}/turns/` —
 * the dashboard-observability subcollection. SMS and voice both record
 * through this iface so dashboard sees both channels identically.
 *
 * Also exposes `markPostTerminalAck` — the SMS handler's
 * recent-terminal-guard one-shot ack flag.
 */
import type { Firestore } from "firebase-admin/firestore"

export type PrescreenTurnAction =
  | { kind: "clarify"; qId: string; kAfter: number }
  | { kind: "advance"; fromQId: string; toQId: string }
  | { kind: "terminal"; terminal: "PASS" | "FAIL" | "HARD_STOP" | "PAUSE"; reason: string }
  | { kind: "error"; reason: string }
  | { kind: "post_terminal_followup"; terminal: string; reason: string }

export interface PrescreenTurnScoredSnapshot {
  perKeyword: unknown
  aggregate: unknown
  abortHint?: unknown
}

export interface PrescreenTurnRecord {
  qId: string
  reply: string
  scored?: PrescreenTurnScoredSnapshot
  action: PrescreenTurnAction
  ts: string
}

export interface PrescreenTurnRecorder {
  record(sessionId: string, record: PrescreenTurnRecord): Promise<void>
  markPostTerminalAck(sessionId: string, nowIso: string): Promise<void>
}

/* ────────────────────────────────────────────────────────────────────────── */
/* In-memory impl                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

export class InMemoryTurnRecorder implements PrescreenTurnRecorder {
  private records = new Map<string, PrescreenTurnRecord[]>()
  private acks = new Map<string, string>()

  async record(sessionId: string, record: PrescreenTurnRecord): Promise<void> {
    const list = this.records.get(sessionId) ?? []
    list.push({ ...record })
    this.records.set(sessionId, list)
  }

  async markPostTerminalAck(sessionId: string, nowIso: string): Promise<void> {
    this.acks.set(sessionId, nowIso)
  }

  getRecords(sessionId: string): PrescreenTurnRecord[] {
    return [...(this.records.get(sessionId) ?? [])]
  }

  getAck(sessionId: string): string | undefined {
    return this.acks.get(sessionId)
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Firestore impl                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

export class FirestoreTurnRecorder implements PrescreenTurnRecorder {
  constructor(private readonly db: Firestore) {}

  async record(sessionId: string, record: PrescreenTurnRecord): Promise<void> {
    const payload: Record<string, unknown> = {
      qId: record.qId,
      reply: record.reply,
      action: record.action,
      ts: record.ts,
    }
    if (record.scored) {
      const scored: Record<string, unknown> = {
        perKeyword: record.scored.perKeyword,
        aggregate: record.scored.aggregate,
      }
      if (record.scored.abortHint !== undefined) scored.abortHint = record.scored.abortHint
      payload.scored = scored
    }
    await this.db
      .collection("pa-prescreen-sessions")
      .doc(sessionId)
      .collection("turns")
      .add(payload)
  }

  async markPostTerminalAck(sessionId: string, nowIso: string): Promise<void> {
    await this.db
      .collection("pa-prescreen-sessions")
      .doc(sessionId)
      .set({ postTerminalFollowupAckAt: nowIso, updatedAt: nowIso }, { merge: true })
  }
}
