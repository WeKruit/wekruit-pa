/**
 * Tool: queryMatchingJobs
 *
 * Filter + rank `matching-jobs` (40,374 docs) for the RecruiterAgent and
 * the daily cron. The Firestore corpus is wider than what we surface to
 * the LLM (embeddings, raw search tokens, etc.); we narrow to a small,
 * stable shape via `projectMatchingJobRow`.
 *
 * Query strategy:
 *   - When `industry` is concrete (NOT "any"), compound-where on
 *     `industryKey` + `status` + `firstSeenAt desc`. Existing composite
 *     index `status,industryKey,firstSeenAt` is used.
 *   - When `industry === "any"` or omitted, drop the industryKey filter
 *     (single-field `firstSeenAt desc` index suffices).
 *   - Sponsorship: post-filter in memory (only ~50 candidates after the
 *     primary where), since `sponsorship` is bool and Firestore inequality
 *     filters on multiple fields don't compose cheaply.
 *
 * Ranking: a deterministic in-memory score = skill-overlap (Jaccard,
 * 0..1) + sponsorship bonus + location match. Embedding cosine is
 * deferred (would require an extra embedding service call) — the brief
 * notes ranking is "TBD: keyword overlap with user's skills", which we
 * implement here.
 */

import type { Firestore } from "firebase-admin/firestore"
import { tool } from "@openai/agents"
import { getFlag } from "@pa/pa-persistence"
import {
  MatchingJobSchema,
  QueryMatchingJobsInputSchema,
  type MatchingJob,
  type QueryMatchingJobsFilters,
  type QueryMatchingJobsOutput,
  type ScoreBreakdown as ScoreBreakdownT,
} from "../types.js"

const MATCHING_JOBS_COLLECTION = "matching-jobs"
const ACTIVE_STATUS = "active"
const QUERY_FETCH_CAP = 50 // pre-rank window

// ---------------------------------------------------------------------------
// Stream H6 — industryTag → industryKey mapping
// ---------------------------------------------------------------------------
//
// Background. The matching-jobs corpus stores a flat string `industryKey`
// per row. The token-set is wider than our 10 canonical user-facing
// `industryTags` and mixes industry-domain tokens (`fintech`, `healthcare`,
// `enterprise_saas`) with job-function tokens (`engineering`, `sales`,
// `customer_service`, `data_analytics`, `cybersecurity`). We deliberately
// over-include here: each canonical tag expands to MULTIPLE corpus keys so
// the resulting `where industryKey in [...]` filter returns a fat candidate
// pool that the cosine-rerank can then sort by user resume similarity.
//
// The H6 brief gave a base mapping (enterprise_saas, engineering, etc.) — but
// an active-corpus sample of 8000 docs (2026-05-01) shows top keys are
// {tech, hardware, accounting_finance, ai_ml, marketing, education, ...} and
// the brief's expected high-volume keys (`enterprise_saas`, `engineering`,
// `customer_service`) appear 0 times in active. We therefore UNION the
// brief's table with the actually-present keys so the mapping is robust to
// either snapshot. Forward-compat: when the F2 enrichment lands and
// industryEnum/wider keys repopulate, this table covers both shapes.
//
// Cap: Firestore `where field in [...]` accepts up to 30 values. We cap to
// MAX_INDUSTRY_KEY_VALUES below for safety; the longest deduplicated list
// is currently 8.
// ---------------------------------------------------------------------------

import type { JobIndustry } from "../types.js"

const MAX_INDUSTRY_KEY_VALUES = 10

const TAG_TO_INDUSTRY_KEY: Record<string, string[]> = {
  // Brief-base + active-corpus union. Best-effort coverage; daily-batch
  // post-filters by skills/location/sponsorship anyway.
  tech_software: [
    "enterprise_saas",
    "tech",
    "engineering",
    "ai_ml",
    "data_analytics",
    "cybersecurity",
    "product",
    "technology",
  ],
  tech_hardware: ["hardware", "tech", "semiconductor", "semiconductors", "consumer_electronics"],
  fintech_finance: ["fintech", "accounting_finance", "banking", "insurance"],
  // No canonical "ai_ml" industryKey in the original schema; the corpus
  // does carry an `ai_ml` token in 77/8000 active rows, so we include it.
  ai_ml: ["ai_ml", "ai_infrastructure", "enterprise_saas", "tech", "data_analytics"],
  healthcare_biotech: ["healthtech", "healthcare"],
  consumer_retail: ["ecommerce", "retail", "consumer_electronics"],
  media_entertainment: ["media", "arts_entertainment", "gaming", "social_media"],
  manufacturing_industrial: [
    "manufacturing",
    "aerospace_defense",
    "automotive",
    "energy",
    "transportation",
  ],
  education: ["education"],
  other: ["other"],
}

/**
 * Map a single canonical 10-tag industry token to the corpus' industryKey
 * value-set. Returns the input wrapped in [tag] when the tag isn't in our
 * table (fail-open: still attempts a literal match rather than empty-set).
 *
 * Pure / deterministic — exposed for unit tests in
 * apps/job-rec/src/__tests__/tools/query-matching-jobs.test.ts.
 */
export function mapTagToIndustryKeys(tag: string): string[] {
  const t = String(tag ?? "").trim()
  if (!t) return []
  return TAG_TO_INDUSTRY_KEY[t] ?? [t]
}

/**
 * Expand a list of canonical industry tags to a deduplicated, capped
 * industryKey value-set suitable for `where industryKey in [...]`.
 * Returns up to MAX_INDUSTRY_KEY_VALUES values. Returns [] when the
 * input is empty or every tag is unknown — caller should treat empty as
 * "no industry filter".
 */
export function expandIndustryTags(tags: readonly string[]): string[] {
  if (!Array.isArray(tags) || tags.length === 0) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const tag of tags) {
    for (const key of mapTagToIndustryKeys(tag)) {
      if (!seen.has(key)) {
        seen.add(key)
        out.push(key)
        if (out.length >= MAX_INDUSTRY_KEY_VALUES) return out
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Stream H7 — Location fallback ladder for under-represented preferences.
//
// The matching-jobs corpus has near-zero coverage of some metro areas (e.g.
// Baltimore,MD: 0/8000 active rows on 2026-05-01). Without a ladder, the
// scoreJob location component collapses to the 0.2 floor for every job, so
// the location signal degenerates to noise.
//
// Ladder semantics:
//   - Primary substring match           → 1.0 (already handled in scoreJob)
//   - "remote" preference + remote job  → 1.0 (already handled)
//   - Neighbor city substring match     → 0.6 (clearly secondary signal)
//   - Neighbor=remote + remote job      → 0.7 (remote satisfies remote-OK candidates better)
//   - No match in primary or ladder     → 0.2 floor
//
// Keys are lower-cased, whitespace-trimmed forms of `filters.location`. We
// intentionally include both the long form ("baltimore,md") and the short
// form ("baltimore"), because `normalizeJobProfile` passes
// `locationPreference` verbatim and users have written either.
// ---------------------------------------------------------------------------

export const LOCATION_NEIGHBORS: Record<string, string[]> = {
  // Neighbors are loose substring tokens designed to hit real
  // `locationRaw` values (e.g. "Washington, DC" → "washington"; "Remote"
  // → "remote"). All entries are case-insensitive (we lowercase the job
  // location before substring-testing). Each preference key includes the
  // common spelling variants users actually type.
  //
  // Baltimore / DMV
  "baltimore,md": ["washington", "annapolis", "philadelphia", "remote"],
  "baltimore, md": ["washington", "annapolis", "philadelphia", "remote"],
  "baltimore": ["washington", "annapolis", "philadelphia", "remote"],
  // NYC
  "nyc": ["jersey city", "newark", "brooklyn", "long island", "remote"],
  "new york,ny": ["jersey city", "newark", "brooklyn", "remote"],
  "new york, ny": ["jersey city", "newark", "brooklyn", "remote"],
  "new york": ["jersey city", "newark", "brooklyn", "remote"],
  // Bay Area / SF
  "san francisco,ca": ["oakland", "san jose", "palo alto", "berkeley", "remote"],
  "san francisco, ca": ["oakland", "san jose", "palo alto", "berkeley", "remote"],
  "san francisco": ["oakland", "san jose", "palo alto", "berkeley", "remote"],
  "sf": ["oakland", "san jose", "palo alto", "berkeley", "remote"],
  // LA
  "los angeles,ca": ["santa monica", "pasadena", "irvine", "burbank", "remote"],
  "los angeles, ca": ["santa monica", "pasadena", "irvine", "burbank", "remote"],
  "los angeles": ["santa monica", "pasadena", "irvine", "burbank", "remote"],
  "la": ["santa monica", "pasadena", "irvine", "burbank", "remote"],
  // Seattle
  "seattle,wa": ["bellevue", "redmond", "kirkland", "tacoma", "remote"],
  "seattle, wa": ["bellevue", "redmond", "kirkland", "tacoma", "remote"],
  "seattle": ["bellevue", "redmond", "kirkland", "tacoma", "remote"],
  // Boston
  "boston,ma": ["cambridge", "somerville", "waltham", "burlington", "remote"],
  "boston, ma": ["cambridge", "somerville", "waltham", "burlington", "remote"],
  "boston": ["cambridge", "somerville", "waltham", "burlington", "remote"],
  // Austin
  "austin,tx": ["round rock", "san antonio", "dallas", "houston", "remote"],
  "austin, tx": ["round rock", "san antonio", "dallas", "houston", "remote"],
  "austin": ["round rock", "san antonio", "dallas", "houston", "remote"],
  // Chicago
  "chicago,il": ["evanston", "naperville", "schaumburg", "milwaukee", "remote"],
  "chicago, il": ["evanston", "naperville", "schaumburg", "milwaukee", "remote"],
  "chicago": ["evanston", "naperville", "schaumburg", "milwaukee", "remote"],
  // Atlanta
  "atlanta,ga": ["alpharetta", "sandy springs", "marietta", "remote"],
  "atlanta, ga": ["alpharetta", "sandy springs", "marietta", "remote"],
  "atlanta": ["alpharetta", "sandy springs", "marietta", "remote"],
  // Denver
  "denver,co": ["boulder", "aurora", "colorado springs", "remote"],
  "denver, co": ["boulder", "aurora", "colorado springs", "remote"],
  "denver": ["boulder", "aurora", "colorado springs", "remote"],
  // DC (Washington, DC)
  "washington,dc": ["arlington", "alexandria", "bethesda", "baltimore", "remote"],
  "washington, dc": ["arlington", "alexandria", "bethesda", "baltimore", "remote"],
  "washington dc": ["arlington", "alexandria", "bethesda", "baltimore", "remote"],
  "dc": ["arlington", "alexandria", "bethesda", "baltimore", "remote"],
}

// ---------------------------------------------------------------------------
// Stream H7 — Title anti-bias rerank for QA/QC/manufacturing false-friends.
//
// The H6 industryKey-in expansion includes `engineering` for the canonical
// `tech_software` tag, but in the corpus `engineering` is a job-FUNCTION
// bucket that mixes SWE / QA / QC / manufacturing-engineering rows. Cosine
// then false-friends "QC Analyst" with a Data Analyst CV by sharing the
// "Analyst" token. We surface this as a deterministic title-pattern penalty
// applied AFTER cosine rerank, gated on the user's industry intent.
//
// Decision: multiply by 0.3 (don't zero) — corner cases like "QA Engineer
// at Stripe" can still be valid for some users; we degrade signal but don't
// kill it. Combined with the input-order initial rank, a heavily-penalized
// row sinks to the bottom of top-N but isn't removed from the candidate set.
// ---------------------------------------------------------------------------

export const QA_QC_TITLE_REGEX =
  /\b(quality\s+(assurance|control|engineer|technician|specialist|analyst)|qa\s+(specialist|analyst|engineer|technician)|qc\s+(analyst|inspector|specialist)|manufacturing\s+engineer|process\s+engineer|technician|inspector)\b/i

const TECH_USER_TAGS_FOR_ANTIBIAS = new Set([
  "tech_software",
  "ai_ml",
  "fintech_finance",
])

const TITLE_PENALTY_MULTIPLIER = 0.3

/**
 * Apply title-pattern anti-bias to an already-ranked job list. Pure /
 * deterministic.
 *
 * Inputs:
 *   - jobs: list pre-sorted by upstream rank (cosine or Jaccard). Input
 *           order encodes initial rank.
 *   - industryTags: user's canonical 10-tag list. When it contains any of
 *           {tech_software, ai_ml, fintech_finance}, anti-bias is active.
 *   - limit: number of jobs to return. When omitted, returns the full list.
 *
 * Algorithm:
 *   1. Map each job to a synthetic score N..1 by input-index (preserves the
 *      upstream cosine ordering as the prior).
 *   2. If anti-bias is active AND title matches QA_QC_TITLE_REGEX, multiply
 *      the synthetic score by 0.3.
 *   3. Stable-sort by score desc, ties broken by input index (older index
 *      = higher original rank wins).
 *   4. Take first `limit`.
 *
 * The 0.3x is chosen so a top-1 cosine match (synthetic score N) penalized
 * to 0.3*N still ranks above the 0.31*N-th-placed clean job — i.e. a hit
 * needs to be ~3x worse than the next clean job to fully sink it. With
 * candidate pools of 20 and limit 3, this means the top QC false-friend
 * still loses to the #4-#7 clean job, which is the desired behavior.
 */
export function applyTitleAntiBias<T extends { jobTitle?: string }>(
  jobs: readonly T[],
  industryTags: readonly string[] | undefined,
  limit?: number
): T[] {
  const N = jobs.length
  if (N === 0) return []
  const active =
    Array.isArray(industryTags) &&
    industryTags.some((t) => TECH_USER_TAGS_FOR_ANTIBIAS.has(t))

  const scored = jobs.map((j, i) => {
    const initial = N - i // N..1
    const title = typeof j.jobTitle === "string" ? j.jobTitle : ""
    const penalized = active && QA_QC_TITLE_REGEX.test(title)
    const score = penalized ? initial * TITLE_PENALTY_MULTIPLIER : initial
    return { j, i, score }
  })
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.i - b.i
  })
  const out = scored.map((x) => x.j)
  return typeof limit === "number" ? out.slice(0, limit) : out
}

// ---------------------------------------------------------------------------
// TD-#10 (v1.5 / 2026-05-02) — Defensive guard against polluted industryEnum.
//
// Background. The H8 enrichment writes `industryEnum: [tag]` per matching-job
// doc using an LLM classifier. Audit on 2026-05-02 (500-doc sample with
// industryEnum array-contains-any [tech_software, ai_ml, fintech_finance])
// found 17% (85/500) docs with mislabeled industryEnum — e.g. a Groundskeeper
// posting whose industryKey="management" was tagged industryEnum=
// ["fintech_finance"]. Since Adam's CV (SQL/Python/ML, h1b) carries
// industryTags=["tech_software","ai_ml","fintech_finance"], the legacy
// queryMatchingJobs path returned Groundskeeper / Community Manager /
// Marketing Liaison in the top-20.
//
// Root cause is upstream (Mac mini enrichment LLM-classifier quality). This
// file's responsibility is the Cloud-side defensive guard: when the user is
// tech-leaning, reject docs whose `industryKey` (the older, more-stable
// enrichment field) is in a known-non-tech bucket — even if their
// `industryEnum` claims tech.
//
// Two-signal design:
//   - industryKey is the H6-era field; ~stable across the corpus, derived
//     from the source URL/board taxonomy. Sample audit confirmed
//     industryKey="management" rows are real management/operations jobs.
//   - industryEnum is the H8 LLM-derived tag-array; ~17% mislabel rate.
//   - When the two disagree AND industryKey ∈ NEVER_KEYS AND user is tech,
//     trust industryKey and reject. Belt-and-suspenders.
//
// NOT a whitelist: a "Software Engineer @ Goldman" with industryKey="banking"
// is valid for fintech_finance users, so we use a tight blacklist of
// observed-mislabeled buckets only.
//
// Logging: when ≥1 doc is rejected per query, emit one summary log line so
// the v1.6 enrichment-fix backlog has data on mislabel volume over time.
// ---------------------------------------------------------------------------

/**
 * industryKey buckets that are NEVER tech/finance/AI roles. When the user's
 * industryTags contain a tech-leaning tag, any doc whose industryKey lands
 * here is rejected regardless of what industryEnum claims.
 *
 * Derived from a 500-doc sample (2026-05-02) of industryEnum-matched jobs;
 * every key here was observed mislabeled in that sample. Conservative — we
 * intentionally OMIT ambiguous buckets like "media" (could be a tech-media
 * SWE role) and "education" (edtech overlap). When in doubt, keep it out of
 * the never-list.
 */
export const NON_TECH_NEVER_KEYS: ReadonlySet<string> = new Set([
  "management", // Groundskeeper, Community Manager, Property Manager
  "customer_service", // Call-center, support reps
  "sales", // Outbound, account exec, retail sales
  "legal", // Paralegal, attorney
  "government", // Civil-service postings
  "consulting", // Pure mgmt-consulting (Big-4 GTS, etc.) — tech consulting goes under "tech"
  "marketing", // Marketing Liaison, brand marketing
  "business", // Business Coordinator, ops-business hybrid
  "reinsurance", // Industry-specific underwriting
  "operations", // Facilities/ops/logistics
])

/**
 * User industryTags considered "tech-leaning". When the user has ANY of
 * these in their industryTags, the never-list applies. Superset of the
 * existing TECH_USER_TAGS_FOR_ANTIBIAS — we also include tech_hardware
 * because a hardware-EE candidate is unlikely to want a Groundskeeper job.
 */
export const TECH_LEANING_USER_TAGS: ReadonlySet<string> = new Set([
  "tech_software",
  "ai_ml",
  "fintech_finance",
  "tech_hardware",
])

/**
 * iter34 sprint B.12 — Resolve a job doc's industry bucket(s).
 *
 * Background: the matching-jobs corpus carries TWO industry signals:
 *   - `industryEnum` (array): H8-enriched canonical 10-tag bucket (e.g.
 *     ["tech_software"]). LLM-derived but cleaner than industryKey because
 *     it maps to the canonical user-facing taxonomy. Most active docs have
 *     it after the H8 enrichment run.
 *   - `industryKey` (string): older, source-derived token (e.g. "management",
 *     "tech"). 17% mislabel rate observed in 2026-05-02 audit.
 *
 * Preference ladder:
 *   1. Use `industryEnum` when present and non-empty (canonical taxonomy).
 *   2. Fall back to `industryKey` (legacy single-value bucket) wrapped in
 *      a 1-element array.
 *   3. Empty array when neither present.
 *
 * Pure / deterministic. Exposed for unit tests.
 */
export function getJobIndustryBuckets(rawDoc: {
  industryEnum?: readonly string[]
  industryKey?: string
}): string[] {
  if (Array.isArray(rawDoc.industryEnum) && rawDoc.industryEnum.length > 0) {
    return rawDoc.industryEnum.filter((s): s is string => typeof s === "string")
  }
  if (typeof rawDoc.industryKey === "string" && rawDoc.industryKey.length > 0) {
    return [rawDoc.industryKey] // legacy fallback
  }
  return []
}

/**
 * Apply the TD-#10 defensive never-list. Pure / deterministic.
 *
 * Inputs:
 *   - jobs: post-Firestore candidate pool, projected MatchingJob shape.
 *   - userTags: user's industryTags (from normalizeJobProfile).
 *
 * Behavior:
 *   - When userTags is empty OR contains no tech-leaning tag → return jobs
 *     unchanged (non-tech users may legitimately want management/sales/etc).
 *   - Otherwise, drop any job whose industry buckets contain a key in
 *     NON_TECH_NEVER_KEYS. iter34 B.12 — buckets come from
 *     {@link getJobIndustryBuckets} which prefers the canonical
 *     industryEnum array (cleaner) over the legacy industryKey string
 *     (17% mislabel). Both fields use the same bucket-name namespace for
 *     the never-list keys (e.g. "management", "sales"), so the same
 *     NEVER_KEYS table works against either source.
 *
 * Returns the kept-jobs array (does NOT mutate input). The `rejectedKeys`
 * map is keyed on the bucket that triggered rejection.
 *
 * Exposed for unit tests in
 * apps/job-rec/src/__tests__/tools/query-matching-jobs.test.ts.
 */
export function applyEnrichmentNeverList<
  T extends { industryKey?: string; industryEnum?: readonly string[] }
>(
  jobs: readonly T[],
  userTags: readonly string[] | undefined
): { kept: T[]; rejected: number; rejectedKeys: Record<string, number> } {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return { kept: [], rejected: 0, rejectedKeys: {} }
  }
  const tags = Array.isArray(userTags) ? userTags : []
  const isTechLeaning = tags.some((t) => TECH_LEANING_USER_TAGS.has(t))
  if (!isTechLeaning) {
    return { kept: [...jobs], rejected: 0, rejectedKeys: {} }
  }
  const kept: T[] = []
  const rejectedKeys: Record<string, number> = {}
  let rejected = 0
  for (const j of jobs) {
    const buckets = getJobIndustryBuckets(j)
    let firstHit: string | null = null
    for (const b of buckets) {
      if (NON_TECH_NEVER_KEYS.has(b)) {
        firstHit = b
        break
      }
    }
    if (firstHit !== null) {
      rejected += 1
      rejectedKeys[firstHit] = (rejectedKeys[firstHit] ?? 0) + 1
      continue
    }
    kept.push(j)
  }
  return { kept, rejected, rejectedKeys }
}

// Type-only import guard — JobIndustry is referenced in the table type only
// for runtime documentation; the table key is a string union of
// JobIndustryTag values. JobIndustry import retained for forward-compat.
void ((): JobIndustry | undefined => undefined)

// ---------------------------------------------------------------------------
// iter34 sprint B.13 — title regex anti-bias (tech-leaning users → drop
// blue-collar / non-tech roleTitle even when other signals leak through).
//
// Background: the never-list (B.12) catches docs whose canonical
// industryEnum lands in NEVER_KEYS, but it can't catch a doc whose
// industryEnum is mislabeled as `tech_software` while the actual roleTitle
// is "Warehouse Team Lead" or "Truck Driver II". We add a deterministic
// roleTitle blacklist that activates only for tech-leaning users.
//
// Blacklist tokens cover the most-observed false-friend buckets in the
// 2026-05-02 audit: warehouse / driver / nurse / teacher / cashier /
// retail / janitor / cleaner / cook / server / bartender / barber /
// stylist / paramedic / housekeeper / caregiver. Plus `technician` with a
// negative lookahead — we DROP "Lab Technician" / "Maintenance Technician"
// but KEEP "Software Technician" / "Cloud Technician" / "Data Technician"
// since those are valid SWE-adjacent roles.
//
// Position in pipeline: AFTER applyEnrichmentNeverList + role filter,
// BEFORE rankJobs — same insertion point as the existing QA-anti-bias
// rerank, but this is a HARD filter (drop), not a rerank.
// ---------------------------------------------------------------------------

/**
 * Tech-leaning blue-collar / non-tech / support-role roleTitle blacklist.
 * Fires only when the user has a tech-leaning industry tag.
 *
 * iter34 followup D.6 — extended with support / admin / training titles
 * after SWE-persona sim surfaced "Platform Support - Analyst" being
 * recommended. Bare `analyst` / `specialist` / `associate` / `trainee` are
 * dropped UNLESS preceded by a tech qualifier (lookbehind allowlist).
 *
 * iter34 H.2 / CR2 — extended again after G5 sim surfaced BDR / Account
 * Manager / Account Executive / Sales Executive / Customer Success
 * Manager / Operations Manager being recommended to a SWE candidate.
 * Patterns:
 *   - business development → ALWAYS drop (catches BDR titles).
 *   - account manager / account executive → drop UNLESS preceded by a tech
 *     qualifier (engineering/software/cloud/technical/systems/product).
 *     Catches "Partner Account Manager" too (no tech qualifier in front).
 *   - sales (manager|executive|representative|producer|associate) → drop.
 *   - customer success → drop.
 *   - business analyst → drop (already covered by `analyst` rule, kept
 *     here for clarity).
 *   - operations manager → drop UNLESS preceded by engineering / software /
 *     cloud / technical / systems / product / infrastructure. NB: bare
 *     "operations" alone is NOT dropped — "Software Engineer Operations"
 *     survives.
 *   - project manager → drop UNLESS preceded by the same tech qualifier set.
 *
 * Notes on the regex:
 *   - Word boundary on most tokens (\b) to avoid false positives.
 *   - "Manager in Training" / "Management Trainee" caught via the
 *     "manager in training" / "management trainee" patterns; "Engineering
 *     Manager" survives because it doesn't carry those phrases.
 *   - `technician` uses negative lookbehind `(?<!(?:software|cloud|cyber|data|ml|ai)\s)`
 *     so "Cloud Technician" / "Software Technician" / "Data Technician"
 *     survive (valid SWE-adjacent roles), while "Lab Technician" /
 *     "Maintenance Technician" are caught.
 *   - `analyst`: dropped unless preceded by `engineer` / `engineering`.
 *     Tighter than other tokens because "Software Analyst" / "Data Analyst"
 *     are typically BA-flavored, not SWE.
 *   - `specialist` / `associate` / `trainee`: broader allow list including
 *     software / cloud / data / ml / ai / etc. "Sales Associate" drops,
 *     "Engineering Associate" / "Software Trainee" survive.
 *   - Bare `coordinator` / `receptionist` / `secretary` / `clerk` /
 *     "bank teller" / "front desk": always drop (no tech context exists).
 *
 * Limitation: "server" can collide with "Server Engineer" (the token
 * "server" before " Engineer" matches \bserver\b). Tech users with
 * legitimate "Server Engineer" hits should use targetRoleIndustryEnum
 * (B.10 / A.3) which would surface them via the role-fit gate.
 */
export const TECH_LEANING_TITLE_BLACKLIST_REGEX = new RegExp(
  // Bare keywords: always drop on word-boundary match.
  String.raw`\b(?:warehouse|truck|driver|nurse|teacher|cashier|retail|janitor|cleaner|cook|server|bartender|barber|stylist|paramedic|housekeeper|caregiver|coordinator|receptionist|secretary|clerk|bank\s+teller|front\s+desk|manager\s+in\s+training|management\s+trainee|(?<!(?:software|cloud|cyber|data|ml|ai)\s)technician)\b` +
    // analyst — narrow allow list (engineer/engineering only).
    String.raw`|(?<!(?:engineer|engineering)\s)\banalyst\b` +
    // specialist — broader tech allow list.
    String.raw`|(?<!(?:engineer|engineering|software|cloud|ml|ai|technical|integration|systems|infrastructure|security|cyber|product)\s)\bspecialist\b` +
    // associate — broader tech allow list.
    String.raw`|(?<!(?:engineering|software|cloud|data|ml|ai|backend|frontend|fullstack|technical|product)\s)\bassociate\b` +
    // trainee — engineer/developer/software/cloud allow.
    String.raw`|(?<!(?:engineer|engineering|software|cloud|developer|technical)\s)\btrainee\b` +
    // iter34 H.2 / CR2 — sales / BDR / customer-success / business titles.
    // business development → always drop (covers BDR).
    String.raw`|\bbusiness\s+development\b` +
    // partner account → always drop (covers "Partner Account Manager").
    String.raw`|\bpartner\s+account\b` +
    // account (manager|executive) → drop unless preceded by tech qualifier.
    String.raw`|(?<!(?:software|technical|cloud|engineering|systems|product)\s)\baccount\s+(?:manager|executive)\b` +
    // sales (manager|executive|representative|producer|associate) → always drop.
    String.raw`|\bsales\s+(?:manager|executive|representative|producer|associate)\b` +
    // customer success → always drop (covers "Customer Success Manager").
    String.raw`|\bcustomer\s+success\b` +
    // business analyst → drop (also caught by analyst lookbehind, but explicit
    // here for grep-ability).
    String.raw`|\bbusiness\s+analyst\b` +
    // operations manager → drop unless preceded by tech qualifier.
    // NB bare "operations" is NOT in this set; "Software Engineer Operations"
    // survives.
    String.raw`|(?<!(?:engineering|software|cloud|technical|systems|product|infrastructure)\s)\boperations\s+manager\b` +
    // project manager → drop unless preceded by tech qualifier.
    String.raw`|(?<!(?:engineering|software|cloud|technical|product|systems|infrastructure)\s)\bproject\s+manager\b`,
  "i"
)

/**
 * Apply the B.13 tech-leaning title blacklist. Pure / deterministic.
 *
 * Inputs:
 *   - jobs: candidate pool (post-never-list, post-role-filter).
 *   - userTags: user's industryTags. When NONE of TECH_LEANING_USER_TAGS
 *     are present, the blacklist is BYPASSED (non-tech users may
 *     legitimately want warehouse/retail roles).
 *
 * Behavior:
 *   - When user is non-tech-leaning OR userTags is empty → return jobs unchanged.
 *   - Otherwise, drop any job whose roleTitle / jobTitle matches
 *     TECH_LEANING_TITLE_BLACKLIST_REGEX.
 *
 * Returns the kept-jobs array (does NOT mutate input). Provides a
 * `rejected` count for log observability.
 *
 * Exposed for unit tests in
 * apps/job-rec/src/__tests__/tools/query-matching-jobs.test.ts.
 */
export function applyTechLeaningTitleBlacklist<T extends { jobTitle?: string }>(
  jobs: readonly T[],
  userTags: readonly string[] | undefined
): { kept: T[]; rejected: number } {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return { kept: [], rejected: 0 }
  }
  const tags = Array.isArray(userTags) ? userTags : []
  const isTechLeaning = tags.some((t) => TECH_LEANING_USER_TAGS.has(t))
  if (!isTechLeaning) {
    return { kept: [...jobs], rejected: 0 }
  }
  const kept: T[] = []
  let rejected = 0
  for (const j of jobs) {
    const title = typeof j.jobTitle === "string" ? j.jobTitle : ""
    if (title && TECH_LEANING_TITLE_BLACKLIST_REGEX.test(title)) {
      rejected += 1
      continue
    }
    kept.push(j)
  }
  return { kept, rejected }
}

// ---------------------------------------------------------------------------
// iter34 followup D.5 — atsApplyUrl hard gate.
//
// SWE-persona sims (iter34 followup) showed jobs being recommended whose
// `primaryUrl` is a `jobright.ai` mirror (legacy aggregator scrape). The
// candidate clicks through to a re-ranked aggregator page rather than the
// real ATS apply form (Greenhouse / Lever / Workday / Ashby / etc).
//
// Coverage data from prod (matching-jobs `status==active`, n=842):
//   - 27.9% of active docs have `atsApplyUrl` populated as non-empty string
//   - ~72% are missing or have it as null/undefined (legacy scrape)
//   - Rare (<1%) jobright leak INTO `atsApplyUrl` itself
//
// Trade-off: filtering shrinks active inventory ~72%, but the alternative
// (recommend a jobright mirror link) is a UX failure — candidates lose trust
// when an "Apply" link drops them onto an aggregator. Tighter inventory beats
// fake links. As re-enrichment closes the gap, this filter relaxes naturally.
//
// Position in pipeline: AFTER applyTechLeaningTitleBlacklist, BEFORE rankJobs.
// Pure / deterministic — no Firestore reads.
// ---------------------------------------------------------------------------

/**
 * Drop jobs whose `atsApplyUrl` is missing/empty, or whose `atsApplyUrl`
 * itself contains a `jobright.ai` mirror string (rare leak case observed
 * in legacy data).
 *
 * Inputs:
 *   - jobs: candidate pool with `atsApplyUrl?: string` projected.
 *
 * Returns the kept-jobs array (does not mutate input). Provides a `rejected`
 * count for log observability.
 *
 * Exposed for unit tests in
 * apps/job-rec/src/__tests__/tools/query-matching-jobs.test.ts.
 */
export function applyAtsApplyUrlGate<T extends { atsApplyUrl?: string }>(
  jobs: readonly T[]
): { kept: T[]; rejected: number } {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return { kept: [], rejected: 0 }
  }
  const kept: T[] = []
  let rejected = 0
  for (const j of jobs) {
    const url = j.atsApplyUrl
    if (typeof url !== "string" || url.length === 0) {
      rejected += 1
      continue
    }
    if (url.toLowerCase().includes("jobright.ai")) {
      // mirror leak — drop even though the field is populated
      rejected += 1
      continue
    }
    kept.push(j)
  }
  return { kept, rejected }
}

// ---------------------------------------------------------------------------
// iter34 followup D.9 — recency hard filter (lastSeenAt < 7d, fallback 30d).
//
// Background. Adam W4 audit on 2026-05-04 found that `firstSeenAt` is the
// BATCH-INGEST timestamp (rows cluster at 30-50d ago when a board got
// re-scraped) and is NOT a freshness signal. The right freshness signal is
// `lastSeenAt` — written by the inventory crawler on every successful
// re-fetch. Stale rows (lastSeenAt > 30d) are typically jobs the board has
// taken down without an explicit `dead` flag.
//
// Filter design:
//   - Primary tier: keep only rows with `lastSeenAt` parsed-and-finite AND
//     within DEFAULT_RECENCY_WINDOW_MS (7d) of `now`.
//   - Fallback tier: when the 7d window leaves < FALLBACK_MIN_JOBS (20)
//     survivors, expand to FALLBACK_RECENCY_WINDOW_MS (30d) and try again.
//   - Missing / unparseable `lastSeenAt` → DROP (conservative, no-signal-no-row).
//
// Pure / deterministic. Position in pipeline: AFTER applyAtsApplyUrlGate,
// BEFORE rankJobs.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_RECENCY_WINDOW_MS = 7 * DAY_MS
const FALLBACK_RECENCY_WINDOW_MS = 30 * DAY_MS
const FALLBACK_MIN_JOBS = 20

/**
 * Parse a job doc's `lastSeenAt` to ms-since-epoch. Pure / deterministic.
 *
 * Accepts:
 *   - ISO 8601 string ("2026-05-01T12:34:56Z" / "2026-05-01") — `Date.parse`.
 *   - Firestore Timestamp object (carries `.toDate()` returning a Date).
 *   - Anything else (number / null / undefined / malformed string) → null.
 *
 * Returns null when the field is absent OR cannot be parsed to a finite ms
 * value. Callers (recency filter) treat null as "drop" — no signal means
 * we cannot prove freshness and a stale row would be worse than no row.
 *
 * Exposed for unit tests.
 */
export function getJobLastSeenMs(job: { lastSeenAt?: unknown }): number | null {
  const v = job.lastSeenAt
  if (typeof v === "string") {
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : null
  }
  // Firestore Timestamp: { toDate(): Date, seconds: number, nanoseconds: number }
  if (v && typeof v === "object") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj = v as any
    if (typeof obj.toDate === "function") {
      try {
        const d = obj.toDate()
        if (d instanceof Date) {
          const t = d.getTime()
          return Number.isFinite(t) ? t : null
        }
      } catch {
        return null
      }
    }
    // {seconds, nanoseconds} shape (Firestore serialized form)
    if (typeof obj.seconds === "number" && Number.isFinite(obj.seconds)) {
      const ns = typeof obj.nanoseconds === "number" ? obj.nanoseconds : 0
      const t = obj.seconds * 1000 + Math.floor(ns / 1_000_000)
      return Number.isFinite(t) ? t : null
    }
  }
  return null
}

export type ApplyRecencyFilterOptions = {
  /** Recency window in ms. Default 7d (DEFAULT_RECENCY_WINDOW_MS). */
  maxAgeMs?: number
  /** Pinned "now" for deterministic tests. Default Date.now(). */
  nowMs?: number
}

/**
 * Apply the iter34 D.9 recency filter. Pure / deterministic.
 *
 * Inputs:
 *   - jobs: candidate pool with `lastSeenAt` projected.
 *   - opts.maxAgeMs: window in ms. Default 7d.
 *   - opts.nowMs: pinned now (for tests). Default Date.now().
 *
 * Behavior:
 *   - Drops rows where getJobLastSeenMs returns null (missing / malformed).
 *   - Drops rows where (now - lastSeenMs) > maxAgeMs (stale).
 *   - Keeps rows where 0 <= (now - lastSeenMs) <= maxAgeMs.
 *
 * Exposed for unit tests.
 */
export function applyRecencyFilter<T extends { lastSeenAt?: unknown }>(
  jobs: readonly T[],
  opts?: ApplyRecencyFilterOptions
): T[] {
  if (!Array.isArray(jobs) || jobs.length === 0) return []
  const maxAge = opts?.maxAgeMs ?? DEFAULT_RECENCY_WINDOW_MS
  const now = opts?.nowMs ?? Date.now()
  const out: T[] = []
  for (const j of jobs) {
    const seen = getJobLastSeenMs(j)
    if (seen === null) continue
    const age = now - seen
    if (age < 0) continue // future timestamp — treat as malformed, drop
    if (age > maxAge) continue
    out.push(j)
  }
  return out
}

/**
 * Apply the iter34 D.9 recency filter with fallback expansion. Pure /
 * deterministic.
 *
 * Algorithm:
 *   1. Try DEFAULT_RECENCY_WINDOW_MS (7d).
 *   2. If survivors < FALLBACK_MIN_JOBS, retry with FALLBACK_RECENCY_WINDOW_MS (30d).
 *   3. Return survivors + a `fallback` flag for log observability.
 *
 * Exposed for unit tests.
 */
export function applyRecencyFilterWithFallback<T extends { lastSeenAt?: unknown }>(
  jobs: readonly T[],
  opts?: ApplyRecencyFilterOptions
): { kept: T[]; fallback: boolean; windowMs: number } {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return { kept: [], fallback: false, windowMs: opts?.maxAgeMs ?? DEFAULT_RECENCY_WINDOW_MS }
  }
  const primaryWindow = opts?.maxAgeMs ?? DEFAULT_RECENCY_WINDOW_MS
  const primary = applyRecencyFilter(jobs, opts)
  if (primary.length >= FALLBACK_MIN_JOBS) {
    return { kept: primary, fallback: false, windowMs: primaryWindow }
  }
  // Expand to fallback window (30d). When caller passed a custom maxAgeMs,
  // we still expand to the canonical 30d ceiling — there's no smaller signal
  // to recover from.
  const expanded = applyRecencyFilter(jobs, {
    maxAgeMs: FALLBACK_RECENCY_WINDOW_MS,
    nowMs: opts?.nowMs,
  })
  return { kept: expanded, fallback: true, windowMs: FALLBACK_RECENCY_WINDOW_MS }
}

// ---------------------------------------------------------------------------
// iter34 followup D.13 — liveness hard filter.
//
// Background. Some `atsApplyUrl` values point at job postings that the board
// has taken down (404), redirected to a closed-jobs page (410), or crashed
// (500). Recommending a dead link is a UX failure (candidate clicks "Apply",
// sees an error page, loses trust). We can't HTTP HEAD-check synchronously in
// the query path (latency unbounded; would re-check the same URL N times per
// day). Instead, an out-of-band sweep (G.4 worker) writes `dead: true` on the
// doc when its HEAD returns 4xx/5xx, and this filter drops those rows from
// query results.
//
// Pure / deterministic. Position in pipeline: AFTER applyRecencyFilter,
// BEFORE rankJobs.
// ---------------------------------------------------------------------------

/**
 * Apply the iter34 D.13 liveness filter. Pure / deterministic.
 *
 * Inputs:
 *   - jobs: candidate pool with `dead?: boolean` projected.
 *
 * Behavior:
 *   - Drops jobs where `dead === true`.
 *   - Keeps jobs where `dead === false` (sweep ran and got 2xx).
 *   - Keeps jobs where `dead === undefined` (sweep has not run yet —
 *     back-compat with legacy rows).
 *
 * Exposed for unit tests.
 */
export function applyLivenessFilter<T extends { dead?: boolean }>(
  jobs: readonly T[]
): { kept: T[]; rejected: number } {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return { kept: [], rejected: 0 }
  }
  const kept: T[] = []
  let rejected = 0
  for (const j of jobs) {
    if (j.dead === true) {
      rejected += 1
      continue
    }
    kept.push(j)
  }
  return { kept, rejected }
}

// ---------------------------------------------------------------------------
// Stream H8 — industryEnum-primary query path (flag-gated).
//
// After H8 enrichment writes `industryEnum: [tag]` (1-element array) to the
// matching-jobs corpus, the query can hit the canonical 10-tag bucket
// directly via `where industryEnum array-contains-any [...userTags]` instead
// of the H6 expansion-to-corpus-keys workaround.
//
// Switch is gated by `pa-feature-flags/matchingIndustryEnumPopulated` so we
// can flip it ON only AFTER the LIVE enrichment run completes successfully.
// Default OFF — falls through to H6 path. Read happens once per query (the
// pa-persistence SDK has a 30s in-process cache, so the per-query overhead
// is amortized to ~zero).
// ---------------------------------------------------------------------------

const FLAG_INDUSTRY_ENUM_POPULATED = "matchingIndustryEnumPopulated"
const MAX_INDUSTRY_ENUM_VALUES = 10 // Firestore array-contains-any cap

/**
 * Cap a list of canonical 10-tag values to the array-contains-any limit.
 * Pure / deterministic — exported for unit tests.
 */
export function capIndustryEnumValues(tags: readonly string[]): string[] {
  if (!Array.isArray(tags) || tags.length === 0) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of tags) {
    const s = typeof t === "string" ? t.trim() : ""
    if (!s) continue
    if (seen.has(s)) continue
    seen.add(s)
    out.push(s)
    if (out.length >= MAX_INDUSTRY_ENUM_VALUES) break
  }
  return out
}



// ---------------------------------------------------------------------------
// Phase 43 (v1.5 / Stream-C) — Hard filters using `pa-users.statedPreferences`.
//
// Rationale: H8 industryEnum query returns ~50 candidates ranked by recency +
// Jaccard, then daily-batch reranks by cosine + cross-encoder. None of those
// stages enforce "user is a college student → never send 'Senior' jobs", or
// "user needs sponsorship → never send 'US citizen only' jobs". Those are
// HARD constraints — no amount of rerank can recover from sending a wrong
// fit, and the trust hit (one bad job kills the channel) dominates.
//
// Position in pipeline: AFTER queryMatchingJobs returns, BEFORE cross-encoder
// rerank — i.e. the candidate pool we hard-filter is post-Firestore-where /
// post-Jaccard but pre-cosine. That's the cheapest place where we have all
// 4 signals (jobTitle, requiredSkills, locationRaw, sponsorship) projected.
//
// Schema reality check: the Phase 43 brief refers to job.seniority_level,
// job.role_title, job.qualifications. The actual MatchingJobSchema (B-stream
// shape) carries jobTitle, requiredSkills, locationRaw, sponsorship — no
// seniority_level / qualifications. We therefore detect:
//   - Seniority   → regex over `jobTitle` (covers "Senior", "Staff", "Lead",
//                   "Principal", "Director", "VP", plus 资深/主管/总监 zh)
//   - Research    → regex over `jobTitle` ∪ `requiredSkills` (covers "research",
//                   "scientist", "PhD", "postdoc", plus 研究/科研/博士)
//   - Sponsorship → regex over `jobTitle` ∪ `requiredSkills` for explicit
//                   no-sponsor markers, AND treat `sponsorship === false` as
//                   a hard exclusion when user explicitly needs sponsorship.
//                   The corpus does NOT carry a free-text `qualifications`
//                   field today; this is best-effort, not exhaustive.
//   - Location    → existing locationRaw + LOCATION_NEIGHBORS ladder (Phase
//                   39 H7).
//
// ZERO new LLM calls. Pure regex + set ops. < 50ms over 100 jobs (measured:
// ~0.3ms — regex compile is one-shot module-load, per-job is ~5 op).
//
// Bilingual: every keyword bank carries both en + zh tokens, OR-merged into
// one regex per concept (single pass per job).
//
// Flag: `paHardFiltersEnabled`. Default OFF; ramp 1%→10%→50%→100% per the
// pa-feature-flags playbook. When OFF, daily-batch skips this entirely (zero
// regression on existing path).
// ---------------------------------------------------------------------------

import type { StatedPreferences } from "@pa/core-types"

/**
 * The minimal user-profile shape applyHardFilters needs. daily-batch.ts
 * assembles this from `pa-users.statedPreferences` (Phase 44 ship) +
 * `parsedCandidateResumes.experiences` (existing Stream B+ shape).
 *
 * `statedPreferences` may be entirely absent for users who haven't done the
 * Phase 44 onboarding probe v2 yet (1%→100% ramp ongoing). In that case the
 * `inferCollegeStudent` helper covers the YoE branch via CV-only signal.
 */
export type HardFilterUserProfile = {
  statedPreferences?: StatedPreferences
  /**
   * Most-recent-first list of resume experiences. Only `startDate` (year or
   * "YYYY-MM" string) and `endDate` ("present" or year/year-month string)
   * are read by hard-filter logic.
   */
  experiences?: ReadonlyArray<{
    startDate?: string
    endDate?: string
  }>
}

/**
 * Outcome wrapper from {@link applyHardFiltersWithFallback}. Surfaces the
 * relax level so callers (daily-batch) can switch the H13 opener variant
 * to the "我看你简历目前还没找到完美的 fit" Variant D when fallbackMode=true.
 */
export type HardFilterResult = {
  jobs: MatchingJob[]
  /** True iff we ended up returning previous-7-day jobs (no fresh survivors). */
  fallbackMode: boolean
  /** Which relaxation tier produced the surviving set. */
  relaxLevel: "none" | "relaxed" | "min" | "prev7d"
}

// ----- Keyword banks (bilingual; module-private; case-insensitive) ---------

/**
 * Senior-track titles. Drops these jobs when user is a college student or
 * yoeRange[1] < 1.
 *
 * Notes on the regex:
 *   - Word-boundary on en tokens to avoid false positives ("research lead" 是
 *     "lead" 但 "leader" 不是 — well, we DO want to drop leader; we don't
 *     want "leadership analyst" → handled by \b on lead). Pragmatic.
 *   - zh tokens have no word boundary (CJK) — match anywhere.
 */
export const SENIOR_TITLE_REGEX =
  /(\b(senior|sr\.?|staff|principal|director|vp|vice\s*president|head\s+of|lead|tech\s+lead|architect)\b|资深|高级|主管|总监|首席|架构师)/i

/**
 * Research-orientation. When user explicitly opted for research-only path,
 * keep ONLY jobs whose title or required-skills mention research signals.
 */
export const RESEARCH_KEYWORDS_REGEX =
  /(\bresearch(er)?\b|\bscientist\b|\bphd\b|\bpostdoc\b|\bapplied\s+scientist\b|\bresearch\s+engineer\b|研究|科研|博士|科学家)/i

/**
 * No-sponsorship hard markers. When user needs sponsorship, drop jobs that
 * carry these tokens in title or required-skills. The corpus DOES carry
 * `sponsorship: boolean | null`; we treat `=== false` as an additional hard
 * signal alongside this regex (belt-and-suspenders).
 */
export const NO_SPONSORSHIP_KEYWORDS_REGEX =
  /(us\s+citizen(ship)?\s*(only|required)?|no\s+sponsorship|must\s+have\s+green\s+card|gc\s+(only|required)|need\s+(?:us\s+)?citizenship|公民|绿卡|不提供\s*(签证|sponsorship|赞助)|不\s*sponsor)/i

/** Cap experiences[].startDate "still in school" lookback — 4 years per brief D3. */
const COLLEGE_STUDENT_LOOKBACK_YEARS = 4
/** D1 rule 1 sub-clause: still-in-school detection lookback (12 months). */
const STILL_IN_SCHOOL_RECENT_MONTHS = 12

/**
 * Parse a startDate string like "2024", "2024-09", "2024-09-15" to a JS
 * year (number) or null when unparseable. Pure / deterministic.
 */
export function parseStartYear(s: string | undefined): number | null {
  if (typeof s !== "string") return null
  const m = s.match(/^(\d{4})/)
  if (!m) return null
  const y = Number.parseInt(m[1]!, 10)
  return Number.isFinite(y) ? y : null
}

function nowYear(now: Date = new Date()): number {
  return now.getUTCFullYear()
}

function nowMs(now: Date = new Date()): number {
  return now.getTime()
}

/**
 * D3 — College-student CV-inference. Pure / deterministic.
 *
 * Returns true iff the profile has at least one experience AND every
 * experience has endDate === "present" AND every parseable startDate is
 * within the last COLLEGE_STUDENT_LOOKBACK_YEARS years.
 *
 * Confidence target per brief: ~75%. We don't expose a numeric confidence —
 * the heuristic is binary, and downstream uses it as a hard signal only when
 * statedPreferences.yoeRange is null/undefined (i.e. user hasn't completed
 * onboarding probe v2 yet).
 */
export function inferCollegeStudent(
  experiences: HardFilterUserProfile["experiences"] | undefined,
  now: Date = new Date()
): boolean {
  if (!Array.isArray(experiences) || experiences.length === 0) return false
  const cy = nowYear(now)
  for (const e of experiences) {
    if (!e || typeof e !== "object") return false
    const end = typeof e.endDate === "string" ? e.endDate.toLowerCase().trim() : ""
    if (end !== "present") return false
    const sy = parseStartYear(e.startDate)
    if (sy === null) return false
    if (cy - sy > COLLEGE_STUDENT_LOOKBACK_YEARS) return false
  }
  return true
}

/**
 * D1 rule 1 sub-clause — "still in school": single experience with endDate
 * "present" AND startDate within the last STILL_IN_SCHOOL_RECENT_MONTHS.
 *
 * Brief: "(profile.experiences[0].endDate is "present" AND startDate < 12mo
 * ago — i.e., still in school)". We interpret as "the most-recent-first
 * experience" (experiences[0]).
 */
export function isStillInSchool(
  experiences: HardFilterUserProfile["experiences"] | undefined,
  now: Date = new Date()
): boolean {
  if (!Array.isArray(experiences) || experiences.length === 0) return false
  const e0 = experiences[0]
  if (!e0 || typeof e0 !== "object") return false
  const end = typeof e0.endDate === "string" ? e0.endDate.toLowerCase().trim() : ""
  if (end !== "present") return false
  // Parse to month-resolution (YYYY or YYYY-MM or YYYY-MM-DD). Year-only
  // values default to January (worst-case for "within 12mo" — a bare "2025"
  // is interpreted as "Jan 2025"; if today is May 2026 that is 16 months
  // out, correctly failing. A "2025-08" is interpreted as Aug 2025, which
  // against May 2026 is 9 months — passes.).
  const ym = parseStartYearMonth(e0.startDate)
  if (ym === null) return false
  const startMs = Date.UTC(ym.year, ym.month, 1)
  const cutoffMs = nowMs(now) - STILL_IN_SCHOOL_RECENT_MONTHS * 30 * 24 * 3600 * 1000
  return startMs >= cutoffMs
}

/**
 * Parse "YYYY", "YYYY-MM", "YYYY-MM-DD" → {year, month (0-indexed)}.
 * Returns null on unparseable input. Year-only inputs default to month=0
 * (January). Pure / deterministic. Exposed for unit tests.
 */
/**
 * Parse a CV experience start date. Accepts:
 *   - `2025` or `2025-09` or `2025-09-01` (ISO-ish)
 *   - `Sep2025` / `Aug2025` / `Oct2025` (resume-parser default — month names jammed against year)
 *   - `Sep 2025` / `September 2025` (with space)
 * Returns 0-indexed month (Jan=0). Falls back to month=0 when only year is given.
 *
 * v1.5 fix (Adam dry-run job-rec E2E showed Adam's resume produced "Oct2025"
 * which the original `^(\d{4})...` regex skipped — silently dropping
 * `inferCollegeStudent` to false and disabling all hard-filter rules).
 */
const MONTH_NAME_TO_INDEX: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  january: 0, february: 1, march: 2, april: 3, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
}

export function parseStartYearMonth(s: string | undefined): { year: number; month: number } | null {
  if (typeof s !== "string") return null
  const trimmed = s.trim()
  // Form A: ISO-ish — `2025`, `2025-09`, `2025-09-01`
  const isoMatch = trimmed.match(/^(\d{4})(?:-(\d{1,2}))?/)
  if (isoMatch) {
    const year = Number.parseInt(isoMatch[1]!, 10)
    if (Number.isFinite(year)) {
      let month = 0
      if (typeof isoMatch[2] === "string") {
        const mm = Number.parseInt(isoMatch[2], 10)
        if (Number.isFinite(mm) && mm >= 1 && mm <= 12) month = mm - 1
      }
      return { year, month }
    }
  }
  // Form B: month name (jammed or with space) — `Sep2025`, `Sep 2025`, `September 2025`
  const nameMatch = trimmed.match(/^([A-Za-z]+)\s*(\d{4})\b/)
  if (nameMatch) {
    const monthName = nameMatch[1]!.toLowerCase()
    const year = Number.parseInt(nameMatch[2]!, 10)
    const month = MONTH_NAME_TO_INDEX[monthName]
    if (Number.isFinite(year) && typeof month === "number") {
      return { year, month }
    }
  }
  return null
}

// ----- The actual hard-filter pipeline --------------------------------------

type HardFilterRules = {
  yoe: boolean
  research: boolean
  visa: boolean
  location: boolean
}

const ALL_RULES: HardFilterRules = { yoe: true, research: true, visa: true, location: true }

function jobTitleAndSkillsHaystack(job: MatchingJob): string {
  const title = typeof job.jobTitle === "string" ? job.jobTitle : ""
  const skills = Array.isArray(job.requiredSkills) ? job.requiredSkills.join(" ") : ""
  return `${title}
${skills}`
}

function locationMatches(targetLocations: readonly string[], job: MatchingJob): boolean {
  const l = (job.locationRaw ?? "").toLowerCase()
  if (!l) return false
  for (const tRaw of targetLocations) {
    if (typeof tRaw !== "string") continue
    const t = tRaw.toLowerCase().trim()
    if (!t) continue
    if (t === "remote" && l.includes("remote")) return true
    if (t === "anywhere" || t === "any") return true
    if (l.includes(t)) return true
    const primaryCity = t.split(",")[0]?.trim() ?? ""
    if (primaryCity && primaryCity.length >= 3 && l.includes(primaryCity)) return true
    const neighbors = LOCATION_NEIGHBORS[t] ?? []
    for (const n of neighbors) {
      if (n === "remote" && l.includes("remote")) return true
      if (n && l.includes(n)) return true
    }
  }
  return false
}

/**
 * Phase 43 / D1 — apply hard filters to a candidate pool.
 *
 * All rules are AND-combined: a job survives only if it passes every active
 * rule. Rules can be selectively disabled via `rules` (used by the fallback
 * relaxation ladder).
 *
 * Rule semantics:
 *   1. YoE / college-student exclusion: drop seniors when
 *      profile.statedPreferences.yoeRange[1] < 1, OR (no yoeRange and CV
 *      indicates still-in-school OR college-student).
 *   2. Research-orientation: when researchOriented === true, keep only jobs
 *      with research keywords in title/skills. researchOriented === false
 *      does NOT actively exclude research jobs (per brief — "user might
 *      still take one").
 *   3. Visa hard-block: when visaStatus === "sponsorship_needed", drop jobs
 *      with no-sponsor markers in title/skills, AND drop jobs with
 *      `sponsorship === false` (corpus boolean signal).
 *   4. Location hard-block: when targetLocations is non-empty, keep only
 *      jobs whose locationRaw matches one of them via LOCATION_NEIGHBORS
 *      ladder.
 *
 * Pure / deterministic. Does NOT mutate inputs.
 */
export function applyHardFilters(
  profile: HardFilterUserProfile,
  jobs: MatchingJob[],
  rules: HardFilterRules = ALL_RULES,
  now: Date = new Date()
): MatchingJob[] {
  const sp = profile.statedPreferences ?? {}

  // Rule 1: YoE / college-student exclusion preconditions.
  let dropSeniors = false
  if (rules.yoe) {
    const yoeRange = sp.yoeRange ?? null
    const hasYoeMax = Array.isArray(yoeRange) && typeof yoeRange[1] === "number"
    if (hasYoeMax && (yoeRange as [number, number])[1] < 1) {
      dropSeniors = true
    } else if (!hasYoeMax) {
      // Smart fallback per D3: infer from CV when statedPreferences absent.
      if (isStillInSchool(profile.experiences, now) || inferCollegeStudent(profile.experiences, now)) {
        dropSeniors = true
      }
    }
  }

  const researchOnly =
    rules.research && profile.statedPreferences?.researchOriented === true
  const sponsorshipNeeded =
    rules.visa && profile.statedPreferences?.visaStatus === "sponsorship_needed"
  const targetLocations =
    rules.location && Array.isArray(profile.statedPreferences?.targetLocations)
      ? (profile.statedPreferences!.targetLocations as readonly string[])
      : null
  const hasLocationFilter = !!(targetLocations && targetLocations.length > 0)

  const out: MatchingJob[] = []
  for (const job of jobs) {
    const haystack = jobTitleAndSkillsHaystack(job)

    // Rule 1
    if (dropSeniors && SENIOR_TITLE_REGEX.test(typeof job.jobTitle === "string" ? job.jobTitle : "")) {
      continue
    }
    // Rule 2
    if (researchOnly && !RESEARCH_KEYWORDS_REGEX.test(haystack)) {
      continue
    }
    // Rule 3 — text marker
    if (sponsorshipNeeded && NO_SPONSORSHIP_KEYWORDS_REGEX.test(haystack)) {
      continue
    }
    // Rule 3 — corpus boolean signal
    if (sponsorshipNeeded && job.sponsorship === false) {
      continue
    }
    // Rule 4
    if (hasLocationFilter && !locationMatches(targetLocations!, job)) {
      continue
    }
    out.push(job)
  }
  return out
}

/**
 * Phase 43 / D2 — fallback orchestrator for the 0-survivor case.
 *
 * Tier 1: full ruleset → ≥1 survivor wins, return as `relaxLevel: "none"`.
 * Tier 2: drop location → ≥1 survivor wins, return as `relaxLevel: "relaxed"`.
 * Tier 3: drop location + research, keep yoe + visa → ≥1 wins, `"min"`.
 * Tier 4: 0 survivors after every relaxation → return prev7dJobs sliced to
 *         `take` with `fallbackMode: true`, `relaxLevel: "prev7d"`.
 *
 * `prev7dJobs` is an empty array when caller didn't fetch them — in that
 * case we surface `fallbackMode: true` with `jobs: []` so the caller can
 * still flip the "couldn't find a fit today" message variant.
 */
export function applyHardFiltersWithFallback(
  profile: HardFilterUserProfile,
  jobs: MatchingJob[],
  prev7dJobs: MatchingJob[],
  take: number,
  now: Date = new Date()
): HardFilterResult {
  const tier1 = applyHardFilters(profile, jobs, ALL_RULES, now)
  if (tier1.length > 0) return { jobs: tier1, fallbackMode: false, relaxLevel: "none" }
  const tier2 = applyHardFilters(
    profile,
    jobs,
    { yoe: true, research: true, visa: true, location: false },
    now
  )
  if (tier2.length > 0) return { jobs: tier2, fallbackMode: false, relaxLevel: "relaxed" }
  const tier3 = applyHardFilters(
    profile,
    jobs,
    { yoe: true, research: false, visa: true, location: false },
    now
  )
  if (tier3.length > 0) return { jobs: tier3, fallbackMode: false, relaxLevel: "min" }
  return {
    jobs: prev7dJobs.slice(0, take),
    fallbackMode: true,
    relaxLevel: "prev7d",
  }
}

/** Phase 43 — feature flag key. Default OFF; ramp 1%→100%. */
export const HARD_FILTERS_FLAG_KEY = "paHardFiltersEnabled"

// ---------------------------------------------------------------------------
// iter34 sprint A.3 — targetRole → industryEnum post-filter.
//
// Why post-filter (not query-layer): Firestore allows only ONE
// `array-contains-any` per query. The H8 path (line ~1052) already burns
// that quota on `industryTags` (the user's intent buckets). Adding a second
// `array-contains-any` for role-derived buckets is illegal. So we run the
// role intersection in-memory after fetch — the QUERY_FETCH_CAP is 50, so
// the linear scan is ≪ 1ms.
//
// Behavior: when filter is set + non-empty, keep docs where
// `doc.industryEnum ∩ filter !== ∅`. When the doc has no `industryEnum`
// (legacy / unenriched rows), drop them — without the field we can't
// verify role fit and the role filter's whole point is to be strict.
//
// When filter is undefined / empty (e.g. user is "founder" or "other") →
// no-op, return jobs unchanged. Backward-compatible.
// ---------------------------------------------------------------------------

/**
 * Apply the iter34 A.3 targetRole-derived industryEnum intersection filter.
 * Pure / deterministic. Does not mutate input.
 *
 * Inputs:
 *   - jobs: candidate pool (post-fetch, post-projection).
 *   - allowedBuckets: union of `industryEnum` buckets the user's
 *     targetRole(s) plausibly work in. Computed by the caller via
 *     `roleToIndustryBuckets(statedPreferences.targetRole)`.
 *
 * Behavior:
 *   - allowedBuckets is undefined / null / empty → return jobs unchanged.
 *   - For each job: keep iff `Array.isArray(job.industryEnum)` AND at least
 *     one element of `job.industryEnum` is in `allowedBuckets`.
 *   - Jobs with no `industryEnum` field → dropped (role filter is intentionally
 *     strict; legacy rows fall through the role gate).
 *
 * Exposed for unit tests.
 */
export function applyTargetRoleIndustryEnumFilter<
  T extends { industryEnum?: string[] }
>(
  jobs: readonly T[],
  allowedBuckets: readonly string[] | undefined | null
): T[] {
  if (!Array.isArray(allowedBuckets) || allowedBuckets.length === 0) {
    return [...jobs]
  }
  const allowed = new Set<string>(allowedBuckets.filter((s) => typeof s === "string"))
  if (allowed.size === 0) return [...jobs]
  const out: T[] = []
  for (const j of jobs) {
    const enumArr = Array.isArray(j.industryEnum) ? j.industryEnum : null
    if (!enumArr || enumArr.length === 0) continue
    let hit = false
    for (const v of enumArr) {
      if (typeof v === "string" && allowed.has(v)) {
        hit = true
        break
      }
    }
    if (hit) out.push(j)
  }
  return out
}

export type QueryMatchingJobsDeps = {
  db: Firestore
  log?: (...args: unknown[]) => void
  /**
   * Stream F5 — when true, the projected MatchingJob includes the
   * `embedding` field (1536-d float[]). Used by the daily-batch
   * embedding rerank path. Default false to avoid bloating LLM payloads
   * for the recruiter-agent / LLM tool path.
   */
  includeEmbedding?: boolean
}

function defaultLog(..._args: unknown[]): void {
  /* swallow */
}

/**
 * Map a raw `matching-jobs` doc to the trimmed `MatchingJob` shape the
 * recruiter surfaces. Defensive about absent / mistyped fields — corpus
 * was scraped from multiple sources and not every row is uniform.
 */
export function projectMatchingJobRow(id: string, raw: Record<string, unknown>): MatchingJob {
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null
  const str = (v: unknown): string => (typeof v === "string" ? v : "")
  const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null)

  // The corpus uses `roleTitle` (per the live sample) — fall back to
  // common alternates so a future schema migration doesn't silently break.
  const jobTitle =
    str(raw.roleTitle) || str(raw.jobTitle) || str(raw.title) || ""

  const requiredSkills = Array.isArray(raw.requiredSkills)
    ? (raw.requiredSkills.filter((s) => typeof s === "string") as string[])
    : []

  // iter34 sprint A.3 — surface the H8 industryEnum array so post-filter
  // (applyTargetRoleIndustryEnumFilter) can intersect it against
  // role-derived buckets without re-fetching the raw doc.
  const industryEnum = Array.isArray(raw.industryEnum)
    ? (raw.industryEnum.filter((s): s is string => typeof s === "string"))
    : undefined

  return {
    id,
    companyName: str(raw.companyName),
    jobTitle,
    salaryMax: num(raw.salaryMax),
    salaryMin: num(raw.salaryMin),
    locationRaw: str(raw.locationRaw),
    primaryUrl: str(raw.primaryUrl),
    // iter34 sprint A.2 — surface true ATS apply URL when present.
    // Firestore raw may be string | null | undefined (camelCase only —
    // snake_case `ats_apply_url` is the Postgres-side name, not used
    // here). Normalize to `string | undefined` so downstream Zod
    // (`.optional()`) doesn't have to know about null.
    atsApplyUrl: typeof raw.atsApplyUrl === "string" ? raw.atsApplyUrl : undefined,
    industry: str(raw.industry),
    industryKey: typeof raw.industryKey === "string" ? raw.industryKey : undefined,
    sponsorship: bool(raw.sponsorship),
    jobType: typeof raw.jobType === "string" ? raw.jobType : undefined,
    requiredSkills: requiredSkills.length > 0 ? requiredSkills : undefined,
    firstSeenAt: typeof raw.firstSeenAt === "string" ? raw.firstSeenAt : undefined,
    industryEnum: industryEnum && industryEnum.length > 0 ? industryEnum : undefined,
    // iter34 followup D.9 — surface lastSeenAt (string OR Firestore Timestamp).
    // The schema uses `union(string, any)` so we pass through any non-null
    // value; getJobLastSeenMs decides parseability downstream.
    lastSeenAt:
      typeof raw.lastSeenAt === "string"
        ? raw.lastSeenAt
        : raw.lastSeenAt != null
          ? (raw.lastSeenAt as unknown)
          : undefined,
    // iter34 followup D.13 — surface liveness sweep fields.
    dead: typeof raw.dead === "boolean" ? raw.dead : undefined,
    deadCheckedAt:
      typeof raw.deadCheckedAt === "string" ? raw.deadCheckedAt : undefined,
    deadReason: typeof raw.deadReason === "string" ? raw.deadReason : undefined,
  }
}

/** Lower-case Jaccard overlap between two string sets. Returns 0..1. */
export function jaccardOverlap(a: string[], b: string[]): number {
  const lower = (s: string) => s.toLowerCase().trim()
  const sa = new Set(a.map(lower).filter(Boolean))
  const sb = new Set(b.map(lower).filter(Boolean))
  if (sa.size === 0 || sb.size === 0) return 0
  let inter = 0
  for (const x of sa) if (sb.has(x)) inter++
  const union = sa.size + sb.size - inter
  return union === 0 ? 0 : inter / union
}

/**
 * iter34 sprint B.10 — Cosine similarity between two equal-length numeric
 * vectors. Returns ∈ [0, 1] (negative similarity is clamped to 0). Throws
 * when input lengths differ — there's no semantically-meaningful fallback,
 * and silently returning 0 would hide upstream bugs.
 *
 * Pure / deterministic. Exposed for unit tests.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0
  if (a.length !== b.length) {
    throw new Error(
      `cosineSimilarity: vector length mismatch (a=${a.length}, b=${b.length})`
    )
  }
  if (a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] as number
    const bi = b[i] as number
    dot += ai * bi
    na += ai * ai
    nb += bi * bi
  }
  if (na === 0 || nb === 0) return 0
  const sim = dot / (Math.sqrt(na) * Math.sqrt(nb))
  if (!Number.isFinite(sim)) return 0
  // Clamp to [0, 1] — the breakdown contract is non-negative; opposite
  // vectors collapse to 0 rather than -1.
  if (sim < 0) return 0
  if (sim > 1) return 1
  return sim
}

/**
 * iter34 sprint B.10 — score component breakdown returned by {@link scoreJob}.
 * Canonical definition lives in `../types.ts` (avoids a circular import when
 * `MatchingJobSchema` embeds it as `matchScore`). Re-exported here so existing
 * `import { type ScoreBreakdown } from "tools/query-matching-jobs"` callers
 * (tests, legacy importers) keep working.
 */
export type ScoreBreakdown = ScoreBreakdownT

/**
 * iter34 sprint B.10 — score weights. Re-balanced from (0.5, 0.2, 0.2, 0.1)
 * to make room for the embedding cosine component while keeping the skill
 * Jaccard signal first-class:
 *
 *   skill (Jaccard)    0.35
 *   embedding cosine   0.30
 *   sponsorship        0.15
 *   location           0.15
 *   salary             0.05
 *
 * Sum = 1.00. When the user has no CV embedding, embedding contributes 0
 * and total naturally caps at 0.70 (rather than redistributing the 0.30
 * across other weights — users without a CV legitimately deserve a lower
 * absolute match score).
 */
const SCORE_WEIGHT_SKILL = 0.35
const SCORE_WEIGHT_EMBEDDING = 0.3
const SCORE_WEIGHT_SPONSORSHIP = 0.15
const SCORE_WEIGHT_LOCATION = 0.15
const SCORE_WEIGHT_SALARY = 0.05

/**
 * Score a candidate job against user filters. Pure / deterministic so
 * tests can lock the ordering down to specific tie-break behaviour.
 *
 * Returns `{ total, breakdown }` where:
 *   - skill overlap     (weight 0.35)
 *   - embedding cosine  (weight 0.30, 0 when CV embedding missing)
 *   - sponsorship match (weight 0.15)
 *   - location match    (weight 0.15)
 *   - salary floor met  (weight 0.05)
 *
 * The job-side embedding is read from `job.embedding` when the caller
 * loaded the doc with `includeEmbedding: true` (the `MatchingJob` Zod
 * schema doesn't carry the field; daily-batch attaches it post-projection).
 */
export function scoreJob(
  job: MatchingJob & { embedding?: number[] | null },
  filters: QueryMatchingJobsFilters
): { total: number; breakdown: ScoreBreakdown } {
  const userSkills = filters.userSkills ?? []
  const skillScore = job.requiredSkills ? jaccardOverlap(userSkills, job.requiredSkills) : 0

  // iter34 B.10 — embedding cosine component.
  const cv = filters.cvEmbedding
  const jobEmb = job.embedding
  let embeddingScore = 0
  if (
    Array.isArray(cv) &&
    cv.length > 0 &&
    Array.isArray(jobEmb) &&
    jobEmb.length > 0 &&
    cv.length === jobEmb.length
  ) {
    embeddingScore = cosineSimilarity(cv, jobEmb)
  }

  let sponsorshipScore = 0.5
  if (filters.sponsorship === "none") {
    // user does NOT want sponsorship; sponsorship=true is a soft demerit
    sponsorshipScore = job.sponsorship === true ? 0.0 : 1.0
  } else if (filters.sponsorship === "h1b" || filters.sponsorship === "gc") {
    // user wants sponsorship; sponsorship=true preferred
    sponsorshipScore = job.sponsorship === true ? 1.0 : 0.2
  }

  let locationScore = 0.5
  if (filters.location && job.locationRaw) {
    const f = filters.location.toLowerCase().trim()
    const l = job.locationRaw.toLowerCase()
    // Stream H7 — primary city-token also tested as substring. User
    // preferences like "Baltimore,MD" don't substring-match real
    // `locationRaw` like "Baltimore, MD" (the comma-space difference
    // breaks the literal match), so we also derive a primary city token
    // from the first comma-segment and substring-test that.
    const primaryCity = f.split(",")[0]?.trim() ?? ""
    if (l.includes(f)) locationScore = 1.0
    else if (primaryCity && primaryCity.length >= 3 && l.includes(primaryCity)) locationScore = 1.0
    else if (f === "remote" && l.includes("remote")) locationScore = 1.0
    else if (f === "anywhere" || f === "any") locationScore = 0.7
    else {
      // Stream H7 — fallback ladder for under-represented preferences.
      // When the primary city is sparse in corpus (e.g. Baltimore,MD has
      // 0/8000 active rows), fall through to deterministic neighbor list.
      // Match precedence: remote-neighbor (0.7, since "remote" satisfies
      // a Baltimore-based candidate well) > city-neighbor (0.6) > 0.2 floor.
      const neighbors = LOCATION_NEIGHBORS[f] ?? []
      let ladderScore = 0.2
      for (const n of neighbors) {
        if (n === "remote" && l.includes("remote")) {
          ladderScore = Math.max(ladderScore, 0.7)
          continue
        }
        if (n && l.includes(n)) {
          ladderScore = Math.max(ladderScore, 0.6)
        }
      }
      locationScore = ladderScore
    }
  }

  let salaryScore = 0.5
  if (typeof filters.salaryMin === "number" && filters.salaryMin > 0) {
    if (typeof job.salaryMax === "number" && job.salaryMax >= filters.salaryMin) salaryScore = 1.0
    else if (typeof job.salaryMax === "number") salaryScore = 0.0
  }

  const total =
    SCORE_WEIGHT_SKILL * skillScore +
    SCORE_WEIGHT_EMBEDDING * embeddingScore +
    SCORE_WEIGHT_SPONSORSHIP * sponsorshipScore +
    SCORE_WEIGHT_LOCATION * locationScore +
    SCORE_WEIGHT_SALARY * salaryScore

  return {
    total,
    breakdown: {
      skill: skillScore,
      embedding: embeddingScore,
      sponsorship: sponsorshipScore,
      location: locationScore,
      salary: salaryScore,
      total,
    },
  }
}

/**
 * Pure ranking helper — exposed for direct unit testing.
 *
 * iter34 sprint B.11 — attaches the per-job `matchScore` ({ total, breakdown })
 * onto each returned job so downstream callers (orchestrator-deps live recs,
 * daily-batch fallback) can render a human-readable "为啥推" reason via
 * `formatJobMatchReason`. The job is shallow-cloned before the assignment so
 * we don't mutate the caller's input array.
 */
export function rankJobs(
  jobs: MatchingJob[],
  filters: QueryMatchingJobsFilters,
  limit: number
): MatchingJob[] {
  const scored = jobs.map((j) => {
    const score = scoreJob(j, filters)
    return { j, score }
  })
  scored.sort((a, b) => {
    if (b.score.total !== a.score.total) return b.score.total - a.score.total
    // tie-break: newer firstSeenAt wins
    return (b.j.firstSeenAt ?? "").localeCompare(a.j.firstSeenAt ?? "")
  })
  return scored.slice(0, limit).map(({ j, score }) => ({
    ...j,
    matchScore: { total: score.total, breakdown: score.breakdown },
  }))
}

export type QueryMatchingJobsArgs = {
  filters: QueryMatchingJobsFilters
  limit?: number
}

export async function queryMatchingJobs(
  args: QueryMatchingJobsArgs,
  deps: QueryMatchingJobsDeps
): Promise<QueryMatchingJobsOutput> {
  const parsed = QueryMatchingJobsInputSchema.parse({
    filters: args.filters,
    limit: args.limit ?? 5,
  })
  const log = deps.log ?? defaultLog

  let q = deps.db.collection(MATCHING_JOBS_COLLECTION).where("status", "==", ACTIVE_STATUS)
  // Stream H8 — read the flag once per query. SDK has a 30s in-process cache
  // so cost is amortized. Default false → fall through to H6 path.
  const enumPopulated =
    (await getFlag(deps.db, FLAG_INDUSTRY_ENUM_POPULATED, {}, false)) === true
  const userTags = parsed.filters.industryTags ?? []

  if (enumPopulated && userTags.length > 0) {
    // H8 primary path — canonical industryEnum array-contains-any.
    const enumValues = capIndustryEnumValues(userTags)
    if (enumValues.length > 0) {
      log("[queryMatchingJobs] industryEnum_array_contains_any", {
        tags: userTags,
        enumValues,
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      q = (q as any).where("industryEnum", "array-contains-any", enumValues)
    } else if (parsed.filters.industry && parsed.filters.industry !== "any") {
      q = q.where("industryKey", "==", parsed.filters.industry)
    }
  } else {
    // H6 fallback path — expand 10-tag → corpus industryKey value-set.
    const expandedKeys = expandIndustryTags(userTags)
    if (expandedKeys.length > 0) {
      log("[queryMatchingJobs] industry_keys_expanded", {
        tags: parsed.filters.industryTags,
        keys: expandedKeys,
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      q = (q as any).where("industryKey", "in", expandedKeys)
    } else if (parsed.filters.industry && parsed.filters.industry !== "any") {
      q = q.where("industryKey", "==", parsed.filters.industry)
    }
  }
  // The composite indexes brief-cited support `status,industryKey,firstSeenAt`
  // (and the longer one with jobType+sponsorship). Order by firstSeenAt desc
  // and pull a window to rank in memory.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  q = (q as any).orderBy("firstSeenAt", "desc").limit(QUERY_FETCH_CAP)

  let snap
  try {
    snap = await q.get()
  } catch (err) {
    // Composite-index failures (FAILED_PRECONDITION) — fall back to
    // simpler query so the cron path isn't bricked by a missing index.
    log("[queryMatchingJobs] compound_query_failed_falling_back", {
      error: err instanceof Error ? err.message : String(err),
    })
    snap = await deps.db
      .collection(MATCHING_JOBS_COLLECTION)
      .where("status", "==", ACTIVE_STATUS)
      .limit(QUERY_FETCH_CAP)
      .get()
  }

  const projected: Array<MatchingJob & { embedding?: number[] | null }> = []
  for (const doc of snap.docs) {
    try {
      const raw = doc.data() as Record<string, unknown>
      const m = projectMatchingJobRow(doc.id, raw)
      // Validate via Zod so we catch malformed corpus rows loudly in tests.
      const validated = MatchingJobSchema.parse(m) as MatchingJob & {
        embedding?: number[] | null
      }
      if (deps.includeEmbedding === true) {
        const e = raw.embedding
        if (Array.isArray(e) && e.every((n) => typeof n === "number")) {
          validated.embedding = e as number[]
        } else {
          validated.embedding = null
        }
      }
      projected.push(validated)
    } catch (err) {
      log("[queryMatchingJobs] dropping_malformed_row", {
        id: doc.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Optional sponsorship hard filter — only apply if the user explicitly
  // does NOT want sponsorship; otherwise we keep the score-based soft pref.
  const sponsorshipFiltered =
    parsed.filters.sponsorship === "none"
      ? projected.filter((j) => j.sponsorship !== true)
      : projected

  // TD-#10 — defensive guard against polluted industryEnum (see comment block
  // above NON_TECH_NEVER_KEYS). When the user is tech-leaning, reject docs
  // whose industryKey lands in a known-non-tech bucket regardless of what
  // their industryEnum claims. Pure in-memory; ~50 docs ≪ 1ms.
  const userTagsForGuard = parsed.filters.industryTags ?? []
  const guardResult = applyEnrichmentNeverList(sponsorshipFiltered, userTagsForGuard)
  if (guardResult.rejected > 0) {
    log("[queryMatchingJobs] enrichment_never_list_rejected", {
      rejected: guardResult.rejected,
      kept: guardResult.kept.length,
      rejectedKeys: guardResult.rejectedKeys,
      userTags: userTagsForGuard,
    })
  }
  // iter34 sprint A.3 — role → industryEnum post-filter. Runs AFTER the
  // never-list (so role filter applies to the kept set, not the polluted
  // pool) and BEFORE rank (so the rank operates on the role-fit subset
  // only). When filter is undefined/empty, no-op.
  const roleBuckets = parsed.filters.targetRoleIndustryEnum
  const beforeRoleFilter = guardResult.kept
  const afterRoleFilter = applyTargetRoleIndustryEnumFilter(beforeRoleFilter, roleBuckets)
  if (
    Array.isArray(roleBuckets) &&
    roleBuckets.length > 0 &&
    afterRoleFilter.length !== beforeRoleFilter.length
  ) {
    log("[queryMatchingJobs] target_role_industry_enum_filtered", {
      before: beforeRoleFilter.length,
      after: afterRoleFilter.length,
      dropped: beforeRoleFilter.length - afterRoleFilter.length,
      allowedBuckets: roleBuckets,
      targetRole: parsed.filters.targetRole,
    })
  }

  // iter34 sprint B.13 — title-regex anti-bias for tech-leaning users.
  // Runs AFTER role filter so it only sees the role-fit pool. Drops docs
  // whose roleTitle matches the blue-collar / non-tech blacklist (e.g.
  // "Warehouse Team Lead", "Truck Driver II"). Bypassed for non-tech-leaning
  // users (a healthcare candidate may legitimately want a warehouse role).
  const titleBlacklistResult = applyTechLeaningTitleBlacklist(afterRoleFilter, userTagsForGuard)
  if (titleBlacklistResult.rejected > 0) {
    log("[queryMatchingJobs] tech_leaning_title_blacklist_rejected", {
      rejected: titleBlacklistResult.rejected,
      kept: titleBlacklistResult.kept.length,
      userTags: userTagsForGuard,
    })
  }
  const afterTitleBlacklist = titleBlacklistResult.kept

  // iter34 followup D.5 — drop jobs whose atsApplyUrl is missing/empty or
  // contains a jobright.ai mirror leak. Recommending a jobright mirror is a
  // UX failure (candidate clicks through to aggregator, not real ATS).
  const atsGateResult = applyAtsApplyUrlGate(afterTitleBlacklist)
  if (atsGateResult.rejected > 0) {
    log("[queryMatchingJobs] ats_apply_url_gate_rejected", {
      rejected: atsGateResult.rejected,
      kept: atsGateResult.kept.length,
    })
  }
  const afterAtsGate = atsGateResult.kept

  // iter34 followup D.9 — recency hard filter (lastSeenAt < 7d, fallback 30d).
  // `firstSeenAt` is the batch-ingest timestamp (clusters at 30-50d ago) —
  // NOT a freshness signal. We use the inventory crawler's `lastSeenAt`,
  // dropping rows missing / unparseable (conservative: no-signal-no-row).
  const recencyResult = applyRecencyFilterWithFallback(afterAtsGate)
  log("[queryMatchingJobs] recency_filter_applied", {
    before: afterAtsGate.length,
    kept: recencyResult.kept.length,
    fallback: recencyResult.fallback,
    windowMs: recencyResult.windowMs,
  })
  const afterRecency = recencyResult.kept

  // iter34 followup D.13 — liveness hard filter. Drops rows the out-of-band
  // sweep flagged as dead (HEAD returned 4xx/5xx). `undefined` and `false`
  // are kept (legacy rows + alive rows).
  const livenessResult = applyLivenessFilter(afterRecency)
  if (livenessResult.rejected > 0) {
    log("[queryMatchingJobs] liveness_filter_rejected", {
      rejected: livenessResult.rejected,
      kept: livenessResult.kept.length,
    })
  }
  const filtered = livenessResult.kept

  const ranked = rankJobs(filtered, parsed.filters, parsed.limit)
  return { jobs: ranked }
}

export function createQueryMatchingJobsTool(deps: QueryMatchingJobsDeps) {
  return tool({
    name: "queryMatchingJobs",
    description:
      "Search the WeKruit matching-jobs corpus by industry / location / sponsorship / salary " +
      "and return the top N (default 5) ranked by skill overlap + recency. " +
      "Use this to surface a sample job to the candidate.",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parameters: QueryMatchingJobsInputSchema as any,
    execute: async (raw: unknown) => {
      const args = QueryMatchingJobsInputSchema.parse(raw)
      const out = await queryMatchingJobs(args, deps)
      return JSON.stringify(out)
    },
  })
}
