import { createHash, randomUUID } from "node:crypto"
import { FieldValue, type Firestore } from "firebase-admin/firestore"
import {
  PA_COLLECTIONS,
  type Channel,
  type InboundEventStatus,
  type PaInboundEvent,
} from "@pa/core-types"

const INBOUND = PA_COLLECTIONS.inboundEvents

export function inboundEventDocId(idempotencyKey: string): string {
  const h = createHash("sha256").update(idempotencyKey, "utf8").digest("hex")
  return `inb_${h.slice(0, 40)}`
}

export type CreateInboundEventInput = {
  channel: Channel
  idempotencyKey: string
  rawPayload: Record<string, unknown>
  correlationId?: string
  /**
   * v1.5 TD-A fix (2026-05-03 Adam P0 race-condition):
   *   When the SendBlue webhook KNOWS in advance that this inbound row will be
   *   handed to the message coalescer (paMessageCoalesceEnabled=true for the
   *   user, no media attachment, coalescer wired), it MUST stamp
   *   `coalescing: true` on the doc at create-time so the
   *   `onPaInbound` onDocumentCreated trigger sees a populated flag in the
   *   single read it does. Without this, the trigger races the post-create
   *   `coalescer.enqueueOrCoalesce` merge and processes the row as an
   *   independent turn — which is the RCA for Adam's "4 quick messages →
   *   4 turns" production incident.
   *
   *   Default-undefined keeps every other broker caller (test mode, admin,
   *   processCoalescedTurn synthesizing the merged event) byte-for-byte
   *   compatible — the field is only persisted when explicitly set true.
   */
  coalescing?: boolean
}

/**
 * Idempotent create: same idempotencyKey returns existing doc without overwriting.
 */
export async function createInboundEvent(
  db: Firestore,
  input: CreateInboundEventInput
): Promise<{ id: string; created: boolean; event: PaInboundEvent }> {
  const id = inboundEventDocId(input.idempotencyKey)
  const ref = db.collection(INBOUND).doc(id)
  const now = new Date().toISOString()
  const base: PaInboundEvent = {
    id,
    channel: input.channel,
    status: "pending",
    idempotencyKey: input.idempotencyKey,
    rawPayload: input.rawPayload,
    createdAt: now,
    attemptCount: 0,
    maxAttempts: 8,
    correlationId: input.correlationId ?? randomUUID(),
  }
  // TD-A: when the caller pre-decided this row will be coalesced, stamp the
  // flag on the SAME write that creates the doc. Cast to a permissive shape
  // because PaInboundEvent doesn't (intentionally) carry the coalescing
  // sentinel in its base typing — it's a transport flag the coalescer + the
  // onPaInbound trigger read defensively via `(data as { coalescing?: boolean })`.
  const writeBody: Record<string, unknown> =
    input.coalescing === true ? { ...base, coalescing: true } : { ...base }

  try {
    await ref.create(writeBody)
    return { id, created: true, event: base }
  } catch (e: unknown) {
    const code = (e as { code?: number })?.code
    if (code === 6) {
      // ALREADY_EXISTS
      const snap = await ref.get()
      const data = snap.data() as PaInboundEvent
      return { id, created: false, event: { ...data, id } }
    }
    throw e
  }
}

export type ClaimInboundOptions = {
  claimerId: string
  leaseMs: number
}

/**
 * Transactionally claim one inbound event: pending, or failed with retries left and expired lease.
 */
export async function tryClaimInboundEvent(
  db: Firestore,
  eventId: string,
  opts: ClaimInboundOptions
): Promise<PaInboundEvent | null> {
  const ref = db.collection(INBOUND).doc(eventId)
  const leaseUntil = new Date(Date.now() + opts.leaseMs).toISOString()
  const now = new Date().toISOString()

  return db.runTransaction(async (t) => {
    const snap = await t.get(ref)
    if (!snap.exists) return null
    const cur = snap.data() as PaInboundEvent
    const status = cur.status as InboundEventStatus
    const attempts = cur.attemptCount ?? 0
    const max = cur.maxAttempts ?? 8

    if (status === "completed" || status === "dead_letter") return null

    if (status === "processing") {
      const lease = cur.leaseUntil
      if (lease && lease > now) return null
    }

    if (status === "failed") {
      if (attempts >= max) return null
      const lease = cur.leaseUntil
      if (lease && lease > now) return null
    }

    if (status !== "pending" && status !== "processing" && status !== "failed") return null

    t.update(ref, {
      status: "processing",
      claimedBy: opts.claimerId,
      leaseUntil,
      updatedAt: now,
    })
    const next: PaInboundEvent = {
      ...cur,
      id: eventId,
      status: "processing",
      claimedBy: opts.claimerId,
      leaseUntil,
      updatedAt: now,
    }
    return next
  })
}

/** Peek next claimable inbound ids (best-effort; claim still must be transactional). */
export async function listClaimableInboundIds(db: Firestore, limit = 10): Promise<string[]> {
  const now = new Date().toISOString()
  const pending = await db
    .collection(INBOUND)
    .where("status", "==", "pending")
    .orderBy("createdAt", "asc")
    .limit(limit)
    .get()

  const ids = pending.docs.map((d) => d.id)

  const failed = await db
    .collection(INBOUND)
    .where("status", "==", "failed")
    .orderBy("createdAt", "asc")
    .limit(limit)
    .get()

  for (const d of failed.docs) {
    const cur = d.data() as PaInboundEvent
    const attempts = cur.attemptCount ?? 0
    const max = cur.maxAttempts ?? 8
    if (attempts >= max) continue
    const lease = cur.leaseUntil
    if (lease && lease > now) continue
    ids.push(d.id)
  }

  const processing = await db
    .collection(INBOUND)
    .where("status", "==", "processing")
    .orderBy("createdAt", "asc")
    .limit(limit)
    .get()

  for (const d of processing.docs) {
    const cur = d.data() as PaInboundEvent
    const lease = cur.leaseUntil
    if (lease && lease > now) continue
    ids.push(d.id)
  }

  return [...new Set(ids)]
}

export async function completeInboundEvent(
  db: Firestore,
  eventId: string,
  patch: { userId?: string; sessionId?: string; agentTurnId?: string }
) {
  const ref = db.collection(INBOUND).doc(eventId)
  const now = new Date().toISOString()
  await ref.set(
    {
      status: "completed",
      updatedAt: now,
      leaseUntil: null,
      claimedBy: null,
      lastError: FieldValue.delete(),
      deadLetterReason: FieldValue.delete(),
      ...patch,
    } as Record<string, unknown>,
    { merge: true }
  )
}

export async function failInboundEvent(
  db: Firestore,
  eventId: string,
  err: string,
  opts?: { bumpAttempt?: boolean }
) {
  const ref = db.collection(INBOUND).doc(eventId)
  await db.runTransaction(async (t) => {
    const snap = await t.get(ref)
    if (!snap.exists) return
    const cur = snap.data() as PaInboundEvent
    const attempts = (cur.attemptCount ?? 0) + (opts?.bumpAttempt !== false ? 1 : 0)
    const max = cur.maxAttempts ?? 8
    const now = new Date().toISOString()
    if (attempts >= max) {
      t.update(ref, {
        status: "dead_letter",
        deadLetterReason: err,
        attemptCount: attempts,
        lastError: err,
        updatedAt: now,
        leaseUntil: null,
        claimedBy: null,
      } as Record<string, unknown>)
      return
    }
    t.update(ref, {
      status: "failed",
      lastError: err,
      attemptCount: attempts,
      updatedAt: now,
      leaseUntil: null,
      claimedBy: null,
    } as Record<string, unknown>)
  })
}

export async function getInboundEvent(db: Firestore, eventId: string): Promise<PaInboundEvent | null> {
  const s = await db.collection(INBOUND).doc(eventId).get()
  if (!s.exists) return null
  return { id: s.id, ...s.data() } as PaInboundEvent
}
