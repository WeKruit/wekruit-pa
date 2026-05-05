/**
 * v1.5 Stream-D — message coalescer.
 *
 * Two public surfaces:
 *
 *   1. `enqueueOrCoalesce(deps, msg)`
 *      Called by `paSendblueWebhook` AFTER the broker has written the
 *      per-message pa-inbound-events row. Runs the buffer transaction
 *      (apps/functions/src/coalesce/buffer.ts) and either:
 *        a) creates a new turn and enqueues a Cloud Tasks delayed task, or
 *        b) appends to an existing turn → cancels the prior task → enqueues
 *           a new one with the (combined body, lastMessageId) tuple, or
 *        c) hits soft (>5 msgs) or hard (>12s) cap → enqueues with delay=0.
 *
 *      The original inbound rows are marked `coalescing: true` in the same
 *      transaction so onPaInbound's onDocumentCreated trigger skips them
 *      (see apps/functions/src/index.ts onPaInbound).
 *
 *   2. `processCoalescedTurn(deps, userId, turnSeq)`
 *      Called by the coalesce CF when Cloud Tasks fires. Atomically marks
 *      the buffer status pending→fired (via `markFiredTransaction`). If the
 *      flip happens, it:
 *        - sends Sendblue tap-back ❤️ to lastMessageId (fail-open),
 *        - synthesizes ONE inbound event with the concatenated body,
 *        - invokes claimAndProcessInboundEvent → orchestrator emits ONE reply,
 *        - marks all original inbound rows as completed (status="coalesced").
 *
 *      Re-entrant safe: if status is already "fired", returns early.
 *
 * IMPORTANT — Cloud Tasks failure modes (R1 mitigation):
 *   This module does NOT own R1 sweep — that lives in `buffer-sweep.ts` and
 *   re-uses `processCoalescedTurn` via the same deps. So a stuck Cloud Tasks
 *   task gets force-fired by the sweeper after `staleAfterMs`.
 *
 * Logging contract:
 *   Every fire emits a structured `pa.coalesce.fired` log with messageCount,
 *   delayActualMs, lastMessageId, accumulatedBody.length — so DELIVERY.md's
 *   smoke step can grep Cloud Logging for the canary trace.
 */

import { createHash } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"
import { createInboundEvent } from "@pa/pa-broker"
import { claimAndProcessInboundEvent } from "@pa/pa-orchestrator"
import { PA_COLLECTIONS } from "@pa/core-types"

import {
  coalesceTransaction,
  markFiredTransaction,
  bumpCoalesceBufferTransaction,
  type BufferDoc,
  type IncomingMessage,
  type BumpOutcome,
  COALESCE_BUFFER_COLLECTION,
} from "./buffer.js"
import type { TasksClient } from "./tasks-client.js"
import type { SendReactionInput } from "../sendblue/send-reaction.js"

export type CoalescerDeps = {
  db: Firestore
  tasks: TasksClient
  /** Sendblue Reactions API wrapper. Injected for tests. */
  sendReaction?: (input: SendReactionInput) => Promise<unknown>
  /** Orchestrator entry. Injected for tests; default = pa-orchestrator. */
  claimAndProcessInboundEvent?: typeof claimAndProcessInboundEvent
  /**
   * iter33 Bug 8 fix 2026-05-05 — orchestrator-store deps (Mailgun
   * sendVerificationEmail, etc.). Without this, claimAndProcessInboundEvent
   * builds a bare FirestoreOrchestratorStore with NO Mailgun callback →
   * email-verify path skipped entirely → user goes straight to "got it —
   * email saved" complete state. Wired in apps/functions/src/index.ts via
   * makeOrchestratorDeps().
   */
  orchestratorDeps?: Parameters<typeof claimAndProcessInboundEvent>[3]
  /** Broker entry for synthetic event creation. Injected for tests. */
  createInboundEvent?: typeof createInboundEvent
  /** Inject for tests. Default Date.now. */
  now?: () => Date
  log?: (...args: unknown[]) => void
  /**
   * iter33 Bug 9 fix 2026-05-05 (Adam: "we dont need to like all the
   * message, give it a randomized 30-40% percentage"). Probability that
   * the per-turn ❤️ tapback fires. Injected for tests; default 0.35.
   */
  loveTapbackProbability?: number
  /** Inject for tests. Default Math.random. */
  rng?: () => number
}

export type EnqueueOutcome = {
  action: "created" | "appended" | "force-fire" | "skipped"
  reason?: string
  taskName?: string
  delayMs?: number
  /** turnSeq used for the task (caller may log). */
  turnSeq?: number
}

/**
 * Webhook-side entry. Idempotent w.r.t. duplicate inbound webhooks because
 * `coalesceTransaction` reads-modify-writes within a Firestore transaction
 * and the inboundEventId is appended to a set.
 */
export async function enqueueOrCoalesce(
  deps: CoalescerDeps,
  msg: IncomingMessage
): Promise<EnqueueOutcome> {
  const log = deps.log ?? console.log

  const outcome = await coalesceTransaction(deps.db, msg, { now: deps.now })

  // 1. Cancel prior pending task (best-effort; race-tolerant).
  if (outcome.cancelTaskName) {
    try {
      const cancelled = await deps.tasks.cancelTask(outcome.cancelTaskName)
      log("[coalesce] cancel-prior-task", {
        taskName: outcome.cancelTaskName,
        cancelled,
        userId: msg.userId,
      })
    } catch (err) {
      // Cancel failure is not fatal — the prior task will fire AND the new
      // one will too. The fire path's `markFiredTransaction` deduplicates:
      // first fire wins, second sees status=fired and returns null. We log
      // for forensic visibility but DO NOT abort the new enqueue.
      log("[coalesce] cancel-prior-task FAILED (non-fatal)", {
        taskName: outcome.cancelTaskName,
        userId: msg.userId,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // 2. Mark the original pa-inbound-events row as coalescing so onPaInbound
  //    skips it. We do this OUTSIDE the buffer transaction because it
  //    touches a different collection and we want the buffer write to commit
  //    even if this best-effort patch fails.
  try {
    await deps.db.collection("pa-inbound-events").doc(msg.inboundEventId).set(
      {
        coalescing: true,
        coalesceTurnId: `${msg.userId}__${outcome.buffer.turnSeq}`,
      },
      { merge: true }
    )
  } catch (err) {
    log("[coalesce] inbound-mark-coalescing FAILED (non-fatal)", {
      eventId: msg.inboundEventId,
      err: err instanceof Error ? err.message : String(err),
    })
  }

  // 3. Enqueue the new (delayed) task.
  try {
    await deps.tasks.enqueueDelayedTask({
      taskName: outcome.nextTaskName,
      delayMs: outcome.recommendedDelayMs,
      payload: {
        userId: msg.userId,
        turnSeq: outcome.buffer.turnSeq,
        // Embed messageCount so handler logs reflect the count at enqueue
        // time (helps debug "task fired but messageCount looks stale").
        messageCount: outcome.buffer.messageCount,
      },
    })
  } catch (err) {
    // Enqueue failure is the only fatal branch — caller should fall back to
    // legacy direct path. Throw so the webhook can decide.
    log("[coalesce] enqueue FAILED — caller should fall back to legacy path", {
      taskName: outcome.nextTaskName,
      userId: msg.userId,
      err: err instanceof Error ? err.message : String(err),
    })
    throw err
  }

  log("[coalesce] enqueueOrCoalesce", {
    action: outcome.action,
    userId: msg.userId,
    turnSeq: outcome.buffer.turnSeq,
    messageCount: outcome.buffer.messageCount,
    delayMs: outcome.recommendedDelayMs,
    taskName: outcome.nextTaskName,
  })

  return {
    action: outcome.action,
    taskName: outcome.nextTaskName,
    delayMs: outcome.recommendedDelayMs,
    turnSeq: outcome.buffer.turnSeq,
  }
}


/**
 * Bug-1 fix (v1.5 Stream-D, 2026-05-03 Adam iMessage CRASH):
 *   The coalescer used to synthesize an inbound event and immediately drive
 *   the orchestrator via `claimAndProcessInboundEvent` — bypassing the
 *   `onPaInbound` BrokerImessageEvent path which is where session resolution
 *   lives. The orchestrator then read `event.sessionId === undefined` from
 *   the synthesized inbound row, and `store.createTurn` (writing to
 *   `pa-turns`) crashed with a Firestore validation error.
 *
 *   This helper deterministically resolves (or creates) a session id for
 *   `(userId, channel=imessage, externalChatId)` so the synthesized inbound
 *   event ALWAYS carries a usable sessionId. It mirrors `getOrCreateSession`
 *   in apps/functions/src/index.ts byte-for-byte (same docId hash) so the
 *   per-message broker path and the coalesced path converge on the SAME
 *   session row — no orphan rows, no history split.
 *
 *   Why inline rather than abstract: the helper is ~12 lines and lives next
 *   to its only caller. Lifting it into a shared module would force broker
 *   or core-types to know about "sessions" and "channels", which is the
 *   wrong layering. If a third caller ever needs it, then we extract.
 */
function sessionDocIdForCoalesce(userId: string, externalChatId: string): string {
  const h = createHash("sha256")
    .update(`${userId}|imessage|${externalChatId}`)
    .digest("hex")
  return `ses_${h.slice(0, 32)}`
}

async function resolveOrCreateImessageSession(
  db: Firestore,
  userId: string,
  fromNumber: string,
  nowIso: string
): Promise<string> {
  // Buffer.fromNumber is already E.164-normalized by the SendBlue webhook
  // path, so we use it as the externalChatId verbatim. (The legacy broker
  // path runs `normalizeImessageParticipant` which lowercases emails — the
  // coalescer only handles iMessage phone numbers, no email addresses, so
  // the normalize step is a no-op here.)
  const sessionId = sessionDocIdForCoalesce(userId, fromNumber)
  const ref = db.collection(PA_COLLECTIONS.sessions).doc(sessionId)
  const snap = await ref.get()
  if (!snap.exists) {
    await ref.set({
      id: sessionId,
      userId,
      channel: "imessage",
      externalChatId: fromNumber,
      createdAt: nowIso,
      lastMessageAt: nowIso,
    })
  }
  return sessionId
}

export type BumpEnqueueOutcome = {
  action: BumpOutcome["action"]
  taskName?: string
  delayMs?: number
  turnSeq?: number
  reason?: string
}

/**
 * Webhook-side entry for Sendblue typing-indicator events.
 *
 * Adam 顶层设计 fix (2026-05-03): we already receive `typing_indicator`
 * webhook events but historically only audited and dropped them. This bumps
 * the active coalesce buffer so natural typing gaps > DEFAULT_DELAY_MS still
 * coalesce into one turn → one outbound. Time-driven coalesce is a fallback
 * baseline; this is the event-driven primary path.
 *
 * Idempotent + fail-open:
 *   - "no-buffer" / "fired" / "hard-capped" → no Cloud Tasks side effects.
 *   - On Cloud Tasks failure (cancel OR enqueue) we log and return; the
 *     existing pending task fires on schedule → user still gets a reply,
 *     coalesce just degrades to time-driven for that turn.
 *
 * Returns the high-level decision so the caller (webhook) can audit-log the
 * hit/miss rate.
 */
export async function bumpCoalesceBuffer(
  deps: CoalescerDeps,
  input: { userId: string; isTyping: boolean }
): Promise<BumpEnqueueOutcome> {
  const log = deps.log ?? console.log
  let outcome: BumpOutcome
  try {
    outcome = await bumpCoalesceBufferTransaction(deps.db, input.userId, {
      isTyping: input.isTyping,
      now: deps.now,
    })
  } catch (err) {
    log("[coalesce] bump-tx FAILED (non-fatal — typing is fail-open)", {
      userId: input.userId,
      err: err instanceof Error ? err.message : String(err),
    })
    return { action: "no-buffer", reason: "tx_error" }
  }

  if (outcome.action !== "bumped") {
    log("[coalesce] bump", {
      userId: input.userId,
      isTyping: input.isTyping,
      action: outcome.action,
    })
    return { action: outcome.action }
  }

  // 1. Cancel prior task (best-effort; race-tolerant — same pattern as
  //    enqueueOrCoalesce).
  if (outcome.cancelTaskName) {
    try {
      const cancelled = await deps.tasks.cancelTask(outcome.cancelTaskName)
      log("[coalesce] bump cancel-prior-task", {
        taskName: outcome.cancelTaskName,
        cancelled,
        userId: input.userId,
      })
    } catch (err) {
      log("[coalesce] bump cancel-prior-task FAILED (non-fatal)", {
        taskName: outcome.cancelTaskName,
        userId: input.userId,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // 2. Enqueue new task with the bumped delay.
  try {
    await deps.tasks.enqueueDelayedTask({
      taskName: outcome.nextTaskName,
      delayMs: outcome.recommendedDelayMs,
      payload: {
        userId: input.userId,
        turnSeq: outcome.turnSeq,
        messageCount: outcome.messageCount,
        bumpedByTyping: true,
      },
    })
  } catch (err) {
    // Fail-open: prior task was already cancelled (or failed silently). The
    // R1 sweeper (buffer-sweep) catches stuck buffers within `staleAfterMs`,
    // and a follow-up real inbound message would re-enqueue normally. Worst
    // case: this turn fires via sweep ~30s later instead of the bumped 8s.
    log("[coalesce] bump enqueue FAILED (non-fatal — sweep will catch)", {
      taskName: outcome.nextTaskName,
      userId: input.userId,
      err: err instanceof Error ? err.message : String(err),
    })
    return { action: "bumped", reason: "enqueue_failed", turnSeq: outcome.turnSeq }
  }

  log("[coalesce] bump", {
    userId: input.userId,
    isTyping: input.isTyping,
    action: "bumped",
    turnSeq: outcome.turnSeq,
    delayMs: outcome.recommendedDelayMs,
    taskName: outcome.nextTaskName,
  })

  return {
    action: "bumped",
    taskName: outcome.nextTaskName,
    delayMs: outcome.recommendedDelayMs,
    turnSeq: outcome.turnSeq,
  }
}


/**
 * Cloud Tasks → CF endpoint. Executes the coalesced turn:
 *   1. Atomic flip status pending→fired (re-entrant safe).
 *   2. Tap-back ❤️ to lastMessageId (fail-open).
 *   3. Synthesize ONE inbound event with concatenated body.
 *   4. Invoke orchestrator → ONE reply.
 *   5. Mark per-message inbound rows as `status="coalesced"` so they don't
 *      sit in pending forever.
 */
export async function processCoalescedTurn(
  deps: CoalescerDeps,
  userId: string,
  turnSeq: number
): Promise<{ status: "fired" | "already_fired" | "no_buffer"; buffer?: BufferDoc }> {
  const log = deps.log ?? console.log
  const fired = await markFiredTransaction(deps.db, userId, turnSeq, { now: deps.now })

  if (!fired) {
    // Could be either: doc never existed, OR it was already fired by a
    // duplicate Cloud Tasks delivery (at-least-once). Distinguish via a
    // follow-up read so the caller can choose the right HTTP response.
    const snap = await deps.db
      .collection(COALESCE_BUFFER_COLLECTION)
      .doc(`${userId}__${turnSeq}`)
      .get()
    return { status: snap.exists ? "already_fired" : "no_buffer" }
  }

  // 1. Tap-back ❤️ to lastMessageId — Adam directive: anchor reply to LAST
  //    received message, not first. Failure is non-fatal (R5: send-reaction
  //    has its own breaker; 4xx on expired handle is expected for very-old
  //    messages but doesn't matter for the ~4s coalesce window).
  //
  //    iter33 Bug 9 fix 2026-05-05 — Adam ("we dont need to like all the
  //    message, give it a randomized 30-40% percentage is good"). Old
  //    behavior: every coalesced turn fired ❤️ unconditionally → spammy.
  //    Bumped from 35% → 40% after Adam reported 6/6 SKIPPED in a session
  //    (0.65^6 ≈ 7.5% theoretical streak; 0.6^6 ≈ 4.7% at 40%). Tunable
  //    via deps.loveTapbackProbability. Skip-decision now logs the raw
  //    rng roll so prod-log inspection can distinguish "gate skipped"
  //    from "transport down".
  const loveProbability = typeof deps.loveTapbackProbability === "number"
    ? Math.max(0, Math.min(1, deps.loveTapbackProbability))
    : 0.40
  const rng = deps.rng ?? Math.random
  const rngRoll = rng()
  const shouldLove = rngRoll < loveProbability
  if (deps.sendReaction && fired.lastMessageId && shouldLove) {
    try {
      await deps.sendReaction({
        to: fired.fromNumber,
        messageHandle: fired.lastMessageId,
        reaction: "love",
      })
      log("[coalesce] tap-back sent", {
        userId,
        turnSeq,
        lastMessageId: fired.lastMessageId,
        probability: loveProbability,
        rngRoll: rngRoll.toFixed(4),
      })
    } catch (err) {
      log("[coalesce] tap-back FAILED (non-fatal — reply still proceeds)", {
        userId,
        turnSeq,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  } else if (deps.sendReaction && fired.lastMessageId) {
    log("[coalesce] tap-back SKIPPED (rng gate)", {
      userId,
      turnSeq,
      lastMessageId: fired.lastMessageId,
      probability: loveProbability,
      rngRoll: rngRoll.toFixed(4),
    })
  }

  // 2. Resolve (or create) the iMessage session BEFORE synthesizing the
  //    inbound event. Bug 1 root cause: the coalescer used to skip session
  //    resolution and drive the orchestrator directly via
  //    `claimAndProcessInboundEvent`, bypassing the BrokerImessageEvent path
  //    in `onPaInbound` where session lookup happens. The orchestrator then
  //    read `event.sessionId === undefined` and `store.createTurn` crashed
  //    Firestore.
  //
  //    Doing this BEFORE the broker write lets us stamp `sessionId` onto the
  //    synthesized inbound doc atomically below (same merge() call as
  //    `userId`), so the orchestrator's `claimInboundEvent` always reads a
  //    populated `sessionId` and the downstream `pa-turns` write succeeds.
  //
  //    `nowIso` is computed once and reused for `createdAt`/`lastMessageAt`.
  const synthNowIso = (deps.now ? deps.now() : new Date()).toISOString()
  const sessionId = await resolveOrCreateImessageSession(
    deps.db,
    userId,
    fired.fromNumber,
    synthNowIso
  )

  // 3. Synthesize ONE inbound event carrying the concatenated body. Reuses
  //    the broker idempotency contract (same key = no-op), and reuses the
  //    same rawPayload shape onPaInbound already understands (kind="imessage",
  //    participant + text + chatId).
  const idempotencyKey = `coalesced-${userId}-${turnSeq}`
  const broker = deps.createInboundEvent ?? createInboundEvent
  const chatId = `iMessage;-;${fired.fromNumber}`
  const created = await broker(deps.db, {
    channel: "imessage",
    idempotencyKey,
    rawPayload: {
      kind: "imessage",
      source: "sendblue-coalesced",
      fromNumber: fired.fromNumber,
      toNumber: fired.toNumber,
      text: fired.accumulatedBody,
      chatId,
      // Re-use the LAST message handle so anything downstream (e.g. analytics)
      // that wants to correlate the orchestrator output with the user's last
      // input has the canonical anchor.
      messageHandle: fired.lastMessageId,
      participant: fired.fromNumber,
      service: "iMessage",
      // Forensic — track which raw inbounds rolled into this synthesis.
      coalescedFrom: fired.inboundEventIds,
      coalesceTurnSeq: turnSeq,
      coalesceMessageCount: fired.messageCount,
    },
  })

  // Stamp ALL InboundEvent-required scalar fields directly on the synthesized
  // event so the orchestrator's `claimInboundEvent` (which only does a raw
  // `t.get(ref)`, no rawPayload extraction, no session lookup) sees a
  // fully-populated InboundEvent. Without these stamps the legacy broker
  // path's `body`/`from`/`externalChatId` writes (apps/functions/src/index.ts
  // ~line 404) are silently absent on the coalesced path and the orchestrator
  // crashes Firestore.
  //
  //   Bug 1 (sessionId): fixed earlier by stamping `userId` + `sessionId`.
  //   Bug 5 (body) — Adam iMessage 2026-05-03 01:05 + 01:22 production crash:
  //     `[orchestrator] turn failed ... errorCode: 'TURN_FAILED', error:
  //      'Cannot use "undefined" as a Firestore value (found in field "body")'`
  //     Same RCA mode as Bug 1 — the synthesized doc was missing a top-level
  //     `body`. `processInboundEvent` then called `store.appendMessage({ body:
  //     event.body /* undefined */ })` and Firestore rejected the write.
  //
  // The accumulatedBody is the canonical inbound text. `fromNumber` is already
  // E.164-normalized at the SendBlue webhook (no email path possible — phones
  // only); `externalChatId` per the legacy `normalizeImessageParticipant` is a
  // no-op for E.164, so we reuse `fromNumber` verbatim. Mirrors
  // apps/functions/src/index.ts:404 byte-equivalent for forensic determinism.
  try {
    await deps.db.collection("pa-inbound-events").doc(created.id).set(
      {
        userId,
        sessionId,
        body: fired.accumulatedBody,
        from: fired.fromNumber,
        externalChatId: fired.fromNumber,
        coalesced: true,
      },
      { merge: true }
    )
  } catch (err) {
    log("[coalesce] inbound-stamp-event FAILED (non-fatal)", {
      eventId: created.id,
      err: err instanceof Error ? err.message : String(err),
    })
  }

  // 4. Drive orchestrator → ONE reply. Use the same path onPaInbound uses
  //    so we get identical lease + claim semantics.
  //
  //    iter33 Bug 8 fix 2026-05-05 — pass orchestratorDeps so the
  //    Mailgun sendVerificationEmail callback survives into
  //    createFirestoreOrchestratorStore. Old call site was
  //    `claimer(deps.db, created.id)` (2 args) → orchestrator built
  //    with empty deps → email-verify path no-op → user skipped to
  //    complete with bare "got it — email saved".
  const claimer = deps.claimAndProcessInboundEvent ?? claimAndProcessInboundEvent
  const orchLog = (...a: unknown[]) => log("[coalesce/orchestrator]", ...a)
  await claimer(deps.db, created.id, orchLog, deps.orchestratorDeps ?? {})

  // 5. Mark all original per-message inbound rows as "coalesced" — purely
  //    for housekeeping (status visible in dashboards). Best-effort.
  await Promise.allSettled(
    fired.inboundEventIds.map((eventId) =>
      deps.db.collection("pa-inbound-events").doc(eventId).set(
        {
          status: "coalesced",
          coalesceTurnId: `${userId}__${turnSeq}`,
          coalesceParentId: created.id,
        },
        { merge: true }
      )
    )
  )

  // 6. Structured log for DELIVERY.md smoke verification.
  const firstAtMs = Date.parse(fired.firstReceivedAt)
  const lastAtMs = Date.parse(fired.lastReceivedAt)
  const elapsedMs =
    Number.isFinite(firstAtMs) && Number.isFinite(lastAtMs) ? lastAtMs - firstAtMs : -1
  log("pa.coalesce.fired", {
    severity: "INFO",
    userId,
    turnSeq,
    messageCount: fired.messageCount,
    coalescedInboundEventIds: fired.inboundEventIds,
    syntheticInboundEventId: created.id,
    accumulatedBodyLen: fired.accumulatedBody.length,
    elapsedMs,
    lastMessageId: fired.lastMessageId,
  })

  return { status: "fired", buffer: fired }
}
