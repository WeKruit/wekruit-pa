/**
 * iter34 sprint A.4 — role canonical token → industryEnum bucket mapper.
 *
 * Why this exists. The job-rec query layer (apps/job-rec/.../query-matching-jobs.ts)
 * filters by `industryEnum` (canonical 10-tag enum) but never used the user's
 * `targetRole` when computing which buckets to consider. As a result, an SWE
 * candidate could get a Warehouse Team Lead match because the user's tagged
 * `industryEnum` was loose enough that "tech" + "ops" buckets both qualified.
 *
 * This module centralizes the mapping from canonical role tokens (the 12-value
 * closed enum produced by `canonicalizeRole` in onboarding.ts) to the
 * `industryEnum` buckets that role plausibly works in. Caller (job-rec) takes
 * the union, intersects against `doc.industryEnum`, drops any doc with empty
 * intersection.
 *
 * Design choices:
 *   - Pure function, no LLM, no Firestore. Deterministic — same input always
 *     yields the same output. Easy to unit-test, easy to audit.
 *   - "founder" / "other" → undefined (no filter). A founder might look at
 *     anything; "other" is the canonicalize-fallback for free-form replies
 *     and we don't want to over-constrain the candidate pool from a noise
 *     reply.
 *   - Empty / undefined input → undefined (no filter). Backward-compatible
 *     with the pre-A.3 query path.
 *   - Each role expands to MULTIPLE buckets (typical 3-4) — reflects the
 *     reality that e.g. an SWE works across software / AI / fintech /
 *     hardware. We intentionally over-include here; the cosine rerank
 *     downstream still picks the best fit.
 */

import type { CanonicalRole } from "../onboarding.js"

/**
 * The canonical 10-tag industry enum used by the matching-jobs corpus
 * (`industryEnum` field) and by `pa-users.statedPreferences.industryTags`.
 *
 * Mirrors the bucket set used in apps/job-rec/.../query-matching-jobs.ts
 * (TAG_TO_INDUSTRY_KEY keys). Kept as a string-literal union here (vs.
 * importing from job-rec) to avoid orchestrator → job-rec dep cycle.
 */
export type IndustryEnumBucket =
  | "tech_software"
  | "tech_hardware"
  | "fintech_finance"
  | "ai_ml"
  | "healthcare_biotech"
  | "consumer_retail"
  | "media_entertainment"
  | "manufacturing_industrial"
  | "education"
  | "other"

/**
 * Per-role bucket map. Order within each list does not matter — caller
 * dedupes the union. Roles that should produce NO filter (founder, other)
 * are absent from this table; the function handles them via the early-return
 * branch.
 */
const ROLE_TO_BUCKETS: Record<
  Exclude<CanonicalRole, "founder" | "other">,
  ReadonlyArray<IndustryEnumBucket>
> = {
  swe: ["tech_software", "ai_ml", "fintech_finance", "tech_hardware"],
  pm: ["tech_software", "ai_ml", "fintech_finance", "consumer_retail"],
  em: ["tech_software", "ai_ml", "fintech_finance"],
  designer: ["tech_software", "consumer_retail", "media_entertainment"],
  research: ["ai_ml", "healthcare_biotech", "tech_software"],
  data: ["tech_software", "ai_ml", "fintech_finance", "healthcare_biotech"],
  ml: ["ai_ml", "tech_software", "healthcare_biotech"],
  ops: ["tech_software", "manufacturing_industrial", "consumer_retail"],
  marketing: ["consumer_retail", "media_entertainment", "tech_software"],
  sales: ["tech_software", "consumer_retail", "fintech_finance"],
}

/**
 * Map a list of canonical role tokens to the deduplicated union of
 * `industryEnum` buckets those roles work in.
 *
 * Returns `undefined` when:
 *   - input is empty / null / undefined
 *   - input contains "founder" (cross-domain, no filter desired)
 *   - input contains "other" (canonicalize-fallback, no signal to act on)
 *
 * Otherwise returns the deduplicated union, in first-seen order.
 *
 * Pure / deterministic — does not mutate input.
 */
export function roleToIndustryBuckets(
  roles: CanonicalRole[] | undefined | null
): IndustryEnumBucket[] | undefined {
  if (!Array.isArray(roles) || roles.length === 0) return undefined
  // Founder / other → don't filter. A single instance of either disables
  // role-based filtering entirely (caller intent: "show me everything").
  for (const r of roles) {
    if (r === "founder" || r === "other") return undefined
  }
  const seen = new Set<IndustryEnumBucket>()
  const out: IndustryEnumBucket[] = []
  for (const r of roles) {
    const buckets = ROLE_TO_BUCKETS[r as Exclude<CanonicalRole, "founder" | "other">]
    if (!buckets) continue
    for (const b of buckets) {
      if (!seen.has(b)) {
        seen.add(b)
        out.push(b)
      }
    }
  }
  // If everything mapped to nothing (shouldn't happen given the table
  // covers all non-founder/other roles, but defensive), fall through to
  // "no filter" rather than returning [] which would over-constrain.
  return out.length > 0 ? out : undefined
}
