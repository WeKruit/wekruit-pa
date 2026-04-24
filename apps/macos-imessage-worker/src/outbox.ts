import { IMessageError, IMessageSDK } from "@photon-ai/imessage-kit"
import { PA_COLLECTIONS } from "@pa/core-types"
import type { Firestore } from "firebase-admin/firestore"
import { appendMessage, getOrCreateSession, getUser, normalizeE164 } from "./persistence.js"
import { isSamePeer } from "./config.js"

const OUT = PA_COLLECTIONS.outbound

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

async function processOutboundJob(
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
  const toE164 = normalizeE164(String(raw.toE164 ?? ""))
  const body = String(raw.body ?? "").trim()
  const allowedTo = process.env.PA_OUTBOUND_ALLOWLIST_E164?.trim()
  if (allowedTo && !isSamePeer(toE164, allowedTo)) {
    log("[outbox] blocked by PA_OUTBOUND_ALLOWLIST_E164", docId, toE164)
    return
  }
  if (!userId || !toE164 || !body) {
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
    const session = await getOrCreateSession(db, user.id, "imessage", toE164)
    await appendMessage(db, {
      sessionId: session.id,
      userId: user.id,
      role: "user",
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
  }
}
