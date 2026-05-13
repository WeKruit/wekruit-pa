import { createHash } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"

export const OUTREACH_CAPACITY_COLLECTION = "pa-outreach-capacity-daily"

export type OutreachCapacityStatus =
  | "active"
  | "warmup"
  | "throttled"
  | "paused"
  | "degraded"

export interface OutreachCapacitySnapshot {
  groupId: string
  fromNumber?: string
  status: OutreachCapacityStatus
  dailyCap: number | null
  usedToday: number
  remainingToday: number
  checkedAt: string
  reason?: string
}

export interface ReserveOutreachCapacityInput {
  groupId: string
  status: OutreachCapacityStatus
  dailyCap: number | null
  fromNumber?: string
  date?: Date
  dryRun?: boolean
  reservationKey?: string
}

export interface ReserveOutreachCapacityResult {
  ok: boolean
  reserved: boolean
  reason?: string
  snapshot: OutreachCapacitySnapshot
}

/** Format `YYYYMMDD` UTC bucket id from a Date. */
export function formatOutreachCapacityBucket(date: Date = new Date()): string {
  const y = date.getUTCFullYear().toString().padStart(4, "0")
  const m = (date.getUTCMonth() + 1).toString().padStart(2, "0")
  const d = date.getUTCDate().toString().padStart(2, "0")
  return `${y}${m}${d}`
}

export function createOutreachCapacityDocId(groupId: string, date: Date = new Date()): string {
  const bucket = formatOutreachCapacityBucket(date)
  const groupHash = createHash("sha256").update(groupId).digest("hex").slice(0, 32)
  return `${bucket}_${groupHash}`
}

function normalizeCap(cap: number | null): number | null {
  if (cap === null) return null
  const n = Number(cap)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.floor(n)
}

function normalizeUsed(value: unknown): number {
  const n = Number(value ?? 0)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.floor(n)
}

function reservationHash(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function blockReason(status: OutreachCapacityStatus, dailyCap: number | null, usedToday: number): string | null {
  if (status === "warmup") return "warmup_requires_hitl"
  if (status !== "active") return `group_${status}`
  if (dailyCap === null) return "missing_or_invalid_capacity"
  if (usedToday >= dailyCap) return "capacity_full"
  return null
}

function buildSnapshot(input: {
  groupId: string
  fromNumber?: string
  status: OutreachCapacityStatus
  dailyCap: number | null
  usedToday: number
  checkedAt: Date
  reason?: string
}): OutreachCapacitySnapshot {
  const dailyCap = normalizeCap(input.dailyCap)
  return {
    groupId: input.groupId,
    fromNumber: input.fromNumber,
    status: input.status,
    dailyCap,
    usedToday: input.usedToday,
    remainingToday: dailyCap === null ? 0 : Math.max(0, dailyCap - input.usedToday),
    checkedAt: input.checkedAt.toISOString(),
    reason: input.reason,
  }
}

export async function getOutreachCapacitySnapshot(
  db: Firestore,
  input: Omit<ReserveOutreachCapacityInput, "dryRun">
): Promise<OutreachCapacitySnapshot> {
  const date = input.date ?? new Date()
  const docId = createOutreachCapacityDocId(input.groupId, date)
  const snap = await db.collection(OUTREACH_CAPACITY_COLLECTION).doc(docId).get()
  const usedToday = snap.exists ? normalizeUsed((snap.data() as { count?: unknown } | undefined)?.count) : 0
  const dailyCap = normalizeCap(input.dailyCap)
  const reason = blockReason(input.status, dailyCap, usedToday) ?? undefined
  return buildSnapshot({
    groupId: input.groupId,
    fromNumber: input.fromNumber,
    status: input.status,
    dailyCap,
    usedToday,
    checkedAt: date,
    reason,
  })
}

export async function reserveOutreachCapacity(
  db: Firestore,
  input: ReserveOutreachCapacityInput
): Promise<ReserveOutreachCapacityResult> {
  if (input.dryRun) {
    const snapshot = await getOutreachCapacitySnapshot(db, input)
    return {
      ok: !snapshot.reason,
      reserved: false,
      reason: snapshot.reason,
      snapshot,
    }
  }

  const date = input.date ?? new Date()
  const docId = createOutreachCapacityDocId(input.groupId, date)
  const ref = db.collection(OUTREACH_CAPACITY_COLLECTION).doc(docId)
  const bucket = formatOutreachCapacityBucket(date)
  const dailyCap = normalizeCap(input.dailyCap)
  const nowIso = date.toISOString()
  const expiresAt = new Date(date.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()

  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    const prev = snap.exists ? ((snap.data() as { count?: unknown }) ?? {}) : {}
    const reservations =
      prev && typeof (prev as { reservations?: unknown }).reservations === "object" && (prev as { reservations?: unknown }).reservations !== null
        ? (prev as { reservations: Record<string, unknown> }).reservations
        : {}
    const reservationId = input.reservationKey ? reservationHash(input.reservationKey) : undefined
    const usedToday = normalizeUsed(prev.count)
    if (reservationId && reservations[reservationId] === true) {
      const snapshot = buildSnapshot({
        groupId: input.groupId,
        fromNumber: input.fromNumber,
        status: input.status,
        dailyCap,
        usedToday,
        checkedAt: date,
      })
      return { ok: true, reserved: false, snapshot }
    }
    const reason = blockReason(input.status, dailyCap, usedToday) ?? undefined
    if (reason) {
      return {
        ok: false,
        reserved: false,
        reason,
        snapshot: buildSnapshot({
          groupId: input.groupId,
          fromNumber: input.fromNumber,
          status: input.status,
          dailyCap,
          usedToday,
          checkedAt: date,
          reason,
        }),
      }
    }

    const next = usedToday + 1
    const payload = {
      bucket,
      groupId: input.groupId,
      groupHash: createHash("sha256").update(input.groupId).digest("hex"),
      count: next,
      lastReservedAt: nowIso,
      expiresAt,
      ...(reservationId ? { reservations: { ...reservations, [reservationId]: true } } : {}),
    }
    if (snap.exists) {
      tx.update(ref, payload)
    } else {
      tx.set(ref, payload)
    }

    const snapshot = buildSnapshot({
      groupId: input.groupId,
      fromNumber: input.fromNumber,
      status: input.status,
      dailyCap,
      usedToday: next,
      checkedAt: date,
    })
    return { ok: true, reserved: true, snapshot }
  })
}
