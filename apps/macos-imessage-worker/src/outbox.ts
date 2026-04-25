import { IMessageError, IMessageSDK } from "@photon-ai/imessage-kit"
import { PA_COLLECTIONS } from "@pa/core-types"
import type { Firestore } from "firebase-admin/firestore"
import { appendMessage, getOrCreateSession, getUser, normalizeE164 } from "@pa/pa-persistence"
import { isSamePeer } from "./config.js"

const OUT = PA_COLLECTIONS.outbound

export function shouldAppendOutboundTranscript(raw: { idempotencyKey?: unknown }) {
  const idempotencyKey = String(raw.idempotencyKey ?? "")
  return !idempotencyKey.startsWith("out-imessage-in-")
}

export function normalizeOutboundPeer(raw: string): string {
  const value = raw.trim()
  if (!value) return ""
  if (value.includes("@")) return value.toLowerCase()
  return normalizeE164(value)
}

export function startOutboundListener(
  db: Firestore,
  sdk: IMessageSDK,
  log: (...args: unknown[]) => void
) {
  const ref = db
    .collection(OUT)
    .where("status", "==", "pending")
    .orderBy("createdAt", "asc")

  return ref.onSnapshot(
    (snap) => {
      for (const change of snap.docChanges()) {
        if (change.type !== "added") continue
        const d = change.doc
        void processOutboundJob(db, sdk, log, d.id, d.data() as Record<string, unknown>)
      }
    },
    (err) => log("[outbox] listener error", err)
  )
}

export async function processOutboundJob(
  db: Firestore,
  sdk: IMessageSDK,
  log: (...args: unknown[]) => void,
  docId: string,
  raw: Record<string, unknown>
) {
  const ref = db.collection(OUT).doc(docId)
  const claimed = await db.runTransaction(async (t) => {
    const s = await t.get(ref)
    if (!s.exists) return false
    const d = s.data() as { status?: string }
    if (d.status !== "pending") return false
    t.update(ref, { status: "sending", updatedAt: new Date().toISOString() })
    return true
  })
  if (!claimed) return

  const userId = String(raw.userId ?? "")
  const toPeer = normalizeOutboundPeer(String(raw.toE164 ?? ""))
  const imessageChatId = String(raw.imessageChatId ?? "").trim()
  const body = String(raw.body ?? "").trim()
  const allowedTo = process.env.PA_OUTBOUND_ALLOWLIST_E164?.trim()
  if (allowedTo && !isSamePeer(toPeer, allowedTo)) {
    log("[outbox] blocked by PA_OUTBOUND_ALLOWLIST_E164", docId, toPeer)
    await ref.set(
      {
        status: "failed",
        error: "blocked by PA_OUTBOUND_ALLOWLIST_E164",
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    )
    return
  }
  if (!userId || !toPeer || !body) {
    await ref.set(
      { status: "failed", error: "missing userId, toE164, or body", updatedAt: new Date().toISOString() },
      { merge: true }
    )
    return
  }

  const user = await getUser(db, userId)
  if (!user) {
    await ref.set(
      { status: "failed", error: "user not found", updatedAt: new Date().toISOString() },
      { merge: true }
    )
    return
  }

  const createdAt = new Date().toISOString()

  try {
    const session = await getOrCreateSession(db, user.id, "imessage", toPeer)
    if (shouldAppendOutboundTranscript(raw)) {
      await appendMessage(db, {
        sessionId: session.id,
        userId: user.id,
        role: "user",
        body,
        createdAt,
        idempotencyKey: `outbox-msg-${docId}`,
        rawMeta: { source: "pa_console_outbound", outboundDocId: docId },
      })
    }
    try {
      await sdk.send({ to: imessageChatId || toPeer, text: body })
    } catch (e) {
      if (e instanceof IMessageError) {
        log("[outbox] send IMessageError", e.code, e.message)
        await ref.set(
          {
            status: "failed",
            error: `${e.code}: ${e.message}`,
            updatedAt: new Date().toISOString(),
          },
          { merge: true }
        )
        return
      }
      throw e
    }
    await ref.set(
      { status: "sent", sentAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      { merge: true }
    )
    log("[outbox] sent", docId, toPeer)
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
  }
}

export async function reclaimStuckOutboundJobs(
  db: Firestore,
  opts: { olderThanIso: string; limit?: number }
): Promise<string[]> {
  const snap = await db
    .collection(OUT)
    .where("status", "==", "sending")
    .limit(opts.limit ?? 50)
    .get()
  const reclaimed: string[] = []
  for (const d of snap.docs) {
    const row = d.data() as { updatedAt?: string }
    if (row.updatedAt && row.updatedAt > opts.olderThanIso) continue
    await db.collection(OUT).doc(d.id).set(
      {
        status: "pending",
        error: "reclaimed from stuck sending",
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    )
    reclaimed.push(d.id)
  }
  return reclaimed
}
