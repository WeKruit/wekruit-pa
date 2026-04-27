/**
 * paSendblueOutbox CF — pa_outbound → Sendblue REST POST (D-05).
 *
 * Trigger: onDocumentCreated("pa_outbound/{docId}", handler) AND on
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
import { sendTypingIndicator as defaultSendTypingIndicator } from "./typing-indicator.js"
import type { SendblueSendResponse } from "./types.js"

const OUT = PA_COLLECTIONS.outbound

export function shouldAppendOutboundTranscript(raw: { idempotencyKey?: unknown }): boolean {
  const idempotencyKey = String(raw.idempotencyKey ?? "")
  if (idempotencyKey.startsWith("out-imessage-in-")) return false
  if (idempotencyKey.startsWith("out-sendblue-")) return false
  return true
}

export function isLegacyChannelEnabled(): boolean {
  return process.env.PA_CHANNEL_LEGACY === "1"
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
  appendMessage?: (db: Firestore, input: Record<string, unknown>) => Promise<unknown>
  getUser?: (db: Firestore, userId: string) => Promise<{ id: string } | null>
  getOrCreateSession?: (
    db: Firestore,
    userId: string,
    channel: string,
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

  // ---- 1. Legacy guard (D-08) -------------------------------------------
  if (isLegacyChannelEnabled()) {
    log("[sendblue][outbox] PA_CHANNEL_LEGACY=1 — releasing to macOS worker", { docId })
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
      const session = await deps.getOrCreateSession(deps.db, userId, "imessage", toPeer)
      await deps.appendMessage(deps.db, {
        sessionId: session.id,
        userId,
        role: "user",
        body,
        createdAt: now().toISOString(),
        idempotencyKey: `outbox-msg-${docId}`,
        rawMeta: { source: "pa_console_outbound", outboundDocId: docId },
      })
    } catch (err) {
      log(
        "[sendblue][outbox] transcript append failed (non-fatal)",
        err instanceof Error ? err.message : String(err)
      )
    }
  }

  // ---- 5. Optional typing indicator (D-06) -----------------------------
  if (isTypingIndicatorEnabled()) {
    try {
      await deps.sendblueClient.sendTypingIndicator({ to: toPeer })
    } catch {
      // Already best-effort inside the helper; defensive double-swallow.
    }
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
    log("[sendblue][outbox] sent", { docId, toPeer, messageHandle })
    return
  } catch (err) {
    if (err instanceof SendblueClientError) {
      log("[sendblue][outbox] 4xx — failed", { docId, status: err.status, message: err.message })
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
