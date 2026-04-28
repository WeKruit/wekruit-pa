/**
 * Phase 24.5 T3 — Firestore wrapper for pa_feature_flags + pa_audit_events.
 *
 * Schema (locked, see .planning/phases/24.5-feature-flag-infra/CONTEXT.md):
 *   pa_feature_flags/{key}: { key, value, type, scope, allowlist[], blocklist[],
 *                             updatedAt, updatedBy, reason, version }
 *   pa_audit_events:        { actor, action, key, oldValue, newValue, reason, ts }
 *
 * Auth: uses signed-in dashboard user (direct Firestore SDK, mirrors Abuse.tsx
 * pattern). T1 backend SDK exists in @pa/pa-persistence but may land after T3 —
 * this file implements client-side read/write directly so T3 compiles standalone.
 */
import { PA_COLLECTIONS } from "@pa/core-types"
import {
  Timestamp,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  where,
  writeBatch,
} from "firebase/firestore"
import { auth, db } from "./firebase.js"

export const FEATURE_FLAGS_COLLECTION = "pa_feature_flags"

export type FlagType = "bool" | "string" | "number" | "json"
export type FlagScope = "global" | "perEnv" | "perUser"
export type FlagValue = boolean | string | number | Record<string, unknown> | unknown[]

export type BucketMethod = "userIdHash" | "random"

export type BucketVariant = {
  name: string
  weight: number // 0..100
  value: FlagValue
}

export type BucketStrategy = {
  method: BucketMethod
  variants: BucketVariant[]
}

export type FeatureFlag = {
  key: string
  value: FlagValue
  type: FlagType
  scope: FlagScope
  allowlist: string[]
  blocklist: string[]
  bucketStrategy: BucketStrategy | null
  updatedAt: string | null
  updatedBy: string
  reason: string
  version: number
}

export type AuditAction = "flag.create" | "flag.update" | "flag.revert"

export type AuditEvent = {
  id: string
  actor: string
  action: AuditAction
  key: string
  oldValue: FlagValue | null
  newValue: FlagValue | null
  reason: string
  ts: string | null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tsToIso(value: unknown): string | null {
  if (!value) return null
  if (value instanceof Timestamp) return value.toDate().toISOString()
  if (typeof value === "string") return value
  if (
    typeof value === "object" &&
    value !== null &&
    "seconds" in (value as Record<string, unknown>)
  ) {
    const seconds = Number((value as { seconds: unknown }).seconds)
    if (Number.isFinite(seconds)) return new Date(seconds * 1000).toISOString()
  }
  return null
}

function currentActor(): string {
  const u = auth().currentUser
  return u?.email ?? u?.uid ?? "unknown"
}

function bucketStrategyFromRaw(raw: unknown): BucketStrategy | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const method = r.method
  if (method !== "userIdHash" && method !== "random") return null
  if (!Array.isArray(r.variants)) return null
  const variants: BucketVariant[] = []
  for (const v of r.variants) {
    if (!v || typeof v !== "object") continue
    const vv = v as Record<string, unknown>
    if (typeof vv.name !== "string") continue
    if (typeof vv.weight !== "number") continue
    variants.push({
      name: vv.name,
      weight: vv.weight,
      value: vv.value as FlagValue,
    })
  }
  if (variants.length === 0) return null
  return { method, variants }
}

function flagFromSnap(id: string, raw: Record<string, unknown>): FeatureFlag {
  return {
    key: (raw.key as string) ?? id,
    value: raw.value as FlagValue,
    type: ((raw.type as FlagType) ?? "bool"),
    scope: ((raw.scope as FlagScope) ?? "global"),
    allowlist: Array.isArray(raw.allowlist) ? (raw.allowlist as string[]) : [],
    blocklist: Array.isArray(raw.blocklist) ? (raw.blocklist as string[]) : [],
    bucketStrategy: bucketStrategyFromRaw(raw.bucketStrategy),
    updatedAt: tsToIso(raw.updatedAt),
    updatedBy: (raw.updatedBy as string) ?? "",
    reason: (raw.reason as string) ?? "",
    version: typeof raw.version === "number" ? raw.version : 0,
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listFlags(): Promise<FeatureFlag[]> {
  const snap = await getDocs(collection(db(), FEATURE_FLAGS_COLLECTION))
  return snap.docs.map((d) => flagFromSnap(d.id, d.data() as Record<string, unknown>))
}

export async function listAuditForKey(key: string, max = 20): Promise<AuditEvent[]> {
  const snap = await getDocs(
    query(
      collection(db(), PA_COLLECTIONS.auditEvents),
      where("key", "==", key),
      orderBy("ts", "desc"),
      limit(max)
    )
  )
  return snap.docs.map((d) => {
    const raw = d.data() as Record<string, unknown>
    return {
      id: d.id,
      actor: (raw.actor as string) ?? "unknown",
      action: (raw.action as AuditAction) ?? "flag.update",
      key: (raw.key as string) ?? key,
      oldValue: (raw.oldValue as FlagValue | null) ?? null,
      newValue: (raw.newValue as FlagValue | null) ?? null,
      reason: (raw.reason as string) ?? "",
      ts: tsToIso(raw.ts),
    }
  })
}

// ---------------------------------------------------------------------------
// Writes (always batched: flag doc + audit row)
// ---------------------------------------------------------------------------

export type SaveFlagInput = {
  key: string
  value: FlagValue
  type: FlagType
  scope: FlagScope
  allowlist: string[]
  blocklist: string[]
  reason: string
  /**
   * Optional A/B bucket strategy. Pass `null` to explicitly clear an existing
   * strategy; omit (undefined) to leave any prior value untouched.
   */
  bucketStrategy?: BucketStrategy | null
}

export async function saveFlag(input: SaveFlagInput): Promise<void> {
  const actor = currentActor()
  const flagRef = doc(db(), FEATURE_FLAGS_COLLECTION, input.key)
  const existing = await getDoc(flagRef)
  const prev = existing.exists()
    ? flagFromSnap(existing.id, existing.data() as Record<string, unknown>)
    : null

  const batch = writeBatch(db())
  const nextVersion = (prev?.version ?? 0) + 1

  // Validation parity with @pa/pa-persistence setFlag — keep dashboard
  // writes consistent with what the SDK would accept.
  if (input.bucketStrategy) {
    const sum = input.bucketStrategy.variants.reduce((s, v) => s + (Number(v.weight) || 0), 0)
    if (Math.abs(sum - 100) > 0.01) {
      throw new Error(`bucketStrategy variant weights must sum to 100, got ${sum}`)
    }
    if (input.bucketStrategy.variants.length === 0) {
      throw new Error("bucketStrategy.variants must be non-empty")
    }
  }

  // Resolve bucketStrategy persistence: explicit value wins, undefined keeps prev.
  const nextBucket: BucketStrategy | null =
    input.bucketStrategy !== undefined
      ? input.bucketStrategy
      : prev?.bucketStrategy ?? null

  batch.set(
    flagRef,
    {
      key: input.key,
      value: input.value,
      type: input.type,
      scope: input.scope,
      allowlist: input.allowlist,
      blocklist: input.blocklist,
      bucketStrategy: nextBucket,
      updatedAt: serverTimestamp(),
      updatedBy: actor,
      reason: input.reason,
      version: nextVersion,
    },
    { merge: true }
  )

  const auditRef = doc(collection(db(), PA_COLLECTIONS.auditEvents))
  batch.set(auditRef, {
    actor,
    action: prev ? "flag.update" : "flag.create",
    key: input.key,
    oldValue: prev?.value ?? null,
    newValue: input.value,
    reason: input.reason,
    ts: serverTimestamp(),
  })

  await batch.commit()
}

/**
 * Client-side revert fallback (server SDK arrives in T1).
 * Reads the most recent audit event for `key` whose action !== "flag.revert"
 * and writes its oldValue back as the current value, recording action=flag.revert.
 */
export async function revertFlag(key: string, reason: string): Promise<void> {
  const events = await listAuditForKey(key, 20)
  const target = events.find((e) => e.action !== "flag.revert")
  if (!target) {
    throw new Error(`No prior audit event found for ${key} — nothing to revert to.`)
  }
  if (target.oldValue === null || target.oldValue === undefined) {
    throw new Error(`Audit event ${target.id} has no oldValue — cannot revert.`)
  }

  const flagRef = doc(db(), FEATURE_FLAGS_COLLECTION, key)
  const existingSnap = await getDoc(flagRef)
  if (!existingSnap.exists()) {
    throw new Error(`Flag ${key} does not exist — cannot revert.`)
  }
  const existing = flagFromSnap(
    existingSnap.id,
    existingSnap.data() as Record<string, unknown>
  )

  const actor = currentActor()
  const batch = writeBatch(db())
  batch.set(
    flagRef,
    {
      value: target.oldValue,
      updatedAt: serverTimestamp(),
      updatedBy: actor,
      reason,
      version: existing.version + 1,
    },
    { merge: true }
  )

  const auditRef = doc(collection(db(), PA_COLLECTIONS.auditEvents))
  batch.set(auditRef, {
    actor,
    action: "flag.revert",
    key,
    oldValue: existing.value,
    newValue: target.oldValue,
    reason,
    ts: serverTimestamp(),
  })

  await batch.commit()
}
