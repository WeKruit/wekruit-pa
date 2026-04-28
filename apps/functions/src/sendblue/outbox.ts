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
 *   3. Allowlist gate (mirror outbox.ts:121-137 keyed on toE164 E.164)
 *   4. Append transcript (skip when idempotencyKey starts with
 *      `out-imessage-in-` OR `out-sendblue-` per D-02)
 *   5. Optional typing indicator (PA_TYPING_INDICATOR=1, D-06)
 *   6. POST Sendblue REST → on 4xx → status=failed; on 5xx → status=pending
 *      with attemptCount bumped (CF re-fires via reclaim or next mutation)
 *   7. On 2xx → status=sent + record uuid/messageHandle for delivery audit
 */

import { PA_COLLECTIONS } from "@pa/core-types"
import type { Firestore } from "firebase-admin/firestore"

import { useDmAllowlist, getPeerAllowlist, isSamePeer, normalizePeer } from "./allowlist.js"
import { SendblueClientError, SendblueServerError, sendImessage as defaultSendImessage } from "./sendblue-client.js"
import { sendTypingIndicator as defaultSendTypingIndicator, computeTypingDwellMs } from "./typing-indicator.js"
import type { SendblueSendResponse } from "./types.js"
import { getFlag, getDailyOutboundCount, incrementDailyOutbound } from "@pa/pa-persistence"
import { recordAuditEvent } from "./audit.js"

const OUT = PA_COLLECTIONS.outbound

export function shouldAppendOutboundTranscript(raw: { idempotencyKey?: unknown }): boolean {
  const idempotencyKey = String(raw.idempotencyKey ?? "")
  if (idempotencyKey.startsWith("out-imessage-in-")) return false
  if (idempotencyKey.startsWith("out-sendblue-")) return false
  return true
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

  const ref = deps.db.collection(OUT).doc(docId)

  // ---- 2. Claim transactionally ----------------------------------------
  const claimed = await deps.db.runTransaction(async (t) => {
    const s = await (t.get as (r: typeof ref) => Promise<{ exists: boolean; data: () => unknown }>)(ref)
    if (!s.exists) return false
    const d = (s.data() ?? {}) as { status?: string }
    if (d.status !== "pending") return false
    t.update(ref as never, { status: "sending", updatedAt: now().toISOString() })
    return true
  })
  if (!claimed) return

  const userId = String(data.userId ?? "")
  const toPeerRaw = String(data.toE164 ?? "")
  const toPeer = toPeerRaw ? normalizePeer(toPeerRaw) : ""
  const body = String(data.body ?? "").trim()

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
        },
        { merge: true }
      )
      return
    }
  }

  if (!userId || !toPeer || !body) {
    await ref.set(
      {
        status: "failed",
        error: "missing userId, toE164, or body",
        updatedAt: now().toISOString(),
      },
      { merge: true }
    )
    return
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
        },
        { merge: true }
      )
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
    await ref.set({ status: "failed", error: `sendblue daily quota reached (${currentCount}/${quotaLimit})`, updatedAt: now().toISOString() }, { merge: true })
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
        },
        { merge: true }
      )
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
        },
        { merge: true }
      )
      return
    }
    log("[sendblue][outbox] unexpected error", err instanceof Error ? err.message : String(err))
    await ref.set(
      {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        updatedAt: now().toISOString(),
      },
      { merge: true }
    )
    return
  }
}
