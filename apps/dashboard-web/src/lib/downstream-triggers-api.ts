/**
 * Phase 30 T3 — Firestore client wrapper for `pa-downstream-triggers` +
 * `pa-trigger-fires`. Mirrors the flags-api pattern: direct Firestore SDK
 * with admin-user auth via the dashboard.
 *
 * Schema (locked, see packages/pa-persistence/src/triggers.ts):
 *   pa-downstream-triggers/{triggerId}: {
 *     triggerId, name, description, enabled,
 *     condition: { kind: "keyword"|"llm-judge", config },
 *     endpoint: { url, method, headers?, hmacSecretRef? },
 *     payloadTemplate, cooldownSec,
 *     createdAt, updatedAt, updatedBy, version
 *   }
 *   pa-trigger-fires/{triggerId_userIdHash}: {
 *     triggerId, userId, lastFiredAt, httpStatus, errorMsg, conversationId?
 *   }
 *   pa-audit-events: { actor, action, key, oldValue, newValue, reason, ts }
 *
 * Audit semantics: `saveTrigger` writes a `trigger.update` (or
 * `trigger.create`) row in pa-audit-events on every save.
 */

import {
  Timestamp,
  collection,
  doc,
  getDoc,
  getDocs,
  limit as fbLimit,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
} from "firebase/firestore"
import { auth, db } from "./firebase.js"

export const TRIGGERS_COLLECTION = "pa-downstream-triggers"
export const TRIGGER_FIRES_COLLECTION = "pa-trigger-fires"
export const AUDIT_COLLECTION = "pa-audit-events"

// ---------------------------------------------------------------------------
// Types — mirror packages/pa-persistence/src/triggers.ts
// ---------------------------------------------------------------------------

export type TriggerConditionKind = "keyword" | "llm-judge"

export type KeywordConditionConfig = { pattern: string; flags?: string }
export type LlmJudgeConditionConfig = { judgePrompt: string; judgeModel?: string }

export type TriggerCondition =
  | { kind: "keyword"; config: KeywordConditionConfig }
  | { kind: "llm-judge"; config: LlmJudgeConditionConfig }

export type TriggerEndpoint = {
  url: string
  method?: "POST"
  headers?: Record<string, string>
  hmacSecretRef?: string
}

export type Trigger = {
  triggerId: string
  name: string
  description?: string
  enabled: boolean
  condition: TriggerCondition
  endpoint: TriggerEndpoint
  payloadTemplate: string
  cooldownSec: number
  createdAt?: string
  updatedAt?: string
  updatedBy?: string
  version?: number
}

export type TriggerFireRow = {
  triggerId: string
  userId: string
  firedAt: string
  httpStatus: number | null
  errorMsg: string | null
  conversationId?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tsToIso(v: unknown): string | undefined {
  if (!v) return undefined
  if (v instanceof Timestamp) return v.toDate().toISOString()
  if (typeof v === "string") return v
  return undefined
}

function currentActor(): string {
  const u = auth().currentUser
  return u?.email ?? u?.uid ?? "unknown"
}

function triggerFromSnap(id: string, raw: Record<string, unknown>): Trigger {
  const condRaw = (raw.condition ?? { kind: "keyword", config: {} }) as Record<string, unknown>
  const condition: TriggerCondition =
    condRaw.kind === "llm-judge"
      ? {
          kind: "llm-judge",
          config: (condRaw.config as LlmJudgeConditionConfig) ?? { judgePrompt: "" },
        }
      : {
          kind: "keyword",
          config: (condRaw.config as KeywordConditionConfig) ?? { pattern: "" },
        }
  const epRaw = (raw.endpoint ?? { url: "" }) as Record<string, unknown>
  return {
    triggerId: (raw.triggerId as string) ?? id,
    name: (raw.name as string) ?? id,
    description: raw.description as string | undefined,
    enabled: Boolean(raw.enabled),
    condition,
    endpoint: {
      url: (epRaw.url as string) ?? "",
      method: (epRaw.method as "POST") ?? "POST",
      headers: epRaw.headers as Record<string, string> | undefined,
      hmacSecretRef: epRaw.hmacSecretRef as string | undefined,
    },
    payloadTemplate: (raw.payloadTemplate as string) ?? "",
    cooldownSec: typeof raw.cooldownSec === "number" ? (raw.cooldownSec as number) : 60,
    createdAt: tsToIso(raw.createdAt),
    updatedAt: tsToIso(raw.updatedAt),
    updatedBy: raw.updatedBy as string | undefined,
    version: typeof raw.version === "number" ? (raw.version as number) : 0,
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listDownstreamTriggers(): Promise<Trigger[]> {
  const snap = await getDocs(collection(db(), TRIGGERS_COLLECTION))
  return snap.docs.map((d) => triggerFromSnap(d.id, d.data() as Record<string, unknown>))
}

export async function getDownstreamTrigger(triggerId: string): Promise<Trigger | null> {
  const ref = doc(db(), TRIGGERS_COLLECTION, triggerId)
  const snap = await getDoc(ref)
  if (!snap.exists()) return null
  return triggerFromSnap(snap.id, snap.data() as Record<string, unknown>)
}

export async function listTriggerFires(triggerId: string, max = 50): Promise<TriggerFireRow[]> {
  const snap = await getDocs(
    query(
      collection(db(), TRIGGER_FIRES_COLLECTION),
      where("triggerId", "==", triggerId),
      fbLimit(max)
    )
  )
  return snap.docs.map((d) => {
    const raw = d.data() as Record<string, unknown>
    return {
      triggerId: (raw.triggerId as string) ?? triggerId,
      userId: (raw.userId as string) ?? "",
      firedAt: tsToIso(raw.lastFiredAt) ?? "",
      httpStatus: typeof raw.httpStatus === "number" ? (raw.httpStatus as number) : null,
      errorMsg: typeof raw.errorMsg === "string" ? (raw.errorMsg as string) : null,
      conversationId: raw.conversationId as string | undefined,
    }
  })
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Create or update a trigger doc. Validates https url + non-negative cooldown
 * client-side (server rules should re-validate). Bumps version monotonically.
 * Writes a trigger.create / trigger.update audit row in the same batch.
 */
export async function saveDownstreamTrigger(t: Trigger): Promise<void> {
  if (!t.triggerId) throw new Error("triggerId required")
  if (!t.name?.trim()) throw new Error("name required")
  if (!t.endpoint?.url) throw new Error("endpoint.url required")
  if (!/^https:\/\//.test(t.endpoint.url)) throw new Error("endpoint.url must be https://")
  if (t.endpoint.url.length > 2048) throw new Error("endpoint.url too long")
  if (typeof t.cooldownSec !== "number" || t.cooldownSec < 0) {
    throw new Error("cooldownSec must be a non-negative number")
  }
  const ref = doc(db(), TRIGGERS_COLLECTION, t.triggerId)
  const auditRef = doc(collection(db(), AUDIT_COLLECTION))
  const cur = await getDoc(ref)
  const prev = cur.exists() ? (cur.data() as Trigger) : null
  const version = (prev?.version ?? 0) + 1
  const action: "trigger.create" | "trigger.update" = prev ? "trigger.update" : "trigger.create"
  const now = new Date().toISOString()
  const next: Trigger = {
    ...t,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
    updatedBy: currentActor(),
    version,
  }
  const batch = writeBatch(db())
  batch.set(ref, next as unknown as Record<string, unknown>)
  batch.set(auditRef, {
    actor: currentActor(),
    action,
    key: t.triggerId,
    newValue: next as unknown as Record<string, unknown>,
    oldValue: prev as unknown as Record<string, unknown> | null,
    reason: "dashboard",
    ts: serverTimestamp(),
  })
  await batch.commit()
}

/** Toggle the `enabled` field on a trigger. Bumps version + writes audit. */
export async function setDownstreamTriggerEnabled(triggerId: string, enabled: boolean): Promise<void> {
  const cur = await getDownstreamTrigger(triggerId)
  if (!cur) throw new Error(`Trigger ${triggerId} not found`)
  await saveDownstreamTrigger({ ...cur, enabled })
}

export function newTriggerId(): string {
  // Browser-friendly uuid; slug-safe.
  const r =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "")
      : Math.random().toString(36).slice(2)
  return `trig_${r.slice(0, 16)}`
}
