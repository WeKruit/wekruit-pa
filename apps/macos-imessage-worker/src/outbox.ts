import { IMessageError, IMessageSDK } from "@photon-ai/imessage-kit"
import { PA_COLLECTIONS } from "@pa/core-types"
import type { Firestore } from "firebase-admin/firestore"
import { appendMessage, getOrCreateSession, getUser, normalizeE164, normalizeImessageParticipant } from "./persistence.js"
import { isSamePeer } from "./config.js"
import type { LocalQueue } from "./local-queue.js"

const OUT = PA_COLLECTIONS.outbound
const OUTBOUND_LEASE_MS = Number(process.env.PA_OUTBOUND_LEASE_MS || "120000")

export function isOutboundLeaseExpired(leaseUntil: string | undefined, now = new Date()): boolean {
  if (!leaseUntil) return true
  const t = Date.parse(leaseUntil)
  return !Number.isFinite(t) || t <= now.getTime()
}

export function normalizeOutboundRecipient(raw: string): string {
  const value = raw.trim()
  if (!value) return ""
  return value.includes("@") ? normalizeImessageParticipant(value) : normalizeE164(value)
}

const KNOWN_FAKE_RECIPIENTS = new Set(["+19990000000", "+10000000000", "+1"])

/**
 * Hard guard: never send outbound unless the recipient has previously sent
 * us an inbound message. Hard-blocks known smoke-test placeholder numbers.
 * Disable with PA_OUTBOUND_SKIP_INBOUND_CHECK=1 (e.g. for cold-start tests).
 */
export async function isFakeOrUnknownRecipient(db: Firestore, toE164: string): Promise<boolean> {
  if (!toE164) return true
  if (KNOWN_FAKE_RECIPIENTS.has(toE164)) return true
  if (process.env.PA_OUTBOUND_SKIP_INBOUND_CHECK === "1") return false
  const snap = await db.collection(PA_COLLECTIONS.inboundEvents).where("from", "==", toE164).limit(1).get()
  return snap.empty
}

export function startOutboundListener(
  db: Firestore,
  sdk: IMessageSDK,
  log: (...args: unknown[]) => void,
  localQueue?: Pick<LocalQueue, "recordOutboundClaim" | "recordOutboundSent" | "recordOutboundFailed">
) {
  const ref = db
    .collection(OUT)
    .where("status", "==", "pending")
    .orderBy("createdAt", "asc")

  const reclaim = setInterval(() => {
    void reclaimExpiredOutbound(db, sdk, log, localQueue)
  }, Math.max(30_000, OUTBOUND_LEASE_MS))

  const unsubscribe = ref.onSnapshot(
    (snap) => {
      for (const change of snap.docChanges()) {
        if (change.type !== "added") continue
        const d = change.doc
        void processOutboundJob(db, sdk, log, d.id, d.data() as Record<string, unknown>, localQueue)
      }
    },
    (err) => log("[outbox] listener error", err)
  )
  return () => {
    clearInterval(reclaim)
    unsubscribe()
  }
}

export async function reclaimExpiredOutbound(
  db: Firestore,
  sdk: IMessageSDK,
  log: (...args: unknown[]) => void,
  localQueue?: Pick<LocalQueue, "recordOutboundClaim" | "recordOutboundSent" | "recordOutboundFailed">
) {
  const now = new Date()
  const snap = await db.collection(OUT).where("status", "==", "sending").limit(50).get()
  for (const d of snap.docs) {
    const raw = d.data() as Record<string, unknown>
    if (isOutboundLeaseExpired(typeof raw.leaseUntil === "string" ? raw.leaseUntil : undefined, now)) {
      log("[outbox] reclaim expired lease", d.id)
      void processOutboundJob(db, sdk, log, d.id, raw, localQueue)
    }
  }
}

async function processOutboundJob(
  db: Firestore,
  sdk: IMessageSDK,
  log: (...args: unknown[]) => void,
  docId: string,
  raw: Record<string, unknown>,
  localQueue?: Pick<LocalQueue, "recordOutboundClaim" | "recordOutboundSent" | "recordOutboundFailed">
) {
  const ref = db.collection(OUT).doc(docId)
  const claimed = await db.runTransaction(async (t) => {
    const s = await t.get(ref)
    if (!s.exists) return false
    const d = s.data() as { status?: string; attempts?: number; leaseUntil?: string }
    if (d.status !== "pending" && !(d.status === "sending" && isOutboundLeaseExpired(d.leaseUntil))) {
      return false
    }
    const now = new Date()
    t.update(ref, {
      status: "sending",
      attempts: (d.attempts ?? 0) + 1,
      claimedAt: now.toISOString(),
      leaseUntil: new Date(now.getTime() + OUTBOUND_LEASE_MS).toISOString(),
      updatedAt: now.toISOString(),
    })
    return true
  })
  if (!claimed) return

  const userId = String(raw.userId ?? "")
  const toE164 = normalizeOutboundRecipient(String(raw.toE164 ?? ""))
  const body = String(raw.body ?? "").trim()
  localQueue?.recordOutboundClaim({ outboundId: docId, userId, toE164, body })

  if (await isFakeOrUnknownRecipient(db, toE164)) {
    log("[outbox] blocked: recipient never sent us inbound (or is a known fake)", docId, toE164)
    await ref.set(
      { status: "failed", errorCode: "OUTBOUND_BLOCKED", error: "recipient has no prior inbound", updatedAt: new Date().toISOString() },
      { merge: true }
    )
    localQueue?.recordOutboundFailed(docId, "OUTBOUND_BLOCKED: recipient has no prior inbound")
    return
  }
  const allowedTo = process.env.PA_OUTBOUND_ALLOWLIST_E164?.trim()
  if (allowedTo && !isSamePeer(toE164, allowedTo)) {
    log("[outbox] blocked by PA_OUTBOUND_ALLOWLIST_E164", docId, toE164)
    await ref.set(
      { status: "failed", errorCode: "OUTBOUND_BLOCKED", error: "blocked by allowlist", updatedAt: new Date().toISOString() },
      { merge: true }
    )
    localQueue?.recordOutboundFailed(docId, "OUTBOUND_BLOCKED: blocked by allowlist")
    return
  }
  if (!userId || !toE164 || !body) {
    await ref.set(
      { status: "failed", error: "missing userId, toE164, or body", updatedAt: new Date().toISOString() },
      { merge: true }
    )
    localQueue?.recordOutboundFailed(docId, "missing userId, toE164, or body")
    return
  }

  const user = await getUser(db, userId)
  if (!user) {
    await ref.set(
      { status: "failed", error: "user not found", updatedAt: new Date().toISOString() },
      { merge: true }
    )
    localQueue?.recordOutboundFailed(docId, "user not found")
    return
  }

  const createdAt = new Date().toISOString()
  const role = raw.role === "user" || raw.role === "assistant" ? raw.role : "assistant"
  const providedSessionId = typeof raw.sessionId === "string" && raw.sessionId ? raw.sessionId : null

  try {
    const session = providedSessionId
      ? { id: providedSessionId, userId: user.id, externalChatId: toE164, channel: "imessage" as const }
      : await getOrCreateSession(db, user.id, "imessage", toE164)
    await appendMessage(db, {
      sessionId: session.id,
      userId: user.id,
      role,
      body,
      createdAt,
      idempotencyKey: `outbox-msg-${docId}`,
      rawMeta: { source: "pa_console_outbound", outboundDocId: docId },
    })
    try {
      await sdk.send({ to: toE164, text: body })
    } catch (e) {
      if (e instanceof IMessageError) {
        log("[outbox] send IMessageError", e.code, e.message)
        await ref.set(
          { status: "failed", errorCode: e.code, error: `${e.code}: ${e.message}`, updatedAt: new Date().toISOString() },
          { merge: true }
        )
        localQueue?.recordOutboundFailed(docId, `${e.code}: ${e.message}`)
        return
      }
      throw e
    }
    await ref.set({ status: "sent", leaseUntil: null, sentAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, { merge: true })
    localQueue?.recordOutboundSent(docId)
    log("[outbox] sent", docId, toE164)
  } catch (e) {
    log("[outbox] process error", e)
    await ref.set(
      {
        status: "failed",
        error: e instanceof Error ? e.message : String(e),
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    )
    localQueue?.recordOutboundFailed(docId, e instanceof Error ? e.message : String(e))
  }
}
