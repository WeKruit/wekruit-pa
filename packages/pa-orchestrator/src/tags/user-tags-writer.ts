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
import { SkillSchema, CAREER_STAGE_VOCAB, type Skill } from "@wekruit/shared-tags"
import { canonicalizeLocationTokens } from "./onboarding-mappers.js"

const PA_USERS_COLLECTION = "pa-users"

/**
 * Seniority RANGE for /me: [anchor, anchor+bufferSteps] in CAREER_STAGE_VOCAB order, clamped to the
 * vocab bounds. `bufferSteps` lives on `tags.preferenceHardness.careerStage.bufferSteps` (how far up the
 * candidate is open, set at onboarding). Returns undefined when the anchor is off-vocab or buffer ≤ 0 —
 * the caller then emits only the scalar `careerStage` and /me shows the single stage.
 */
function deriveCareerStageRange(
  anchor: string,
  preferenceHardness: unknown,
): [string, string] | undefined {
  const vocab = CAREER_STAGE_VOCAB as readonly string[]
  const idx = vocab.indexOf(anchor)
  if (idx < 0) return undefined
  const ph =
    preferenceHardness && typeof preferenceHardness === "object" && !Array.isArray(preferenceHardness)
      ? (preferenceHardness as Record<string, unknown>)
      : undefined
  const csPref =
    ph?.careerStage && typeof ph.careerStage === "object" && !Array.isArray(ph.careerStage)
      ? (ph.careerStage as Record<string, unknown>)
      : undefined
  const rawBuffer = csPref?.bufferSteps
  const buffer =
    typeof rawBuffer === "number" && Number.isFinite(rawBuffer) ? Math.max(0, Math.floor(rawBuffer)) : 0
  if (buffer <= 0) return undefined
  const upperIdx = Math.min(idx + buffer, vocab.length - 1)
  if (upperIdx <= idx) return undefined
  return [vocab[idx]!, vocab[upperIdx]!]
}

// companySize on the matching store (UserTags) carries the token `open`; the candidate-facing
// CandidateGlobalTagsSchema does NOT accept `open` — it uses the `no_preference` sentinel. Normalize
// at projection so a "no preference" answer survives the /me read-schema parse (Adam 2026-05-31:
// normalize to the existing sentinel rather than adding a vocab token). The matcher already treats
// the sentinel / empty as "no constraint", so /me and matching agree.
function normalizeCompanySizeForGlobalTags(value: string): string {
  return value === "open" ? "no_preference" : value
}

// Defensive: older docs / extractor passes can carry legacy visa tokens (gc/opt/h1b/cpt) while the
// /me VisaSchema is the strict 4-token D4 enum. Fold legacy → canonical at projection so a stale doc
// never fails the candidate-portal read. Anything still off-vocab after folding is dropped (not
// projected) rather than poisoning the parse.
const VISA_LEGACY_TO_CANONICAL: Record<string, string> = {
  gc: "permanent_resident",
  green_card: "permanent_resident",
  greencard: "permanent_resident",
  opt: "sponsor_needed",
  cpt: "sponsor_needed",
  h1b: "sponsor_needed",
  h1b1: "sponsor_needed",
  f1: "sponsor_needed",
}
const CANONICAL_VISA = new Set(["citizen", "permanent_resident", "sponsor_needed", "other"])

/**
 * Project the matching tag store (`pa-users.tags`, UserTags) onto the candidate-facing
 * `pa-users.globalTags` (CandidateGlobalTags) surface that the /me portal reads.
 *
 * WHY (Adam 2026-05-30 — the /me-renders-nothing gap): the conversation/onboarding path writes ONLY
 * `pa-users.tags`. The /me portal + admin marketplace read `candidateSelfProfiles.globalTags`, which
 * `claimCandidateProfile` populates from `pa-users.globalTags` — a field that only the external-supply
 * path ever wrote. So a phone-onboarded candidate had a complete, canonical `tags` blob that was
 * INVISIBLE to /me. Projecting here, in the D8 sole writer, closes the split with zero new sync job:
 * every tag write lands both surfaces atomically. Field renames per CandidateGlobalTagsSchema:
 * targetRoleFunction→roleFunction, minSalary→minSalaryUsd, companySize→companySizePreference; the rest
 * are 1:1. Values are already canonical (validated upstream), so the /me read-schema parse is safe.
 * Only keys present in `tags` are emitted → set({merge:true}) preserves any globalTags subfields this
 * path doesn't own (e.g. external-supply-set fields).
 */
export function projectTagsToGlobalTags(tags: Record<string, unknown>): Record<string, unknown> {
  const g: Record<string, unknown> = {}
  const arr = (k: string): unknown[] | undefined => (Array.isArray(tags[k]) ? (tags[k] as unknown[]) : undefined)
  const role = arr("targetRoleFunction")
  if (role) g.roleFunction = role
  if (Array.isArray(tags.skills)) g.skills = tags.skills
  if (typeof tags.careerStage === "string") {
    g.careerStage = tags.careerStage
  }
  // Seniority RANGE. An EXPLICIT candidate-authored range (`tags.careerStageRange`, from the /me editor
  // or conversation) DRIVES /me + matching and wins over the derived one (Adam-locked 2026-05-31). When
  // absent, derive a display range from the scalar anchor + how far up the candidate is open
  // (preferenceHardness.careerStage.bufferSteps) so /me still renders "junior–senior", not "junior".
  const explicitRange =
    Array.isArray(tags.careerStageRange) &&
    tags.careerStageRange.length === 2 &&
    typeof tags.careerStageRange[0] === "string" &&
    typeof tags.careerStageRange[1] === "string"
      ? ([tags.careerStageRange[0], tags.careerStageRange[1]] as [string, string])
      : undefined
  const range =
    explicitRange ??
    (typeof tags.careerStage === "string"
      ? deriveCareerStageRange(tags.careerStage, tags.preferenceHardness)
      : undefined)
  if (range) g.careerStageRange = range
  if (Array.isArray(tags.yoeRange)) g.yoeRange = tags.yoeRange
  const ind = arr("industrySector")
  if (ind) g.industrySector = ind
  const loc = arr("targetLocations")
  if (loc) g.targetLocations = loc
  if (typeof tags.visaStatus === "string" && tags.visaStatus) {
    const folded = VISA_LEGACY_TO_CANONICAL[tags.visaStatus] ?? tags.visaStatus
    if (CANONICAL_VISA.has(folded)) g.visaStatus = folded
  }
  const jt = arr("targetJobType")
  if (jt) g.targetJobType = jt
  const rt = arr("relevantTags")
  if (rt) g.relevantTags = rt
  if (typeof tags.minSalary === "number" && Number.isFinite(tags.minSalary)) g.minSalaryUsd = tags.minSalary
  // companySize is scalar-OR-array on tags (UserTags union) — lift a scalar to a 1-elem array so a
  // single-pick ("enterprise") still reaches globalTags (was dropped: arr() only handled arrays), and
  // normalize `open`→`no_preference` (read-schema sentinel).
  const csRaw = tags.companySize
  if (Array.isArray(csRaw) && csRaw.length) {
    g.companySizePreference = csRaw
      .filter((v): v is string => typeof v === "string" && !!v)
      .map(normalizeCompanySizeForGlobalTags)
  } else if (typeof csRaw === "string" && csRaw) {
    g.companySizePreference = [normalizeCompanySizeForGlobalTags(csRaw)]
  }
  // companyStage — funding-stage preference, orthogonal to companySize. Scalar OR array on tags; always
  // emit as an array on globalTags (the /me schema + UI treat it multi-pick).
  const stage = tags.companyStage
  if (Array.isArray(stage) && stage.length) g.companyStage = stage
  else if (typeof stage === "string" && stage) g.companyStage = [stage]
  return g
}

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
  /**
   * Default true. Set false only for writers that already own the canonical
   * `pa-users.globalTags` surface and are filling the legacy `tags` store.
   */
  projectGlobalTags?: boolean
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
      .set({ tags, globalTags: projectTagsToGlobalTags(tags) }, { merge: true })
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

  // Conversation extractor emits `minSalaryUsd`; V16 reads `tags.minSalary`.
  // Normalize at the sole-writer boundary so no caller can persist the wrong
  // field name into `pa-users.tags`.
  if (
    cleaned.minSalary === undefined &&
    typeof cleaned.minSalaryUsd === "number" &&
    Number.isFinite(cleaned.minSalaryUsd)
  ) {
    cleaned.minSalary = Math.max(0, Math.floor(cleaned.minSalaryUsd))
  }
  delete cleaned.minSalaryUsd

  // Negative role function — `negativeRoleFunction` is the SINGLE canonical
  // field (mirrors `negativeIndustrySector`). Older callers / persisted docs
  // used `roleFunctionNegativeList`; fold any such legacy key into the
  // canonical field at the sole-writer boundary so there is exactly one source
  // of truth and the V16 matcher's `negativeRoleFunction` read always sees it.
  if (Array.isArray((cleaned as Record<string, unknown>).roleFunctionNegativeList)) {
    const legacy = (cleaned as Record<string, unknown>).roleFunctionNegativeList as unknown[]
    const canonical = Array.isArray((cleaned as Record<string, unknown>).negativeRoleFunction)
      ? ((cleaned as Record<string, unknown>).negativeRoleFunction as unknown[])
      : []
    const merged = [...canonical, ...legacy].filter((s): s is string => typeof s === "string")
    ;(cleaned as Record<string, unknown>).negativeRoleFunction = Array.from(new Set(merged))
  }
  delete (cleaned as Record<string, unknown>).roleFunctionNegativeList

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

  // targetLocations — canonicalize to LOCATION_VOCAB at the sole-writer boundary
  // so EVERY source (onboarding mapper, conversation-extractor free-form strings,
  // CV) lands canonical tokens that intersect the job side
  // (`matching-jobs.locationBuckets` = LOCATION_VOCAB enum). This is the ONE
  // location canonicalizer — fixes the recurring drift (new_york vs
  // new_york_metro) that over-filtered the location hard gate to recCount=0. The
  // V16 anywhere-bypass tokens (anywhere/any/remote_*) are preserved verbatim by
  // canonicalizeLocationTokens, so the bypass still fires.
  if (cleaned.targetLocations !== undefined) {
    cleaned.targetLocations = canonicalizeLocationTokens(cleaned.targetLocations)
  }
  // targetCountry — its own small region vocab (usa/canada/uk/.../anywhere), NOT
  // the city-level LOCATION_VOCAB. Just trim+lowercase+dedupe (the extractor /
  // onboarding extractCountries already emit canonical lowercase region tokens).
  if (Array.isArray(cleaned.targetCountry)) {
    const seen = new Set<string>()
    const normalized: string[] = []
    for (const raw of cleaned.targetCountry as unknown[]) {
      if (typeof raw !== "string") continue
      const norm = raw.trim().toLowerCase()
      if (norm.length === 0 || seen.has(norm)) continue
      seen.add(norm)
      normalized.push(norm)
    }
    cleaned.targetCountry = normalized
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

  // negativeJobType — the SUBTRACT axis for `targetJobType` (mirrors
  // `negativeRoleFunction`: storage is shallow-REPLACED per write like every
  // other key; cross-turn accumulation is the matching-profile REDUCER's job).
  // `targetJobType` is an EXACT-match HARD filter, so the sole writer
  // additionally APPLIES the subtraction at the boundary (V16 ALSO hard-drops
  // on `negativeJobType` directly since the 2026-06-09 follow-up, mirroring
  // negativeRoleFunction): incoming negativeJobType tokens are
  // removed from the post-merge `targetJobType`. A subtraction that empties
  // the set persists [] — an explicit clear, never silently skipped. This is
  // the 2026-06-09 live-victim fix: "I am not looking for an internship" must
  // be able to clear a stale targetJobType=["internship"] from a pure negation.
  if (Array.isArray(cleaned.negativeJobType)) {
    const incoming = (cleaned.negativeJobType as unknown[]).filter(
      (s): s is string => typeof s === "string" && s.trim().length > 0
    )
    if (incoming.length > 0 && Array.isArray(merged.targetJobType)) {
      const avoid = new Set(incoming)
      merged.targetJobType = (merged.targetJobType as unknown[]).filter(
        (t) => typeof t === "string" && !avoid.has(t)
      )
    }
  }

  // SOFT-vs-HARD (2026-05-28) — `preferenceHardness` is the ONE field merged
  // PER-AXIS rather than wholesale-replaced. The conversation extractor emits
  // hardness deltas one axis at a time (e.g. turn 1 → salary, turn 5 →
  // location); a shallow replace would drop earlier axes. Per-axis keys still
  // let a new signal overwrite the SAME axis. Behaviour for every other field
  // is unchanged (shallow replace).
  if (
    cleaned.preferenceHardness &&
    typeof cleaned.preferenceHardness === "object" &&
    !Array.isArray(cleaned.preferenceHardness) &&
    existing.preferenceHardness &&
    typeof existing.preferenceHardness === "object" &&
    !Array.isArray(existing.preferenceHardness)
  ) {
    merged.preferenceHardness = {
      ...(existing.preferenceHardness as Record<string, unknown>),
      ...(cleaned.preferenceHardness as Record<string, unknown>),
    }
  }
  if (merged.schemaVersion == null) merged.schemaVersion = USER_TAGS_SCHEMA_VERSION
  if (source === "chat" || source === "migration") {
    merged.lastUpdatedFromChat = nowIso
  }
  if (source === "cv" || source === "migration") {
    merged.lastUpdatedFromCv = nowIso
  }

  try {
    const writeData =
      opts.projectGlobalTags === false
        ? { tags: merged }
        : { tags: merged, globalTags: projectTagsToGlobalTags(merged) }
    await db
      .collection(PA_USERS_COLLECTION)
      .doc(userId)
      .set(writeData, { merge: true })
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
