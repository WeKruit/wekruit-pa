/**
 * paSendblueOutbox CF — pa_outbound → Sendblue REST POST (D-05).
 *
 * Trigger: onDocumentCreated("pa-outbound/{docId}", handler) AND on
 * status-pending update (reclaim case). Pure handler `paSendblueOutboxHandler`
 * accepts deps for testability; the CF wrapper in apps/functions/src/index.ts
 * binds the live Firestore + Sendblue client.
 *
 * Flow (port of apps/macos-imessage-worker/src/outbox.ts:99-259):
 *   1. PA_CHANNEL_LEGACY=1 → return early (D-08; macOS worker is authority)
 *   2. Claim transactionally (status pending → sending) — prevents
 *      double-send across CF retries
 *   3. Runtime approval gate (blocks legacy direct pa-outbound producers)
 *   4. Allowlist gate (mirror outbox.ts:121-137 keyed on toE164 E.164)
 *   5. Append transcript (skip when idempotencyKey starts with
 *      `out-imessage-in-` OR `out-sendblue-` per D-02)
 *   6. Optional typing indicator (PA_TYPING_INDICATOR=1, D-06)
 *   7. POST Sendblue REST → on 4xx → status=failed; on 5xx → status=pending
 *      with attemptCount bumped (CF re-fires via reclaim or next mutation)
 *   8. On 2xx → status=sent + record uuid/messageHandle for delivery audit
 */

import { PA_COLLECTIONS } from "@pa/core-types"
import type { Firestore } from "firebase-admin/firestore"

import { useDmAllowlist, getPeerAllowlist, isSamePeer, normalizePeer } from "./allowlist.js"
import { SendblueClientError, SendblueServerError, sendImessage as defaultSendImessage } from "./sendblue-client.js"
import { sendTypingIndicator as defaultSendTypingIndicator, computeTypingDwellMs } from "./typing-indicator.js"
import type { SendblueSendResponse } from "./types.js"
import { getFlag, getDailyOutboundCount, incrementDailyOutbound } from "@pa/pa-persistence"
import { recordAuditEvent } from "./audit.js"
import { outboundExpiresAtTs } from "./ttl.js"

const OUT = PA_COLLECTIONS.outbound

export function shouldAppendOutboundTranscript(raw: { idempotencyKey?: unknown }): boolean {
  const idempotencyKey = String(raw.idempotencyKey ?? "")
  if (idempotencyKey.startsWith("out-imessage-in-")) return false
  if (idempotencyKey.startsWith("out-sendblue-")) return false
  return true
}

export function isMarketplaceOutreachOutbound(raw: { idempotencyKey?: unknown }): boolean {
  return String(raw.idempotencyKey ?? "").startsWith("outreach_idempotency_")
}

export function isRuntimeApprovedOutbound(raw: { runtimeApproved?: unknown }): boolean {
  return raw.runtimeApproved === true
}

/**
 * Phase 24.5 — flag-backed legacy-channel guard. Reads `PA_CHANNEL_LEGACY` from
 * `pa-feature-flags` via `getFlag()` with the caller's `process.env` injected
 * for emergency-override (env=`1` short-circuits without Firestore read).
 * defaultValue=false matches pre-flag env-var semantics: absent flag +
 * absent env = proceed. Production seed writes value=true (CONTEXT.md
 * initial seeds table); env=1 still short-circuits as emergency override.
 */
export async function isLegacyChannelEnabledFlag(
  db: import("firebase-admin/firestore").Firestore
): Promise<boolean> {
  const v = await getFlag(db, "PA_CHANNEL_LEGACY", { env: process.env }, false)
  return Boolean(v)
}

export function isTypingIndicatorEnabled(): boolean {
  return process.env.PA_TYPING_INDICATOR === "1"
}

type OutboundEvent = {
  params: { docId: string }
  data?:
    | {
        data: () => Record<string, unknown> | undefined
        id: string
      }
    | null
}

type SendblueClientLike = {
  sendImessage: typeof defaultSendImessage
  sendTypingIndicator: typeof defaultSendTypingIndicator
}

export type OutboxDeps = {
  db: Firestore
  sendblueClient: SendblueClientLike
  now?: () => Date
  log?: (...args: unknown[]) => void
  // Loose signatures so production injects from @pa/pa-persistence without
  // type-narrowing friction. Internal call sites cast at use.
  appendMessage?: (db: Firestore, input: never) => Promise<unknown>
  getUser?: (db: Firestore, userId: string) => Promise<{ id: string } | null>
  getOrCreateSession?: (
    db: Firestore,
    userId: string,
    channel: never,
    externalChatId: string
  ) => Promise<{ id: string }>
  readOutreachStopControl?: (
    db: Firestore,
    input: { scope: "global" }
  ) => Promise<{ paused: boolean; reason?: string }>
}

const STALE_SENDING_MS = 10 * 60 * 1000 // 10 minutes
const DEAD_LETTER_ATTEMPTS = 5
const SWEEP_LIMIT = 20

/**
 * Stream H4 D4 — structured failure log for alert pipeline.
 *
 * Emits a single severity=ERROR Cloud Logging entry that the
 * "pa.outbound.failed" log-based metric (see scripts/setup-failure-alert.sh)
 * counts. Body is truncated to 200 chars to keep log payload bounded.
 *
 * Called at every status flip to "failed" or "dead_letter", with
 * `firebase-functions/logger.error` semantics by way of the injected
 * `log` callback (which in production binds to logger.error).
 */
export function logOutboundFailure(
  log: (...args: unknown[]) => void,
  fields: {
    docId: string
    userId: string
    idempotencyKey?: string
    lastError: string
    attempts: number
    body: string
    terminalStatus: "failed" | "dead_letter"
  }
): void {
  log("pa.outbound.failed", {
    severity: "ERROR",
    docId: fields.docId,
    userId: fields.userId,
    idempotencyKey: fields.idempotencyKey ?? null,
    lastError: fields.lastError,
    attempts: fields.attempts,
    body_preview: fields.body.slice(0, 200),
    terminalStatus: fields.terminalStatus,
  })
}

/**
 * Stream H4 D2 — top-of-tick stale-row sweep.
 *
 * Rescues two failure modes that the onDocumentCreated trigger cannot:
 *   1) status="sending" rows that crashed mid-flight (>10min) → reset to "pending"
 *   2) status="pending" rows that exhausted retries (attemptCount >= 5) → "dead_letter"
 *
 * Idempotent: each candidate row is flipped via runTransaction that re-reads
 * status inside the tx, so two concurrent sweepers can't double-flip. The
 * sweep is bounded (limit=20 per tick) so cost is O(1) per CF invocation.
 *
 * Design note: this sweep runs on every paSendblueOutbox tick (each new
 * pa-outbound CREATE fires the trigger, and that trigger now also performs
 * housekeeping). This piggyback approach avoids needing a separate scheduled
 * CF for cleanup.
 */
export async function sweepStaleOutbound(
  db: Firestore,
  now: () => Date,
  log: (...args: unknown[]) => void
): Promise<{ swept: number; deadLettered: number }> {
  const nowMs = now().getTime()
  const cutoffIso = new Date(nowMs - STALE_SENDING_MS).toISOString()
  const nowIso = new Date(nowMs).toISOString()

  let swept = 0
  let deadLettered = 0

  // ---- Sweep 1: status="sending" stuck > 10min → reset to "pending" ----
  // Query single-field-indexed only (status); filter staleness client-side
  // to avoid requiring a (status, updatedAt) composite index that may not
  // be deployed yet. Result set is tiny (stuck rows are rare).
  try {
    const sendingSnap = await db
      .collection(OUT)
      .where("status", "==", "sending")
      .limit(SWEEP_LIMIT)
      .get()
    for (const doc of sendingSnap.docs) {
      const d = doc.data() as { updatedAt?: string }
      const t = Date.parse(String(d.updatedAt ?? ""))
      const isStale = Number.isNaN(t) || t < nowMs - STALE_SENDING_MS
      if (!isStale) continue
      // eslint-disable-next-line no-await-in-loop
      const ok = await db.runTransaction(async (tx) => {
        const cur = await (tx.get as (r: typeof doc.ref) => Promise<{ exists: boolean; data: () => unknown }>)(doc.ref)
        if (!cur.exists) return false
        const cd = (cur.data() ?? {}) as { status?: string }
        if (cd.status !== "sending") return false
        tx.update(doc.ref as never, {
          status: "pending",
          updatedAt: nowIso,
          staleSweptAt: nowIso,
          expiresAtTs: outboundExpiresAtTs(now()),
        })
        return true
      })
      if (ok) {
        swept++
        log("outbound_sending_stale_swept", { docId: doc.id, cutoff: cutoffIso })
      }
    }
  } catch (err) {
    log("[sendblue][outbox] sweep stale-sending error (non-fatal)",
      err instanceof Error ? err.message : String(err))
  }

  // ---- Sweep 2: status="pending" attemptCount >= 5 → "dead_letter" ----
  try {
    const pendingSnap = await db
      .collection(OUT)
      .where("status", "==", "pending")
      .limit(SWEEP_LIMIT)
      .get()
    for (const doc of pendingSnap.docs) {
      const d = doc.data() as { attemptCount?: number }
      const attempts = Number(d.attemptCount ?? 0)
      if (attempts < DEAD_LETTER_ATTEMPTS) continue
      // eslint-disable-next-line no-await-in-loop
      const ok = await db.runTransaction(async (tx) => {
        const cur = await (tx.get as (r: typeof doc.ref) => Promise<{ exists: boolean; data: () => unknown }>)(doc.ref)
        if (!cur.exists) return false
        const cd = (cur.data() ?? {}) as { status?: string; attemptCount?: number }
        if (cd.status !== "pending") return false
        if (Number(cd.attemptCount ?? 0) < DEAD_LETTER_ATTEMPTS) return false
        tx.update(doc.ref as never, {
          status: "dead_letter",
          updatedAt: nowIso,
          deadLetteredAt: nowIso,
          expiresAtTs: outboundExpiresAtTs(now()),
        })
        return true
      })
      if (ok) {
        deadLettered++
        log("outbound_dead_lettered", { docId: doc.id, attempts })
        // Stream H4 D4 — structured pa.outbound.failed log for alert metric
        logOutboundFailure(log, {
          docId: doc.id,
          userId: String((d as { userId?: unknown }).userId ?? "?"),
          idempotencyKey: typeof (d as { idempotencyKey?: unknown }).idempotencyKey === "string" ? String((d as { idempotencyKey?: unknown }).idempotencyKey) : undefined,
          lastError: String((d as { error?: unknown }).error ?? "exhausted retries"),
          attempts,
          body: String((d as { body?: unknown }).body ?? ""),
          terminalStatus: "dead_letter",
        })
      }
    }
  } catch (err) {
    log("[sendblue][outbox] sweep dead-letter error (non-fatal)",
      err instanceof Error ? err.message : String(err))
  }

  return { swept, deadLettered }
}


export async function paSendblueOutboxHandler(
  event: OutboundEvent,
  deps: OutboxDeps
): Promise<void> {
  const log = deps.log ?? console.log
  const now = deps.now ?? (() => new Date())
  const docId = event.params.docId
  const data = event.data?.data?.()
  if (!data) {
    log("[sendblue][outbox] event without data", { docId })
    return
  }

  // ---- 1. Legacy guard (D-08; Phase 24.5 flag-backed) ------------------
  // env-var emergency override is honored inside getFlag (T1 SDK).
  if (await isLegacyChannelEnabledFlag(deps.db)) {
    log("[sendblue][outbox] PA_CHANNEL_LEGACY flag=true — releasing to macOS worker", { docId })
    return
  }

  // ---- 1b. Stream H4 D2 — top-of-tick stale-row sweep -------------------
  // Best-effort piggyback housekeeping. Idempotent under concurrent CF
  // invocations (each row flip uses runTransaction with status re-check).
  try {
    await sweepStaleOutbound(deps.db, now, log)
  } catch (err) {
    log("[sendblue][outbox] sweep top-level error (non-fatal)",
      err instanceof Error ? err.message : String(err))
  }

  const ref = deps.db.collection(OUT).doc(docId)

  // ---- 2. Claim transactionally ----------------------------------------
  const claimed = await deps.db.runTransaction(async (t) => {
    const s = await (t.get as (r: typeof ref) => Promise<{ exists: boolean; data: () => unknown }>)(ref)
    if (!s.exists) return false
    const d = (s.data() ?? {}) as { status?: string }
    if (d.status !== "pending") return false
    t.update(ref as never, { status: "sending", updatedAt: now().toISOString(), expiresAtTs: outboundExpiresAtTs(now()) })
    return true
  })
  if (!claimed) return

  const userId = String(data.userId ?? "")
  const toPeerRaw = String(data.toE164 ?? "")
  const toPeer = toPeerRaw ? normalizePeer(toPeerRaw) : ""
  const body = String(data.body ?? "").trim()

  // Runtime approval gate: pa-outbound is only the transport outbox. It
  // must not become an authorization bypass for legacy webhook/upload/event
  // producers that render their own candidate-facing copy.
  if (!isRuntimeApprovedOutbound(data)) {
    await ref.set(
      {
        status: "failed",
        error: "blocked: outbound row was not approved by runtime",
        blockedByRuntimeGate: true,
        updatedAt: now().toISOString(),
        expiresAtTs: outboundExpiresAtTs(now()),
      },
      { merge: true }
    )
    logOutboundFailure(log, {
      docId,
      userId,
      idempotencyKey: typeof data.idempotencyKey === "string" ? String(data.idempotencyKey) : undefined,
      lastError: "blocked: outbound row was not approved by runtime",
      attempts: Number((data as { attemptCount?: unknown }).attemptCount ?? 0),
      body,
      terminalStatus: "failed",
    })
    return
  }

  // ---- 3. Allowlist gate (mirror macOS outbox.ts:121-137) --------------
  if (useDmAllowlist()) {
    const peers = getPeerAllowlist()
    if (peers.length === 0 || !peers.some((p) => isSamePeer(toPeer, p))) {
      log("[sendblue][outbox] blocked by IMESSAGE_DM_ALLOWLIST", { docId, toPeer, peers: peers.length })
      await ref.set(
        {
          status: "failed",
          error: "blocked by IMESSAGE_DM_ALLOWLIST",
          updatedAt: now().toISOString(),
          expiresAtTs: outboundExpiresAtTs(now()),
        },
        { merge: true }
      )
      logOutboundFailure(log, {
        docId,
        userId,
        idempotencyKey: typeof data.idempotencyKey === "string" ? String(data.idempotencyKey) : undefined,
        lastError: "blocked by IMESSAGE_DM_ALLOWLIST",
        attempts: Number((data as { attemptCount?: unknown }).attemptCount ?? 0),
        body,
        terminalStatus: "failed",
      })
      return
    }
  }

  if (!userId || !toPeer || !body) {
    await ref.set(
      {
        status: "failed",
        error: "missing userId, toE164, or body",
        updatedAt: now().toISOString(),
        expiresAtTs: outboundExpiresAtTs(now()),
      },
      { merge: true }
    )
    logOutboundFailure(log, {
      docId,
      userId,
      idempotencyKey: typeof data.idempotencyKey === "string" ? String(data.idempotencyKey) : undefined,
      lastError: "missing userId, toE164, or body",
      attempts: Number((data as { attemptCount?: unknown }).attemptCount ?? 0),
      body,
      terminalStatus: "failed",
    })
    return
  }

  // v2.0 S9 — marketplace outreach global stop gate. This only applies to
  // S6 marketplace outreach rows, identified by createOutreachIdempotencyKey().
  // A read failure fails closed before transcript append, typing, quota, or send.
  if (isMarketplaceOutreachOutbound(data)) {
    try {
      const control = await deps.readOutreachStopControl?.(deps.db, { scope: "global" })
      if (control?.paused) {
        const reason = control.reason ? `: ${control.reason}` : ""
        await ref.set(
          {
            status: "failed",
            error: `marketplace outreach paused${reason}`,
            blockedByOutreachStopControl: true,
            updatedAt: now().toISOString(),
            expiresAtTs: outboundExpiresAtTs(now()),
          },
          { merge: true }
        )
        logOutboundFailure(log, {
          docId,
          userId,
          idempotencyKey: typeof data.idempotencyKey === "string" ? String(data.idempotencyKey) : undefined,
          lastError: `marketplace outreach paused${reason}`,
          attempts: Number((data as { attemptCount?: unknown }).attemptCount ?? 0),
          body,
          terminalStatus: "failed",
        })
        return
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await ref.set(
        {
          status: "failed",
          error: `marketplace outreach stop control check failed: ${message}`,
          blockedByOutreachStopControl: true,
          updatedAt: now().toISOString(),
          expiresAtTs: outboundExpiresAtTs(now()),
        },
        { merge: true }
      )
      logOutboundFailure(log, {
        docId,
        userId,
        idempotencyKey: typeof data.idempotencyKey === "string" ? String(data.idempotencyKey) : undefined,
        lastError: `marketplace outreach stop control check failed: ${message}`,
        attempts: Number((data as { attemptCount?: unknown }).attemptCount ?? 0),
        body,
        terminalStatus: "failed",
      })
      return
    }
  }

  // ---- 4. Resolve user, optionally append transcript --------------------
  if (deps.getUser) {
    const user = await deps.getUser(deps.db, userId)
    if (!user) {
      await ref.set(
        {
          status: "failed",
          error: "user not found",
          updatedAt: now().toISOString(),
          expiresAtTs: outboundExpiresAtTs(now()),
        },
        { merge: true }
      )
      logOutboundFailure(log, {
        docId,
        userId,
        idempotencyKey: typeof data.idempotencyKey === "string" ? String(data.idempotencyKey) : undefined,
        lastError: "user not found",
        attempts: Number((data as { attemptCount?: unknown }).attemptCount ?? 0),
        body,
        terminalStatus: "failed",
      })
      return
    }
  }

  if (
    shouldAppendOutboundTranscript(data) &&
    deps.getOrCreateSession &&
    deps.appendMessage
  ) {
    try {
      const session = await deps.getOrCreateSession(
        deps.db,
        userId,
        "imessage" as never,
        toPeer
      )
      await deps.appendMessage(deps.db, {
        sessionId: session.id,
        userId,
        role: "user",
        body,
        createdAt: now().toISOString(),
        idempotencyKey: `outbox-msg-${docId}`,
        rawMeta: { source: "pa-console-outbound", outboundDocId: docId },
      } as never)
    } catch (err) {
      log(
        "[sendblue][outbox] transcript append failed (non-fatal)",
        err instanceof Error ? err.message : String(err)
      )
    }
  }

  // ---- 5. Optional typing indicator (D-06) -----------------------------
  // Phase 24 T1E — dynamic dwell scaled by reply length (1-4s by body.length).
  // PA_TYPING_DWELL_MS env override still honored if set (operator escape hatch).
  //
  // KNOWN LIMITATION (24-RESEARCH.md Open Question 4): typing fires here,
  // immediately before the REST POST — NOT at orchestrator reasoning start.
  // True "fire on reasoning start" requires an orchestrator→outbox event
  // (architectural change), deferred from Phase 24. Phase 25 may revisit.
  if (isTypingIndicatorEnabled()) {
    try {
      await deps.sendblueClient.sendTypingIndicator({ to: toPeer })
      const overrideRaw = process.env.PA_TYPING_DWELL_MS
      const overrideMs = overrideRaw != null && overrideRaw !== "" ? Number(overrideRaw) : NaN
      const dwellMs = Number.isFinite(overrideMs) && overrideMs > 0
        ? overrideMs
        : computeTypingDwellMs(body.length)
      // 8000ms safeguard preserved (defensive cap on extreme env values)
      await new Promise((r) => setTimeout(r, Math.min(dwellMs, 8000)))
    } catch {
      // Already best-effort inside the helper; defensive double-swallow.
    }
  }

  // ---- 5b. Daily-quota gate (Phase 26 T2, flag-driven limit) -----------
  const quotaLimit = Number(await getFlag(deps.db, "sendblueDailyQuota", { env: process.env }, 1000))
  const currentCount = await getDailyOutboundCount(deps.db, now())
  if (currentCount >= quotaLimit) {
    try { await recordAuditEvent(deps.db, { type: "quota_hardblock", channel: "imessage_sendblue", toNumber: toPeer, reason: `count=${currentCount} limit=${quotaLimit}` }) } catch {}
    await ref.set({ status: "failed", error: `sendblue daily quota reached (${currentCount}/${quotaLimit})`, updatedAt: now().toISOString(), expiresAtTs: outboundExpiresAtTs(now()) }, { merge: true })
    logOutboundFailure(log, {
      docId,
      userId,
      idempotencyKey: typeof data.idempotencyKey === "string" ? String(data.idempotencyKey) : undefined,
      lastError: `sendblue daily quota reached (${currentCount}/${quotaLimit})`,
      attempts: Number((data as { attemptCount?: unknown }).attemptCount ?? 0),
      body,
      terminalStatus: "failed",
    })
    return
  }
  if (currentCount >= Math.floor(quotaLimit * 0.8)) {
    try { await recordAuditEvent(deps.db, { type: "quota_soft", channel: "imessage_sendblue", toNumber: toPeer, reason: `count=${currentCount} limit=${quotaLimit}` }) } catch {}
  }

  // ---- 6. POST Sendblue REST -------------------------------------------
  try {
    const response: SendblueSendResponse = await deps.sendblueClient.sendImessage({
      to: toPeer,
      content: body,
    })
    const messageHandle = response.message_handle ?? response.uuid ?? null
    await ref.set(
      {
        status: "sent",
        sentAt: now().toISOString(),
        updatedAt: now().toISOString(),
        expiresAtTs: outboundExpiresAtTs(now()),
        ...(messageHandle ? { messageHandle, sendblueUuid: response.uuid ?? messageHandle } : {}),
        sendblueStatus: response.status,
      },
      { merge: true }
    )
    try { await incrementDailyOutbound(deps.db, now()) } catch {}
    log("[sendblue][outbox] sent", { docId, toPeer, messageHandle })
    return
  } catch (err) {
    if (err instanceof SendblueClientError) {
      log("[sendblue][outbox] 4xx — failed", {
        docId,
        status: err.status,
        message: err.message,
        body: typeof err.body === "string" ? err.body : JSON.stringify(err.body)?.slice(0, 500),
      })
      await ref.set(
        {
          status: "failed",
          error: `sendblue ${err.status}: ${err.message}`,
          updatedAt: now().toISOString(),
          expiresAtTs: outboundExpiresAtTs(now()),
        },
        { merge: true }
      )
      logOutboundFailure(log, {
        docId,
        userId,
        idempotencyKey: typeof data.idempotencyKey === "string" ? String(data.idempotencyKey) : undefined,
        lastError: `sendblue ${err.status}: ${err.message}`,
        attempts: Number((data as { attemptCount?: unknown }).attemptCount ?? 0),
        body,
        terminalStatus: "failed",
      })
      return
    }
    if (err instanceof SendblueServerError) {
      log("[sendblue][outbox] 5xx/transient — release for retry", { docId, status: err.status, message: err.message })
      const prev = await ref.get()
      const prevAttempts = Number(((prev.data() as Record<string, unknown> | undefined)?.attemptCount ?? 0))
      await ref.set(
        {
          status: "pending",
          error: `sendblue ${err.status}: ${err.message}`,
          attemptCount: prevAttempts + 1,
          ...(err.retryAfter ? { retryAfter: err.retryAfter } : {}),
          updatedAt: now().toISOString(),
          expiresAtTs: outboundExpiresAtTs(now()),
        },
        { merge: true }
      )
      return
    }
    const unexpectedMsg = err instanceof Error ? err.message : String(err)
    log("[sendblue][outbox] unexpected error", unexpectedMsg)
    await ref.set(
      {
        status: "failed",
        error: unexpectedMsg,
        updatedAt: now().toISOString(),
        expiresAtTs: outboundExpiresAtTs(now()),
      },
      { merge: true }
    )
    logOutboundFailure(log, {
      docId,
      userId,
      idempotencyKey: typeof data.idempotencyKey === "string" ? String(data.idempotencyKey) : undefined,
      lastError: unexpectedMsg,
      attempts: Number((data as { attemptCount?: unknown }).attemptCount ?? 0),
      body,
      terminalStatus: "failed",
    })
    return
  }
}
