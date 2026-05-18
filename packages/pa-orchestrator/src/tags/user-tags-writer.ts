/**
 * Phase 54 (USER-TAG-05) — Sole-writer for `pa-users/{userId}.tags`.
 *
 * Centralizes ALL Firestore writes that touch the unified user-tags doc.
 * Onboarding chat hooks (Phase 54), CV ingest (Phase 53), and migration
 * scripts all funnel through this module so the
 * write contract has one auditable code path.
 *
 * Two entry points:
 *   - `writeUserTagsFull(db, userId, tags)` — overwrites the whole `tags`
 *     blob (cv-ingest after `mergeUserTags`). Equivalent to legacy direct
 *     `pa-users/{userId}.set({tags}, {merge: true})`.
 *   - `applyPartialUserTags(db, userId, partial, opts)` — partial update for
 *     onboarding hooks. Reads existing tags, merges with
 *     `partial`, writes back. Tracks `schemaVersion` + `lastUpdatedFromChat`
 *     when the caller indicates a chat-source update.
 *
 * Fail-open semantics: errors are logged via `opts.log` and swallowed; the
 * caller (onboarding flow, reply handler) MUST NOT propagate failures —
 * tag-store coherence is best-effort, never blocks user-facing flow.
 *
 * D8 lock (CLAUDE.md): "Single user tag source: pa-users/{userId}.tags ...
 * mergeUserTags() lib is sole writer". The audit asserts no other code path
 * writes the `tags` field.
 */

import type { Firestore } from "firebase-admin/firestore"
import {
  USER_TAGS_SCHEMA_VERSION,
  inferSkillBucket,
  canonicalizeSkillName,
  type UserTags,
} from "./user-tags-merger.js"
import { SkillSchema, type Skill } from "@wekruit/shared-tags"

const PA_USERS_COLLECTION = "pa-users"

/**
 * Partial-update shape — any subset of `UserTags` keys plus optional
 * bookkeeping. Numeric fields, arrays, scalars all pass through untouched.
 */
export type PartialUserTags = Partial<UserTags>

export interface WriteUserTagsOpts {
  /**
   * Source of the update. Drives which `lastUpdatedFrom*` timestamp gets
   * stamped:
   *   - "cv" → `lastUpdatedFromCv`
   *   - "chat" → `lastUpdatedFromChat`
   *   - "migration" → both, marking a backfill
   * Default: "chat" (most common partial-update path).
   */
  source?: "cv" | "chat" | "migration"
  /**
   * ISO timestamp; defaults to `new Date().toISOString()`.
   */
  nowIso?: string
  /**
   * Logger; default no-op. Receives `pa.user_tags.*` events for telemetry.
   */
  log?: (event: string, payload?: Record<string, unknown>) => void
}

/**
 * Sole writer entry point for FULL tag overwrites (post-CV merge). Wraps
 * Firestore `pa-users/{userId}.set({tags}, {merge: true})` with consistent
 * logging.
 *
 * `tags` is the output of `mergeUserTags()` — already canonical, already
 * validated. This function does NOT re-merge; it just persists.
 *
 * Fail-open: throws are caught + logged; resolves to `{ ok: false }` so the
 * caller's flow (cv-ingest) can continue.
 */
export async function writeUserTagsFull(
  db: Firestore,
  userId: string,
  tags: Record<string, unknown>,
  opts: WriteUserTagsOpts = {}
): Promise<{ ok: boolean; error?: string }> {
  const log = opts.log ?? (() => {})
  if (!userId) {
    log("pa.user_tags.skip", { reason: "no_user_id" })
    return { ok: false, error: "no_user_id" }
  }
  if (!tags || typeof tags !== "object") {
    log("pa.user_tags.skip", { reason: "no_tags", userId })
    return { ok: false, error: "no_tags" }
  }
  try {
    await db
      .collection(PA_USERS_COLLECTION)
      .doc(userId)
      .set({ tags }, { merge: true })
    log("pa.user_tags.write_full_ok", {
      userId,
      source: opts.source ?? "cv",
      keys: Object.keys(tags),
    })
    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log("pa.user_tags.write_full_error", {
      userId,
      source: opts.source ?? "cv",
      error: msg,
    })
    return { ok: false, error: msg }
  }
}

/**
 * Sole writer entry point for PARTIAL updates (onboarding chat hooks and
 * migration scripts).
 *
 * Behavior:
 *   1. Reads existing `pa-users/{userId}.tags` (best-effort)
 *   2. Merges existing fields with `partial` (partial wins on conflict)
 *   3. Stamps `lastUpdatedFrom{Cv|Chat}` per opts.source
 *   4. Stamps `schemaVersion` if not already present
 *   5. Writes back via `set({tags}, {merge: true})`
 *
 * Empty `partial` (no keys) → no-op skip + log.
 *
 * Fail-open: read errors degrade to "merge against empty existing"; write
 * errors are logged + swallowed. Returns `{ ok: false, error }` for tests.
 */
export async function applyPartialUserTags(
  db: Firestore,
  userId: string,
  partial: PartialUserTags,
  opts: WriteUserTagsOpts = {}
): Promise<{ ok: boolean; error?: string; mergedKeys?: string[] }> {
  const log = opts.log ?? (() => {})
  if (!userId) {
    log("pa.user_tags.skip", { reason: "no_user_id" })
    return { ok: false, error: "no_user_id" }
  }
  if (!partial || typeof partial !== "object") {
    log("pa.user_tags.skip", { reason: "no_partial", userId })
    return { ok: false, error: "no_partial" }
  }
  // Strip undefined keys so they don't poison the merge.
  const cleaned: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(partial)) {
    if (v !== undefined) cleaned[k] = v
  }

  // Phase 61 — canonicalize `skills` if the caller passed raw strings or a
  // mixed array. The Phase 56 V16 score reads `skills[].baseWeight`; if we
  // wrote raw strings the multiplier is undefined → score=0 for everyone.
  // Upgrade to SkillEntry[] with neutral defaults (baseWeight=1.0).
  if (Array.isArray(cleaned.skills)) {
    const seen = new Set<string>()
    const upgraded: Skill[] = []
    for (const raw of cleaned.skills) {
      let entry: Skill | null = null
      if (raw && typeof raw === "object") {
        const obj = raw as Record<string, unknown>
        const rawName = typeof obj.name === "string" ? obj.name : null
        if (rawName) {
          const name = canonicalizeSkillName(rawName)
          if (name) {
            const bucket = (typeof obj.bucket === "string" ? obj.bucket : inferSkillBucket(name))
            const proficiency = typeof obj.proficiency === "string" ? obj.proficiency : "intermediate"
            const evidenceCount =
              typeof obj.evidenceCount === "number" && Number.isFinite(obj.evidenceCount)
                ? Math.max(0, Math.floor(obj.evidenceCount))
                : 1
            const baseWeight =
              typeof obj.baseWeight === "number" && Number.isFinite(obj.baseWeight)
                ? Math.max(0, Math.min(1, obj.baseWeight))
                : 1.0
            try {
              entry = SkillSchema.parse({ name, bucket, proficiency, evidenceCount, baseWeight })
            } catch {
              entry = null
            }
          }
        }
      } else if (typeof raw === "string") {
        const name = canonicalizeSkillName(raw)
        if (name) {
          try {
            entry = SkillSchema.parse({
              name,
              bucket: inferSkillBucket(name),
              proficiency: "intermediate",
              evidenceCount: 1,
              baseWeight: 1.0,
            })
          } catch {
            entry = null
          }
        }
      }
      if (entry && !seen.has(entry.name)) {
        seen.add(entry.name)
        upgraded.push(entry)
      }
    }
    cleaned.skills = upgraded
  }

  if (Object.keys(cleaned).length === 0) {
    log("pa.user_tags.skip", { reason: "empty_partial", userId })
    return { ok: false, error: "empty_partial" }
  }

  const nowIso = opts.nowIso ?? new Date().toISOString()
  const source = opts.source ?? "chat"

  // Read existing tags (fail-soft).
  let existing: Record<string, unknown> = {}
  try {
    const snap = await db.collection(PA_USERS_COLLECTION).doc(userId).get()
    if (snap.exists) {
      const data = snap.data() as Record<string, unknown> | undefined
      const t = data?.tags
      if (t && typeof t === "object" && !Array.isArray(t)) {
        existing = t as Record<string, unknown>
      }
    }
  } catch (err) {
    log("pa.user_tags.read_error", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
    // continue with empty existing
  }

  // Merge: partial wins on conflict (caller's authoritative for the keys
  // they pass). Schema version + timestamp bookkeeping.
  const merged: Record<string, unknown> = { ...existing, ...cleaned }
  if (merged.schemaVersion == null) merged.schemaVersion = USER_TAGS_SCHEMA_VERSION
  if (source === "chat" || source === "migration") {
    merged.lastUpdatedFromChat = nowIso
  }
  if (source === "cv" || source === "migration") {
    merged.lastUpdatedFromCv = nowIso
  }

  try {
    await db
      .collection(PA_USERS_COLLECTION)
      .doc(userId)
      .set({ tags: merged }, { merge: true })
    log("pa.user_tags.apply_partial_ok", {
      userId,
      source,
      mergedKeys: Object.keys(cleaned),
    })
    return { ok: true, mergedKeys: Object.keys(cleaned) }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log("pa.user_tags.apply_partial_error", { userId, source, error: msg })
    return { ok: false, error: msg }
  }
}

/**
 * Audit helper — counts pa-users docs missing a `tags` field. Used by
 * USER-TAG-01 + the migration script `--audit-only` mode.
 *
 * Returns `{ total, withTags, missing[] }`. `missing` capped at 1000
 * userIds to bound payload.
 */
export async function auditUsersWithoutTags(
  db: Firestore,
  opts: { limit?: number; pageSize?: number; log?: (e: string, p?: Record<string, unknown>) => void } = {}
): Promise<{ total: number; withTags: number; missing: string[] }> {
  const log = opts.log ?? (() => {})
  const pageSize = opts.pageSize ?? 200
  const limit = opts.limit ?? 0 // 0 = no limit
  const missing: string[] = []
  let total = 0
  let withTags = 0
  let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | undefined
  // Loop pages until empty
  while (true) {
    let q = db.collection(PA_USERS_COLLECTION).orderBy("__name__").limit(pageSize)
    if (lastDoc) q = q.startAfter(lastDoc)
    let snap: FirebaseFirestore.QuerySnapshot
    try {
      snap = await q.get()
    } catch (err) {
      log("pa.user_tags.audit_error", {
        error: err instanceof Error ? err.message : String(err),
      })
      break
    }
    if (snap.empty) break
    lastDoc = snap.docs[snap.docs.length - 1]
    for (const doc of snap.docs) {
      total++
      const data = doc.data() as Record<string, unknown>
      const t = data?.tags
      if (t && typeof t === "object" && !Array.isArray(t)) {
        withTags++
      } else if (missing.length < 1000) {
        missing.push(doc.id)
      }
      if (limit > 0 && total >= limit) break
    }
    if (limit > 0 && total >= limit) break
  }
  log("pa.user_tags.audit_done", { total, withTags, missing: missing.length })
  return { total, withTags, missing }
}
