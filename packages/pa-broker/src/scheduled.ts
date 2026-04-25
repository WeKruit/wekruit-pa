import { randomUUID } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"
import { FieldValue } from "firebase-admin/firestore"
import { PA_COLLECTIONS, type RuntimeHeartbeat, type ScheduledJob } from "@pa/core-types"

const JOBS = PA_COLLECTIONS.scheduledJobs
const HEARTBEATS = PA_COLLECTIONS.runtimeHeartbeats

function nowIso() {
  return new Date().toISOString()
}

export async function enqueueScheduledJob(
  db: Firestore,
  input: {
    kind: string
    dueAt: string
    payload?: Record<string, unknown>
    maxAttempts?: number
    backoffMs?: number
    id?: string
  }
): Promise<ScheduledJob> {
  const id = input.id ?? randomUUID()
  const job: ScheduledJob = {
    id,
    kind: input.kind,
    dueAt: input.dueAt,
    payload: input.payload ?? {},
    status: "pending",
    attemptCount: 0,
    maxAttempts: input.maxAttempts ?? 5,
    backoffMs: input.backoffMs ?? 60_000,
    createdAt: nowIso(),
  }
  await db.collection(JOBS).doc(id).create(job)
  return job
}

export async function listDueScheduledJobIds(
  db: Firestore,
  opts: { nowIso?: string; limit?: number } = {}
): Promise<string[]> {
  const now = opts.nowIso ?? nowIso()
  const snap = await db.collection(JOBS).where("status", "==", "pending").limit(opts.limit ?? 50).get()
  return snap.docs
    .map((d) => ({ ...(d.data() as ScheduledJob), id: d.id }))
    .filter((job) => job.dueAt <= now)
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
    .map((job) => job.id)
}

export async function tryClaimScheduledJob(
  db: Firestore,
  id: string,
  opts: { claimerId: string; leaseMs?: number }
): Promise<ScheduledJob | null> {
  const ref = db.collection(JOBS).doc(id)
  const leaseUntil = new Date(Date.now() + (opts.leaseMs ?? 5 * 60_000)).toISOString()
  return db.runTransaction(async (t) => {
    const snap = await t.get(ref)
    if (!snap.exists) return null
    const cur = snap.data() as ScheduledJob
    if (cur.status !== "pending") return null
    const next = { ...cur, status: "processing" as const, claimedBy: opts.claimerId, leaseUntil, updatedAt: nowIso() }
    t.update(ref, next)
    return next
  })
}

export async function completeScheduledJob(db: Firestore, id: string) {
  await db.collection(JOBS).doc(id).set(
    {
      status: "completed",
      claimedBy: null,
      leaseUntil: null,
      lastError: FieldValue.delete(),
      updatedAt: nowIso(),
    },
    { merge: true }
  )
}

export async function failScheduledJob(db: Firestore, id: string, error: string) {
  const ref = db.collection(JOBS).doc(id)
  await db.runTransaction(async (t) => {
    const snap = await t.get(ref)
    if (!snap.exists) return
    const cur = snap.data() as ScheduledJob
    const attemptCount = (cur.attemptCount ?? 0) + 1
    const exhausted = attemptCount >= (cur.maxAttempts ?? 5)
    t.update(ref, {
      status: exhausted ? "dead_letter" : "pending",
      attemptCount,
      dueAt: exhausted ? cur.dueAt : new Date(Date.now() + (cur.backoffMs ?? 60_000) * attemptCount).toISOString(),
      lastError: error,
      claimedBy: null,
      leaseUntil: null,
      updatedAt: nowIso(),
    })
  })
}

export async function writeRuntimeHeartbeat(db: Firestore, input: Omit<RuntimeHeartbeat, "id" | "lastSeenAt">) {
  const id = `${input.kind}_${input.runtimeId}`
  await db.collection(HEARTBEATS).doc(id).set(
    {
      id,
      ...input,
      lastSeenAt: nowIso(),
    },
    { merge: true }
  )
}

export async function listStaleHeartbeats(
  db: Firestore,
  opts: { olderThanIso: string; limit?: number }
): Promise<RuntimeHeartbeat[]> {
  const snap = await db.collection(HEARTBEATS).limit(opts.limit ?? 100).get()
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }) as RuntimeHeartbeat)
    .filter((heartbeat) => heartbeat.lastSeenAt < opts.olderThanIso)
}
