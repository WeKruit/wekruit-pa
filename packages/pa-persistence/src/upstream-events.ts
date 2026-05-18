/**
 * Phase 31 T1 — Upstream Event Connector schema + helpers.
 *
 * Stores `pa-upstream-templates/{templateId}` policy docs that the
 * paUpstreamEventWebhook CF (T2) looks up by `eventKind` to decide routing,
 * rate limits, and runtime handoff eligibility.
 *
 * Schema (LOCKED — change requires P9 review):
 *   templateId         (string, doc id)
 *   name               (string, human label)
 *   description        (string)
 *   eventKind          (string, queryable; e.g. "interview_scheduled")
 *   channel            (string, "imessage" default)
 *   rateLimitPerHour   (number, max fires per (templateId, userId) per hour)
 *   enabled            (boolean)
 *   updatedAt          (ISO string)
 *   updatedBy          (string)
 *   version            (number, monotonic)
 *
 * Rate limit storage: `pa-upstream-fires/{templateId}_{userId}_{hourBucket}`
 * with `{ count, expiresAt, ... }` — TTL-eligible expiresAt mirrors
 * pa-rate-limit conventions.
 */

import type { Firestore } from "firebase-admin/firestore"

export const UPSTREAM_TEMPLATES_COLLECTION = "pa-upstream-templates"
export const UPSTREAM_FIRES_COLLECTION = "pa-upstream-fires"

export interface UpstreamTemplate {
  templateId: string
  name: string
  description: string
  eventKind: string
  channel: string
  rateLimitPerHour: number
  enabled: boolean
  updatedAt?: string
  updatedBy?: string
  version?: number
}

export interface SaveUpstreamTemplateInput {
  templateId: string
  name: string
  description?: string
  eventKind: string
  channel?: string
  rateLimitPerHour?: number
  enabled?: boolean
  updatedBy: string
}

export async function listTemplates(db: Firestore): Promise<UpstreamTemplate[]> {
  const snap = await db.collection(UPSTREAM_TEMPLATES_COLLECTION).get()
  return snap.docs.map((d) => ({ templateId: d.id, ...(d.data() as Omit<UpstreamTemplate, "templateId">) }))
}

export async function getTemplate(
  db: Firestore,
  templateId: string
): Promise<UpstreamTemplate | null> {
  const snap = await db.collection(UPSTREAM_TEMPLATES_COLLECTION).doc(templateId).get()
  if (!snap.exists) return null
  return { templateId: snap.id, ...(snap.data() as Omit<UpstreamTemplate, "templateId">) }
}

/**
 * Look up a template by `eventKind`. Returns the first enabled match (a
 * caller-defined ordering invariant — typically there's one template per
 * eventKind). Returns null if no doc matches OR no matching doc is enabled.
 */
export async function getTemplateByEventKind(
  db: Firestore,
  eventKind: string
): Promise<UpstreamTemplate | null> {
  const snap = await db
    .collection(UPSTREAM_TEMPLATES_COLLECTION)
    .where("eventKind", "==", eventKind)
    .limit(5)
    .get()
  if (snap.empty) return null
  for (const d of snap.docs) {
    const data = d.data() as Omit<UpstreamTemplate, "templateId">
    if (data.enabled) {
      return { templateId: d.id, ...data }
    }
  }
  return null
}

export async function saveTemplate(
  db: Firestore,
  input: SaveUpstreamTemplateInput
): Promise<UpstreamTemplate> {
  const ref = db.collection(UPSTREAM_TEMPLATES_COLLECTION).doc(input.templateId)
  const existing = await ref.get()
  const prevVersion =
    existing.exists && typeof (existing.data() as { version?: unknown })?.version === "number"
      ? Number((existing.data() as { version: number }).version)
      : 0
  const doc: UpstreamTemplate = {
    templateId: input.templateId,
    name: input.name,
    description: input.description ?? "",
    eventKind: input.eventKind,
    channel: input.channel ?? "imessage",
    rateLimitPerHour: input.rateLimitPerHour ?? 1,
    enabled: input.enabled ?? false,
    updatedAt: new Date().toISOString(),
    updatedBy: input.updatedBy,
    version: prevVersion + 1,
  }
  // Strip templateId from the persisted body — doc id is the source of truth.
  const { templateId: _id, ...persist } = doc
  void _id
  await ref.set(persist, { merge: false })
  return doc
}

/**
 * Per-(templateId, userId, hourBucket) rate limit. Returns `true` when the
 * fire is allowed; transactionally bumps the counter on allow. Uses an
 * hour-of-epoch bucket so each (template, user) gets one fresh bucket
 * per wall-clock hour.
 *
 * The doc carries `expiresAt` (ISO 90 minutes ahead) for Firestore TTL
 * cleanup once an operator configures a TTL policy on the field.
 */
export async function checkRateLimit(
  db: Firestore,
  templateId: string,
  userId: string,
  rateLimitPerHour: number,
  nowMs: number = Date.now()
): Promise<{ allowed: boolean; remaining: number; bucketId: string }> {
  const hourBucket = Math.floor(nowMs / (60 * 60 * 1000))
  const bucketId = `${templateId}_${userId}_${hourBucket}`
  const ref = db.collection(UPSTREAM_FIRES_COLLECTION).doc(bucketId)
  const expiresAtMs = nowMs + 90 * 60 * 1000

  return await db.runTransaction(async (t) => {
    const snap = await (
      t.get as (r: typeof ref) => Promise<{ exists: boolean; data: () => unknown }>
    )(ref)
    const prev = snap.exists ? ((snap.data() as { count?: number }) ?? {}) : {}
    const prevCount = Number(prev.count ?? 0)
    if (prevCount >= rateLimitPerHour) {
      return { allowed: false, remaining: 0, bucketId }
    }
    const nextCount = prevCount + 1
    const payload = {
      templateId,
      userId,
      bucketId,
      count: nextCount,
      hourBucket,
      expiresAt: new Date(expiresAtMs).toISOString(),
      updatedAt: new Date(nowMs).toISOString(),
    }
    if (snap.exists) {
      ;(t.update as (r: typeof ref, p: Record<string, unknown>) => unknown)(ref, payload)
    } else {
      ;(t.set as (r: typeof ref, p: Record<string, unknown>) => unknown)(ref, payload)
    }
    return { allowed: true, remaining: Math.max(0, rateLimitPerHour - nextCount), bucketId }
  })
}
