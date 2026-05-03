/**
 * Firestore buffer for v1.5 Stream-D message coalescer.
 *
 * Collection: `pa-message-coalesce-buffer`. One doc per (userId, turnSeq).
 * docId = `${userId}__${turnSeq}` (double-underscore to disambiguate userIds
 * that contain "_" — the rest of the codebase keys pa-users by phoneE164 or
 * randomUUID, neither of which uses "__").
 *
 * Doc shape (BufferDoc):
 *   {
 *     userId: string,
 *     turnSeq: number,        // monotonic per user
 *     pendingTaskName: string | null,  // current Cloud Tasks task; null when fired
 *     lastMessageId: string,  // sendblue message_handle of the LAST received msg (tap-back target)
 *     accumulatedBody: string,  // newline-joined bodies, oldest first
 *     firstReceivedAt: ISO,
 *     lastReceivedAt: ISO,
 *     messageCount: number,
 *     status: "pending" | "fired",
 *     channel: "imessage_sendblue",
 *     fromNumber: string,     // resolved sender phone (E.164)
 *     toNumber: string,       // recipient (Claire's number)
 *     inboundEventIds: string[],  // pa-inbound-events docIds bundled into this turn
 *   }
 *
 * Transactional semantics:
 *   - `coalesceTransaction()` is the ONLY write path. It runs in a single
 *     `runTransaction` so concurrent inbound webhooks for the same user
 *     serialize cleanly.
 *   - Fire path uses `markFiredTransaction()` to flip status atomically and
 *     return the snapshot for processing. Re-entrant fires return null.
 *
 * Why per-turn doc and not per-message:
 *   - Cancel-and-re-enqueue requires a single source of truth for the
 *     "pending task name" — multiple message rows would race.
 *   - Firestore transaction reads are bounded (1 doc), keeping latency low.
 *
 * Why turnSeq lives on `pa-users.coalesceTurnSeq` (not on the buffer doc):
 *   - When a turn fires, we need the NEXT turn for the same user to start
 *     fresh. Reading the user doc inside the same transaction gives a
 *     monotonic counter without scanning buffer history.
 */

import type {
  Firestore,
  Transaction,
  DocumentReference,
  DocumentSnapshot,
} from "firebase-admin/firestore"

export const COALESCE_BUFFER_COLLECTION = "pa-message-coalesce-buffer"
export const COALESCE_USER_FIELD = "coalesceTurnSeq"

/** Soft cap: force-fire (delay=0) when a turn accumulates more than this many messages. */
export const FORCE_FIRE_MESSAGE_COUNT = 5
/** Hard cap: total wait from firstReceivedAt before force-fire, regardless of cancel/re-enqueue. */
export const HARD_CAP_MS = 12_000
/** Default coalesce delay window.
 *  Bug 4 (2026-05-03): bumped 4s→8s — Adam实测 4 msg in 12s 触发 wave-split 3 turns;
 *  人类打字间隔常 >4s, 8s 在 HARD_CAP_MS=12s 内还有 4s 缓冲. */
export const DEFAULT_DELAY_MS = 8_000

/**
 * Event-driven coalesce — Adam 顶层设计 (2026-05-03):
 *
 * Sendblue's `typing_indicator` inbound webhook gives us a real-time signal
 * that the user is still composing. We use it to BUMP the active buffer's
 * fire deadline before each natural-typing-gap > DEFAULT_DELAY_MS would
 * otherwise wave-split the conversation.
 *
 * Two values:
 *   - TYPING_BUMP_DELAY_MS = 8_000 — equal to DEFAULT_DELAY_MS so a typing
 *     start fully resets the window (intuitive: "keep waiting, user is still
 *     typing").
 *   - TYPING_STOPPED_TAIL_MS = 2_000 — when typing transitions to STOPPED,
 *     fire after a short tail so we don't reply DURING the user's send. The
 *     2s tail tolerates the lag between "fingers off keys" and "tap send".
 *
 * HARD_CAP_MS still applies. A bump can only EXTEND firesAt up to
 * `firstReceivedAt + HARD_CAP_MS`. Adversarial typing that never stops cannot
 * keep a turn pending forever.
 */
export const TYPING_BUMP_DELAY_MS = 8_000
export const TYPING_STOPPED_TAIL_MS = 2_000

export type BufferDoc = {
  userId: string
  turnSeq: number
  pendingTaskName: string | null
  lastMessageId: string
  firstMessageId: string
  accumulatedBody: string
  firstReceivedAt: string
  lastReceivedAt: string
  messageCount: number
  status: "pending" | "fired"
  channel: string
  fromNumber: string
  toNumber: string
  inboundEventIds: string[]
}

export type IncomingMessage = {
  userId: string
  fromNumber: string
  toNumber: string
  messageHandle: string
  body: string
  inboundEventId: string
  /** ISO; defaults to now() if omitted (tests inject deterministic clocks). */
  receivedAt?: string
}

export type CoalesceOutcome = {
  /**
   * "created"  — first message of a turn; caller must enqueue task.
   * "appended" — buffer existed; caller cancels prior task, then enqueues new one.
   * "force-fire" — buffer hit soft/hard cap; caller enqueues with delay=0.
   */
  action: "created" | "appended" | "force-fire"
  /** Final BufferDoc after the transaction (with any new fields applied). */
  buffer: BufferDoc
  /** Cloud Tasks task name to cancel (when action=appended); null when none. */
  cancelTaskName: string | null
  /** Recommended delay for the new task. Caller passes to Cloud Tasks. */
  recommendedDelayMs: number
  /** Stable task name to use for the new enqueue. */
  nextTaskName: string
}

function bufferDocId(userId: string, turnSeq: number): string {
  return `${userId}__${turnSeq}`
}

function nowIso(now: () => Date): string {
  return now().toISOString()
}

/**
 * Run the coalesce transaction for an inbound message. Side-effect free
 * w.r.t. Cloud Tasks — caller does the actual enqueue/cancel based on the
 * returned outcome. This keeps the transaction tight (no I/O suspension).
 */
export async function coalesceTransaction(
  db: Firestore,
  msg: IncomingMessage,
  opts: {
    /** Test injection point. */
    now?: () => Date
    /** Override default 4s window (tests). */
    defaultDelayMs?: number
    /** Override 12s hard cap (tests). */
    hardCapMs?: number
    /** Override 5-msg soft cap (tests). */
    forceFireCount?: number
    /** Stable short-name builder; default uses ${userId}-${turnSeq}-${count}. */
    taskNameFn?: (userId: string, turnSeq: number, messageCount: number) => string
  } = {}
): Promise<CoalesceOutcome> {
  const now = opts.now ?? (() => new Date())
  const defaultDelay = opts.defaultDelayMs ?? DEFAULT_DELAY_MS
  const hardCap = opts.hardCapMs ?? HARD_CAP_MS
  const forceFireCount = opts.forceFireCount ?? FORCE_FIRE_MESSAGE_COUNT
  const taskNameFn =
    opts.taskNameFn ?? ((u, t, c) => `pa-coalesce-${sanitizeTaskComponent(u)}-${t}-${c}`)

  const userRef = db.collection("pa-users").doc(msg.userId)

  return db.runTransaction(async (tx) => {
    // 1. Read user doc → current turnSeq counter.
    const userSnap = await tx.get(userRef)
    const userData = (userSnap.exists ? userSnap.data() : {}) as Record<string, unknown>
    let turnSeq = Number(userData[COALESCE_USER_FIELD] ?? 0)
    // First-ever turn for this user → bump to 1 lazily.
    if (turnSeq === 0) turnSeq = 1

    const bufferRef = db.collection(COALESCE_BUFFER_COLLECTION).doc(
      bufferDocId(msg.userId, turnSeq)
    )
    const bufferSnap = (await tx.get(bufferRef)) as DocumentSnapshot

    const receivedAt = msg.receivedAt ?? nowIso(now)

    // ---- Branch A: no existing buffer (or previous turn already fired) ----
    if (!bufferSnap.exists || (bufferSnap.data() as BufferDoc | undefined)?.status === "fired") {
      // If the doc exists with status=fired (rare race), allocate a new turn.
      if (bufferSnap.exists) {
        turnSeq += 1
      }
      const nextTaskName = taskNameFn(msg.userId, turnSeq, 1)
      const newBuf: BufferDoc = {
        userId: msg.userId,
        turnSeq,
        pendingTaskName: nextTaskName,
        lastMessageId: msg.messageHandle,
        firstMessageId: msg.messageHandle,
        accumulatedBody: msg.body,
        firstReceivedAt: receivedAt,
        lastReceivedAt: receivedAt,
        messageCount: 1,
        status: "pending",
        channel: "imessage_sendblue",
        fromNumber: msg.fromNumber,
        toNumber: msg.toNumber,
        inboundEventIds: [msg.inboundEventId],
      }
      const newRef = db.collection(COALESCE_BUFFER_COLLECTION).doc(
        bufferDocId(msg.userId, turnSeq)
      )
      tx.set(newRef, newBuf)
      // Persist the bumped counter ONLY if we incremented above (race branch).
      if (turnSeq !== Number(userData[COALESCE_USER_FIELD] ?? 0)) {
        tx.set(userRef, { [COALESCE_USER_FIELD]: turnSeq }, { merge: true })
      } else if (!userSnap.exists || userData[COALESCE_USER_FIELD] === undefined) {
        // Initialize counter on first-ever turn.
        tx.set(userRef, { [COALESCE_USER_FIELD]: turnSeq }, { merge: true })
      }
      return {
        action: "created",
        buffer: newBuf,
        cancelTaskName: null,
        recommendedDelayMs: defaultDelay,
        nextTaskName,
      }
    }

    // ---- Branch B: existing pending buffer → append + cancel/re-enqueue ----
    const existing = bufferSnap.data() as BufferDoc
    const newCount = existing.messageCount + 1
    const nextTaskName = taskNameFn(msg.userId, existing.turnSeq, newCount)

    // Hard cap: time elapsed since firstReceivedAt
    const firstAtMs = Date.parse(existing.firstReceivedAt)
    const nowMs = now().getTime()
    const elapsedMs = Number.isFinite(firstAtMs) ? nowMs - firstAtMs : 0
    const remainingMs = Math.max(0, hardCap - elapsedMs)
    const isHardCapped = remainingMs === 0
    const isSoftCapped = newCount > forceFireCount

    // Recommended delay: min(default, remaining), force-fire ⇒ 0
    let recommendedDelayMs: number
    let action: "appended" | "force-fire"
    if (isHardCapped || isSoftCapped) {
      recommendedDelayMs = 0
      action = "force-fire"
    } else {
      recommendedDelayMs = Math.min(defaultDelay, remainingMs)
      action = "appended"
    }

    const updated: BufferDoc = {
      ...existing,
      pendingTaskName: nextTaskName,
      lastMessageId: msg.messageHandle,
      accumulatedBody: `${existing.accumulatedBody}\n${msg.body}`,
      lastReceivedAt: receivedAt,
      messageCount: newCount,
      inboundEventIds: [...existing.inboundEventIds, msg.inboundEventId],
    }
    tx.set(bufferRef, updated)

    return {
      action,
      buffer: updated,
      cancelTaskName: existing.pendingTaskName,
      recommendedDelayMs,
      nextTaskName,
    }
  })
}

/**
 * Atomically flip status pending→fired. Returns the buffer snapshot when
 * the flip happened, `null` when the doc was already fired (re-entrant
 * Cloud Tasks delivery — silently dedupe). Also bumps the user's turnSeq
 * so the next inbound message starts a fresh turn.
 */
export async function markFiredTransaction(
  db: Firestore,
  userId: string,
  turnSeq: number,
  opts: { now?: () => Date } = {}
): Promise<BufferDoc | null> {
  const now = opts.now ?? (() => new Date())
  const bufferRef = db.collection(COALESCE_BUFFER_COLLECTION).doc(
    bufferDocId(userId, turnSeq)
  )
  const userRef = db.collection("pa-users").doc(userId)

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(bufferRef)
    if (!snap.exists) return null
    const buf = snap.data() as BufferDoc
    if (buf.status === "fired") return null

    const fired: BufferDoc = {
      ...buf,
      status: "fired",
      pendingTaskName: null,
      lastReceivedAt: buf.lastReceivedAt,
    }
    tx.set(bufferRef, fired)

    // Bump user's turn counter so the NEXT message starts turn = current + 1.
    tx.set(
      userRef,
      { [COALESCE_USER_FIELD]: buf.turnSeq + 1, coalesceLastFiredAt: nowIso(now) },
      { merge: true }
    )
    return fired
  })
}

/**
 * Find buffer docs whose firstReceivedAt is older than `staleAfterMs` and
 * status="pending". Used by the sweep CF (R1 mitigation) to force-fire
 * buffers whose Cloud Tasks task got stuck.
 *
 * Bounded result set (limit) so a single sweep tick stays cheap. Sweep
 * implementation iterates and calls `markFiredTransaction` + processCoalescedTurn
 * per row.
 */
export async function findStaleBuffers(
  db: Firestore,
  opts: {
    now?: () => Date
    staleAfterMs?: number
    limit?: number
  } = {}
): Promise<BufferDoc[]> {
  const now = opts.now ?? (() => new Date())
  const staleAfterMs = opts.staleAfterMs ?? 30_000
  const limit = opts.limit ?? 50
  const cutoffIso = new Date(now().getTime() - staleAfterMs).toISOString()

  const snap = await db
    .collection(COALESCE_BUFFER_COLLECTION)
    .where("status", "==", "pending")
    .where("firstReceivedAt", "<", cutoffIso)
    .limit(limit)
    .get()
  return snap.docs.map((d) => d.data() as BufferDoc)
}

/**
 * Cloud Tasks task names allow only [A-Za-z0-9_-]; phone numbers contain
 * "+". Strip / replace to keep names valid. Same input always maps to same
 * output (idempotency).
 */
/**
 * Outcome of a typing-driven buffer bump.
 *
 *   "bumped"  — there was an active pending buffer and we patched
 *               `lastReceivedAt`. Caller should cancel the prior Cloud Tasks
 *               task and re-enqueue at `recommendedDelayMs`.
 *   "no-buffer" — typing event arrived before any inbound message. No-op;
 *               nothing to do (we cannot create a buffer from typing alone
 *               because there's no message body to coalesce).
 *   "hard-capped" — buffer exists but `firstReceivedAt + HARD_CAP_MS` already
 *               elapsed. We do NOT extend the deadline (anti-troll guard).
 *               Caller should leave the existing task alone — it'll force-fire
 *               on schedule.
 *   "fired"   — buffer status was already `fired`. No-op.
 */
export type BumpOutcome =
  | {
      action: "bumped"
      cancelTaskName: string | null
      nextTaskName: string
      recommendedDelayMs: number
      turnSeq: number
      messageCount: number
    }
  | { action: "no-buffer" | "hard-capped" | "fired" }

/**
 * Event-driven coalesce — Sendblue typing webhook bump path.
 *
 * Reads the user's current turnSeq + active buffer doc inside a transaction.
 * If a pending buffer exists, atomically:
 *   - patches `lastReceivedAt = now()`,
 *   - bumps `pendingTaskName` to the next monotonic task short-name,
 *   - returns the prior task name so the caller can cancel + re-enqueue.
 *
 * Side-effect free w.r.t. Cloud Tasks (caller does the actual enqueue/cancel)
 * to keep the transaction tight. Mirrors the
 * `coalesceTransaction → enqueueOrCoalesce` separation already established
 * in this module.
 *
 * `firstReceivedAt` is NEVER mutated — HARD_CAP_MS is anchored to the moment
 * the FIRST message landed, not the last typing tick. That's the anti-troll
 * invariant: even continuous typing cannot keep a turn pending past 12 s.
 *
 * `messageCount` is NOT incremented either — typing is not a message; counts
 * stay aligned with actual `pa-inbound-events` rows for forensic accuracy.
 */
export async function bumpCoalesceBufferTransaction(
  db: Firestore,
  userId: string,
  opts: {
    /** true = typing started (extend window); false = stopped (short tail). */
    isTyping: boolean
    now?: () => Date
    typingBumpMs?: number
    typingStoppedTailMs?: number
    hardCapMs?: number
    taskNameFn?: (userId: string, turnSeq: number, messageCount: number) => string
  }
): Promise<BumpOutcome> {
  const now = opts.now ?? (() => new Date())
  const bumpMs = opts.typingBumpMs ?? TYPING_BUMP_DELAY_MS
  const tailMs = opts.typingStoppedTailMs ?? TYPING_STOPPED_TAIL_MS
  const hardCap = opts.hardCapMs ?? HARD_CAP_MS
  const taskNameFn =
    opts.taskNameFn ?? ((u, t, c) => `pa-coalesce-${sanitizeTaskComponent(u)}-${t}-${c}`)

  const userRef = db.collection("pa-users").doc(userId)

  return db.runTransaction(async (tx) => {
    const userSnap = await tx.get(userRef)
    const userData = (userSnap.exists ? userSnap.data() : {}) as Record<string, unknown>
    const turnSeq = Number(userData[COALESCE_USER_FIELD] ?? 0)
    if (!turnSeq) return { action: "no-buffer" } as BumpOutcome

    const bufferRef = db.collection(COALESCE_BUFFER_COLLECTION).doc(
      bufferDocId(userId, turnSeq)
    )
    const bufSnap = (await tx.get(bufferRef)) as DocumentSnapshot
    if (!bufSnap.exists) return { action: "no-buffer" } as BumpOutcome
    const buf = bufSnap.data() as BufferDoc
    if (buf.status === "fired") return { action: "fired" } as BumpOutcome

    // Hard-cap guard — typing cannot push beyond firstReceivedAt + HARD_CAP_MS.
    const firstAtMs = Date.parse(buf.firstReceivedAt)
    const nowMs = now().getTime()
    const elapsedMs = Number.isFinite(firstAtMs) ? nowMs - firstAtMs : 0
    const remainingMs = Math.max(0, hardCap - elapsedMs)
    if (remainingMs === 0) return { action: "hard-capped" } as BumpOutcome

    // Pick desired delay based on typing state, then clamp to remaining cap.
    const desired = opts.isTyping ? bumpMs : tailMs
    const recommendedDelayMs = Math.min(desired, remainingMs)

    // Increment messageCount-like counter ONLY for task-name uniqueness; we
    // re-use the existing `messageCount` for stability but DO NOT persist a
    // changed value (typing is not a message). The next inbound message will
    // bump messageCount via coalesceTransaction's normal path.
    //
    // Cloud Tasks rejects duplicate task names within ~1h tombstone window,
    // so we synthesize a fresh suffix using the current `messageCount` plus
    // a deterministic typing-tick salt. We persist `lastTypingTickSeq` so
    // subsequent typing events keep producing fresh names.
    const tickSeq = Number((buf as Record<string, unknown>).lastTypingTickSeq ?? 0) + 1
    const taskNameSeq = buf.messageCount * 100 + tickSeq // clearly distinct namespace
    const nextTaskName = taskNameFn(userId, turnSeq, taskNameSeq)

    const patched: Partial<BufferDoc> & Record<string, unknown> = {
      pendingTaskName: nextTaskName,
      lastReceivedAt: now().toISOString(),
      lastTypingTickSeq: tickSeq,
    }
    tx.set(bufferRef, patched, { merge: true })

    return {
      action: "bumped",
      cancelTaskName: buf.pendingTaskName,
      nextTaskName,
      recommendedDelayMs,
      turnSeq: buf.turnSeq,
      messageCount: buf.messageCount,
    }
  })
}

function sanitizeTaskComponent(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "_")
}

/** Exported for tests so they can mirror the production naming. */
export const _internals = { sanitizeTaskComponent, bufferDocId }
