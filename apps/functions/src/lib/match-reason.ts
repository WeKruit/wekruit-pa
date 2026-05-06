/**
 * iter34 sprint B.11 — formatJobMatchReason
 *
 * Given a job carrying a `matchScore.breakdown` (attached by `rankJobs` in
 * @pa/job-rec), surface the top 1-2 weighted-contribution dimensions and
 * translate them into a short human-readable line for the iMessage compose
 * path. Replaces the previous "光秃秃 title + URL" output — users now see
 * a "为啥推:" / "why:" line that cites the strongest signal(s).
 *
 * Pure / deterministic. No LLM. No side effects. Designed to be reusable by
 * the daily-batch fallback path (D5) when no LLM-grounded reason is on file.
 *
 * Design notes
 * ------------
 *   - "Top" is ranked by *weighted contribution*, not raw component value.
 *     skillScore=1 contributes 0.35; locationScore=1 contributes 0.15. The
 *     first is far stronger evidence the job fits.
 *   - We deliberately drop the salary dim from rendering — the message
 *     "薪资到你 floor" is awkward in context and the contribution is tiny
 *     (weight 0.05).
 *   - Sponsorship is only surfaced when the user actively needs it (visa
 *     status implies they care). Citizens / GC holders shouldn't see
 *     "可以 sponsor" — it's noise.
 *   - Output length cap: ≤ 50 chars (zh) / 70 chars (en). Above the cap we
 *     drop the second clause. We never truncate mid-word.
 *   - Empty / missing breakdown → return "" so the caller's URL line is
 *     unchanged. `orchestrator-deps` simply skips the reason line on "".
 */

import type { ScoreBreakdown } from "@pa/job-rec"

/**
 * Score weight constants — kept in sync with `scoreJob` in
 * apps/job-rec/src/tools/query-matching-jobs.ts. Used here to convert raw
 * 0..1 component values into weighted contributions for ranking.
 *
 * Sum = 1.00. If `scoreJob` weights are re-balanced, update both call sites.
 */
const W_SKILL = 0.35
const W_EMBEDDING = 0.3
const W_SPONSORSHIP = 0.15
const W_LOCATION = 0.15
const W_SALARY = 0.05

/** Component identifier for ranking + rendering. */
type Dim = "skill" | "embedding" | "sponsorship" | "location" | "salary"

/** A weighted-contribution candidate to render. */
type Candidate = {
  dim: Dim
  /** weighted contribution = weight * raw component (0..1). */
  contribution: number
  /** raw component value (0..1). */
  raw: number
}

const MAX_LEN_ZH = 50
const MAX_LEN_EN = 70

export type JobReasonInput = {
  jobTitle?: string
  matchScore?: { breakdown: ScoreBreakdown }
  requiredSkills?: string[]
  locationRaw?: string
  sponsorship?: boolean | null
  industryEnum?: string[]
}

export type JobReasonUserContext = {
  /** Canonical role tokens (e.g. ["swe"]). */
  targetRole?: string[]
  /** User's top skills (case-insensitive intersection target). */
  userSkills?: string[]
  /** First entry of `statedPreferences.targetLocations`. */
  targetLocations?: string[]
  /** Visa status; "opt"/"h1b"/"sponsorship_needed" → user needs sponsor. */
  visaStatus?: string
}

/**
 * Format a "为啥推" reason line for a single job. Returns "" when no
 * breakdown is available so the caller can skip the line cleanly.
 */
export function formatJobMatchReason(
  job: JobReasonInput,
  lang: "zh" | "en" | "mixed",
  userContext?: JobReasonUserContext
): string {
  const breakdown = job.matchScore?.breakdown
  if (!breakdown) {
    // No score path — let the caller render bare title/url.
    return ""
  }

  // Build weighted-contribution candidates. Skip salary (weight 0.05, awkward
  // to render). Skip sponsorship when the user doesn't need it (citizens
  // don't care about "可以 sponsor"). Skip location when no preference set.
  const userNeedsSponsor = userNeedsSponsorship(userContext?.visaStatus)
  const userHasLocationPref = (userContext?.targetLocations ?? []).some(
    (s) => typeof s === "string" && s.trim().length > 0
  )

  const candidates: Candidate[] = []
  if (breakdown.skill > 0) {
    candidates.push({
      dim: "skill",
      contribution: breakdown.skill * W_SKILL,
      raw: breakdown.skill,
    })
  }
  if (breakdown.embedding > 0) {
    candidates.push({
      dim: "embedding",
      contribution: breakdown.embedding * W_EMBEDDING,
      raw: breakdown.embedding,
    })
  }
  // Sponsorship: only surface as a positive when user actively needs sponsor
  // AND the job offers it. raw must be high (≥0.9) to claim it positively.
  if (userNeedsSponsor && breakdown.sponsorship >= 0.9 && job.sponsorship === true) {
    candidates.push({
      dim: "sponsorship",
      contribution: breakdown.sponsorship * W_SPONSORSHIP,
      raw: breakdown.sponsorship,
    })
  }
  // Location: only surface when the user expressed a preference AND the
  // location ladder hit a strong rung (≥0.7 → at least remote-neighbor).
  if (userHasLocationPref && breakdown.location >= 0.7) {
    candidates.push({
      dim: "location",
      contribution: breakdown.location * W_LOCATION,
      raw: breakdown.location,
    })
  }

  if (candidates.length === 0) {
    // Nothing strong enough — fall back to a conservative phrase only when
    // total is non-trivial. Otherwise "" lets caller drop the line.
    if (breakdown.total >= 0.4) {
      return phraseFallback(lang)
    }
    return ""
  }

  // Sort by contribution desc, take top 2.
  candidates.sort((a, b) => b.contribution - a.contribution)
  const top = candidates.slice(0, 2)

  const phrases: string[] = []
  for (const c of top) {
    const phrase = renderPhrase(c, job, userContext, lang)
    if (phrase) phrases.push(phrase)
  }

  if (phrases.length === 0) return ""

  // Compose with a separator that fits the language.
  const sep = lang === "zh" ? ", " : ", "
  let out = phrases.join(sep)

  // Length cap — drop the second clause if needed.
  const cap = lang === "zh" ? MAX_LEN_ZH : MAX_LEN_EN
  if (out.length > cap && phrases.length > 1) {
    out = phrases[0]!
  }
  // Final hard cap (safety) — trim to char limit on word boundary.
  if (out.length > cap) {
    out = out.slice(0, cap).replace(/\s+\S*$/, "").trim()
  }
  return out
}

/** Visa-status → "user wants sponsor" boolean. */
function userNeedsSponsorship(visaStatus: string | undefined): boolean {
  if (!visaStatus) return false
  const v = visaStatus.toLowerCase().trim()
  return v === "opt" || v === "h1b" || v === "sponsorship_needed"
}

/**
 * Render a single dim's phrase. Returns "" when the dim can't produce a
 * specific human phrase (e.g. skill dim but no actual intersection found —
 * happens when scoreJob's Jaccard fired on a skill not in the surfaced
 * top-skills list).
 */
function renderPhrase(
  c: Candidate,
  job: JobReasonInput,
  userContext: JobReasonUserContext | undefined,
  lang: "zh" | "en" | "mixed"
): string {
  switch (c.dim) {
    case "skill": {
      const overlap = computeSkillOverlap(
        userContext?.userSkills ?? [],
        job.requiredSkills ?? []
      )
      if (overlap.length === 0) return ""
      const list = overlap.slice(0, 2).join(" + ")
      if (lang === "zh") return `${list} 命中`
      if (lang === "en") return `matches ${list}`
      // mixed
      return `${list} 命中`
    }
    case "embedding": {
      // Vibe / overall direction. The "整体方向贴你简历" line.
      const role = pickRoleLabel(userContext?.targetRole)
      if (lang === "zh") {
        return role ? `方向对得上你 ${role.upper}` : "整体方向贴你简历"
      }
      if (lang === "en") {
        return role ? `${role.upper}-aligned with your resume` : "lines up with your resume"
      }
      return role ? `${role.upper} direction` : "整体方向贴你简历"
    }
    case "sponsorship": {
      if (lang === "zh") return "可以 sponsor"
      if (lang === "en") return "offers sponsorship"
      return "可以 sponsor"
    }
    case "location": {
      const pref = (userContext?.targetLocations ?? [])[0] ?? ""
      const label = pref.toLowerCase().trim()
      if (lang === "zh") return label ? `地点 ${label} 对得上` : "地点对得上"
      if (lang === "en") return label ? `location ${label} fits` : "location fits"
      return label ? `${label} 地点对得上` : "地点对得上"
    }
    case "salary":
      // Intentional drop — see top-of-file rationale.
      return ""
  }
}

/** Pick a stable display token for a role list. Falls back to first entry. */
function pickRoleLabel(targetRole: string[] | undefined): { upper: string } | null {
  if (!Array.isArray(targetRole) || targetRole.length === 0) return null
  const first = targetRole[0]
  if (typeof first !== "string" || first.trim().length === 0) return null
  return { upper: first.toUpperCase() }
}

/**
 * Case-insensitive intersection of user skills and job required skills.
 * Returns the user's casing for the matched skills (so "Node.js" wins over
 * a corpus "node.js"). Up to 2 matches.
 */
function computeSkillOverlap(
  userSkills: readonly string[],
  required: readonly string[]
): string[] {
  if (!Array.isArray(userSkills) || userSkills.length === 0) return []
  if (!Array.isArray(required) || required.length === 0) return []
  const reqLower = new Set(
    required
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .map((s) => s.toLowerCase().trim())
  )
  const out: string[] = []
  for (const s of userSkills) {
    if (typeof s !== "string" || s.trim().length === 0) continue
    if (reqLower.has(s.toLowerCase().trim())) {
      out.push(s)
      if (out.length >= 2) break
    }
  }
  return out
}

/**
 * Conservative fallback phrase when no specific dim survives the gates but
 * the overall score is non-trivial. Used when the user has no skills /
 * location prefs AND no sponsorship need but the embedding cosine is decent.
 */
function phraseFallback(lang: "zh" | "en" | "mixed"): string {
  if (lang === "zh") return "整体方向贴近"
  if (lang === "en") return "overall fit"
  return "整体方向贴近"
}
