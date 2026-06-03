/**
 * v2.0 External Supply V1 — Wave B C-block follow-up — Legacy-tag bridge.
 *
 * Why this file exists:
 *   The Wave B-C upsert (`packages/pa-persistence/src/external-supply-upsert.ts`)
 *   correctly writes `pa-users.globalTags` (the v2.0 `CandidateGlobalTagsSchema`
 *   surface). It does NOT write `pa-users.tags` — the legacy v1.6 surface that
 *   `apps/job-rec/src/tools/query-matching-jobs-v16.ts` reads. As a result,
 *   externally-sourced candidates landed in `pa-users` but the matching
 *   pipeline could not see their tags, defeating the "candidates share the
 *   same pa-users pool" invariant.
 *
 *   We cannot import `@pa/pa-orchestrator` from `@pa/pa-persistence` because
 *   pa-orchestrator already depends on pa-persistence (would create a
 *   workspace dep cycle). The bridge therefore lives at the
 *   `apps/functions/src/external-supply` layer, which already depends on
 *   both packages.
 *
 *   Wiring point: `runResolveBatchIdentity` calls this bridge after every
 *   successful `create_new` / `merge_existing` upsert. The bridge is a
 *   weak-merge: only fields absent / empty on the existing `pa-users.tags`
 *   doc are filled from the external record. Stronger CV / conversation
 *   evidence already present is left untouched.
 *
 *   Tag invariants preserved:
 *     - `mergeUserTags` remains sole writer that composes the canonical
 *       `UserTags` projection (v1.6 lock #8).
 *     - `applyPartialUserTags` is the canonical writer to
 *       `pa-users.tags` and stamps schema + `lastUpdatedFrom*`.
 *     - Source = "migration" (backfill semantic — external import is an
 *       import-time backfill, not a chat / cv interaction).
 */

import type { Firestore } from "firebase-admin/firestore"
import {
  applyPartialUserTags,
  mergeUserTags,
  type PartialUserTags,
  type UserTags,
  type UserTagsInput,
} from "@pa/pa-orchestrator"
import type { ExternalCandidateRecord } from "@pa/core-types"

/**
 * Fields the bridge will weakly fill from an external-sourcing record.
 * Anything beyond this list should come from a real CV parse or chat
 * exchange. Kept as a `readonly` const so `forecastTagWrites` and
 * `dualWriteLegacyUserTagsFromExternal` stay in lock-step.
 */
const WEAK_FILL_FIELDS = [
  "skills",
  "industryEnum",
  "industrySector",
  "recentRoleTitle",
  "recentCompany",
  "workHistorySummary",
] as const satisfies ReadonlyArray<keyof UserTags>

/**
 * Translate an `ExternalCandidateRecord` into a minimal `UserTagsInput`
 * shape that `mergeUserTags` understands. External sources (Juicebox /
 * Lessie / Coresignal) ship raw experience + education + name. They do
 * NOT ship `statedPreferences` (no chat signal), pre-canonicalised
 * `skills`, or canonical industry tokens — those would require
 * conversation, resume parse, or post-import enrichment.
 */
export function externalRecordToUserTagsInput(
  record: ExternalCandidateRecord
): UserTagsInput {
  const experiences = (record.experience ?? []).map((e) => ({
    title: e.title,
    company: e.company,
    description: undefined,
  }))
  // P2 (V2.1): CoreSignal v2 collect adapter writes `inferred_skills` +
  // `historical_skills` (deduped, lowercased) into `record.sourceTags`.
  // Older sources (juicebox/lessie/v1 coresignal/manual_csv) usually leave
  // `sourceTags` empty, so this is a safe extension — `mergeUserTags`
  // happily upgrades plain strings into SkillEntry with neutral defaults
  // (Phase 61 path).
  const sourceSkills =
    record.sourceTags && record.sourceTags.length > 0
      ? record.sourceTags.slice(0, 64) // hard cap defensive against rogue lists
      : undefined
  return {
    cv: {
      candidateProfile: {
        skills: sourceSkills,
        name: record.name ?? null,
      },
      experiences,
      industryTags: undefined,
      industrySector: undefined,
    },
  }
}

const POPULATED = (v: unknown): boolean => {
  if (v == null) return false
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === "string") return v.trim().length > 0
  return true
}

export interface DualWriteLegacyUserTagsResult {
  wrote: boolean
  mergedKeys: string[]
  /** Which proposed fields the bridge skipped because existing was already populated. */
  skippedKeys: string[]
}

/**
 * Forecast outcome — what `dualWriteLegacyUserTagsFromExternal` *would* do
 * given a precomputed `existingTags` snapshot. Pure (no I/O). Used by the
 * preview callable to forecast the legacy-tag bridge without touching
 * Firestore.
 */
export interface ForecastTagWritesResult {
  /** Fields that would be filled (existing empty → external supplies value). */
  willFill: string[]
  /** Fields skipped because existing tags already carry a stronger signal. */
  willPreserve: string[]
  /** The exact `PartialUserTags` delta that would be passed to `applyPartialUserTags`. */
  delta: PartialUserTags
}

/**
 * Pure forecast of the legacy-tag bridge decision. Mirrors the same
 * "existing wins / weak-fill" rules used by
 * `dualWriteLegacyUserTagsFromExternal` so the preview is byte-equivalent to
 * the production write decision.
 *
 * Determinism: same `(existingTags, record)` → same output. No date/uuid
 * involved.
 */
export function forecastTagWrites(
  existingTags: Partial<UserTags>,
  record: ExternalCandidateRecord
): ForecastTagWritesResult {
  const proposed: UserTags = mergeUserTags(externalRecordToUserTagsInput(record))

  const delta: PartialUserTags = {}
  const willFill: string[] = []
  const willPreserve: string[] = []

  for (const key of WEAK_FILL_FIELDS) {
    const existingVal = existingTags[key]
    const proposedVal = proposed[key]
    if (POPULATED(existingVal)) {
      if (proposedVal !== undefined) willPreserve.push(String(key))
      continue
    }
    if (POPULATED(proposedVal)) {
      ;(delta as Record<string, unknown>)[key] = proposedVal
      willFill.push(String(key))
    }
  }

  return { willFill, willPreserve, delta }
}

/**
 * Weak-merge external record → `pa-users.tags`. Returns the keys actually
 * written and the keys deliberately skipped because existing tags already
 * carried stronger evidence. Safe to call on every create/merge pass —
 * idempotent and a no-op when there's nothing to fill.
 */
export async function dualWriteLegacyUserTagsFromExternal(
  db: Firestore,
  candidateId: string,
  record: ExternalCandidateRecord,
  opts: { nowIso: string; log?: (event: string, payload?: Record<string, unknown>) => void }
): Promise<DualWriteLegacyUserTagsResult> {
  const snap = await db.collection("pa-users").doc(candidateId).get()
  const existing = (snap.exists ? ((snap.data() as Record<string, unknown>).tags ?? {}) : {}) as Partial<UserTags>

  // Delegate the pure decision to `forecastTagWrites` so the preview
  // callable and the production writer always agree on what would be
  // written. Net behaviour identical to the prior inline implementation.
  const forecast = forecastTagWrites(existing, record)
  const skippedKeys = forecast.willPreserve
  const delta = forecast.delta

  if (Object.keys(delta).length === 0) {
    return { wrote: false, mergedKeys: [], skippedKeys }
  }

  const result = await applyPartialUserTags(db, candidateId, delta, {
    source: "migration",
    nowIso: opts.nowIso,
    projectGlobalTags: false,
    log: opts.log,
  })

  if (!result.ok) {
    return { wrote: false, mergedKeys: [], skippedKeys }
  }
  return {
    wrote: true,
    mergedKeys: result.mergedKeys ?? Object.keys(delta),
    skippedKeys,
  }
}
