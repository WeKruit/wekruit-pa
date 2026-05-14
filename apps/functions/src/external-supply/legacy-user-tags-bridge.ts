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
  return {
    cv: {
      candidateProfile: {
        skills: undefined,
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
  const proposed: UserTags = mergeUserTags(externalRecordToUserTagsInput(record))

  const snap = await db.collection("pa-users").doc(candidateId).get()
  const existing = (snap.exists ? ((snap.data() as Record<string, unknown>).tags ?? {}) : {}) as Partial<UserTags>

  const delta: PartialUserTags = {}
  const skippedKeys: string[] = []

  const considerField = <K extends keyof UserTags>(key: K): void => {
    const existingVal = existing[key]
    const proposedVal = proposed[key]
    if (POPULATED(existingVal)) {
      // existing is stronger — leave alone
      if (proposedVal !== undefined) skippedKeys.push(String(key))
      return
    }
    if (POPULATED(proposedVal)) {
      ;(delta as Record<string, unknown>)[key] = proposedVal
    }
  }

  // Fields we will weakly fill from external sourcing. NOTE: deliberately
  // narrow — anything that should come from a real CV parse or chat
  // exchange is left to those richer signals.
  considerField("skills")
  considerField("industryEnum")
  considerField("industrySector")
  considerField("recentRoleTitle")
  considerField("recentCompany")
  considerField("workHistorySummary")

  if (Object.keys(delta).length === 0) {
    return { wrote: false, mergedKeys: [], skippedKeys }
  }

  const result = await applyPartialUserTags(db, candidateId, delta, {
    source: "migration",
    nowIso: opts.nowIso,
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
