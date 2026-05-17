/**
 * iter34 Sprint A.8 — CV summary tag message helper.
 *
 * Adam directive (iter34 P3+P4 follow-up): once cv-ingest finishes parsing the
 * resume, surface what we extracted as a short friend-tone "tag-summary"
 * message before later matching/recommendation work. Lets the user verify
 * Claire actually read the resume + correct misreads before matches are sent.
 *
 * Inputs come from `parsedCandidateResumes/{userId}` (see cv-ingest.ts):
 *   - `topSkills` — iter 1 added; ranked top skills, prefer this over
 *     `candidateProfile.skills` which is unranked + noisy.
 *   - `experiences[0]` — most recent role; pull company + title for "@ X".
 *   - `industryTags` — kept available but currently unused in the surface
 *     line (skills + recent role is enough signal; prevents report-menu vibe).
 *
 * Output contract: ONE short line, friend-tone, lowercase-leaning. Three
 * lang variants:
 *   zh: "看下来你 Node.js / React / 阿里云 + 在 Tesla 做 SWE — 我会把这些作为你的资料证据"
 *   en: "I see Node.js / React / Aliyun + SWE @ Tesla; I’ll use that as profile evidence."
 *   mixed: "你 Node.js / React + Tesla SWE — 我会把这些作为 profile evidence"
 *
 * If the parsed CV is essentially empty (no skills + no experiences) →
 * fallback line that admits we didn't get much and we'll lean on the
 * conversation answers instead.
 */

/**
 * Loose shape — accepts anything that has the canonical cv-ingest fields.
 * Kept structural (not a class import) to avoid coupling pa-orchestrator
 * to the cv-ingest module location. Mirrors `CvProfileDoc` in
 * cv-context-injection.ts but adds the `topSkills` field iter 1 wrote.
 */
export interface CvSummaryInput {
  candidateProfile?: {
    skills?: string[]
    name?: string | null
  }
  /** iter34 iter 1 addition — ranked top skills. Prefer over candidateProfile.skills. */
  topSkills?: string[]
  experiences?: Array<{
    company?: string
    title?: string
  }>
  industryTags?: string[]
}

const MAX_SKILLS = 5
const MIN_SKILLS = 3

/**
 * Pick top N skills, prefer `topSkills` (ranked) → fall back to
 * `candidateProfile.skills`. Returns up to MAX_SKILLS, may return [] if
 * neither source has anything usable.
 */
function pickSkills(cv: CvSummaryInput): string[] {
  const ranked = Array.isArray(cv.topSkills)
    ? cv.topSkills.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    : []
  if (ranked.length > 0) return ranked.slice(0, MAX_SKILLS)
  const fallback = Array.isArray(cv.candidateProfile?.skills)
    ? cv.candidateProfile!.skills!.filter(
        (s): s is string => typeof s === "string" && s.trim().length > 0
      )
    : []
  return fallback.slice(0, MAX_SKILLS)
}

/**
 * Pull the most recent (experiences[0]) role's company + title.
 * Returns null if neither field is usable.
 */
function pickRecentRole(cv: CvSummaryInput): { company: string | null; title: string | null } | null {
  const experiences = Array.isArray(cv.experiences) ? cv.experiences : []
  const top = experiences[0]
  if (!top) return null
  const company =
    typeof top.company === "string" && top.company.trim().length > 0 ? top.company.trim() : null
  const title =
    typeof top.title === "string" && top.title.trim().length > 0 ? top.title.trim() : null
  if (!company && !title) return null
  return { company, title }
}

/**
 * Format a CV summary tag message for the user. See module doc for examples.
 *
 * @param cv  Parsed CV doc shape (see CvSummaryInput).
 * @param lang  "zh" | "en" | "mixed". For mixed, we keep skills/title in EN
 *               (technical nouns are typically English in mixed-register
 *               WeKruit chat) and the connectors/comments in ZH.
 * @returns Single short line. Always returns a non-empty string — falls
 *           back to a "couldn't extract much" message when the CV is empty.
 */
export function formatCvSummaryForUser(
  cv: CvSummaryInput,
  lang: "zh" | "en" | "mixed"
): string {
  const skills = pickSkills(cv)
  const role = pickRecentRole(cv)

  // Empty-CV fallback: literally nothing usable.
  if (skills.length === 0 && !role) {
    if (lang === "zh") return "看了一下, 信息不多, 我按你聊的方向先推"
    if (lang === "en") return "skimmed it — not much in there, i'll lean on what you told me"
    // mixed
    return "看了一下 CV, 信息不多, 我按你聊的方向先推"
  }

  // Skills slice: if we have ≥MIN_SKILLS use up to MAX_SKILLS; if we have
  // fewer than MIN_SKILLS, just use what's there (don't pad).
  const skillsList = skills.length > 0 ? skills.slice(0, MAX_SKILLS).join(" / ") : ""

  // Role chunk: prefer "title @ company" / "title at company"; fall back to
  // whichever single field is present.
  let roleZh: string | null = null
  let roleEn: string | null = null
  let roleMixed: string | null = null
  if (role) {
    if (role.title && role.company) {
      roleZh = `在 ${role.company} 做 ${role.title}`
      roleEn = `${role.title} @ ${role.company}`
      roleMixed = `${role.company} ${role.title}`
    } else if (role.title) {
      roleZh = `做 ${role.title}`
      roleEn = role.title
      roleMixed = role.title
    } else if (role.company) {
      roleZh = `在 ${role.company}`
      roleEn = `@ ${role.company}`
      roleMixed = role.company
    }
  }

  if (lang === "zh") {
    if (skillsList && roleZh) {
      return `看下来你 ${skillsList} + ${roleZh} — 我会把这些作为你的资料证据`
    }
    if (skillsList) return `看下来你 ${skillsList} — 我会把这些作为你的资料证据`
    if (roleZh) return `看下来你 ${roleZh} — 我会把这个作为你的资料证据`
    // unreachable; safety
    return "看了一下, 信息不多, 我按你聊的方向先推"
  }

  if (lang === "en") {
    if (skillsList && roleEn) {
      return `I see ${skillsList} + ${roleEn}; I’ll use that as profile evidence.`
    }
    if (skillsList) return `I see ${skillsList}; I’ll use that as profile evidence.`
    if (roleEn) return `I see ${roleEn}; I’ll use that as profile evidence.`
    return "skimmed it — not much in there, I’ll lean on what you told me."
  }

  // mixed — keep skills + role in EN (technical terms), connectors in ZH.
  // Adam constraint: 一条短句, 别报菜名 — single line, friend tone.
  if (skillsList && roleMixed) {
    return `你 ${skillsList} + ${roleMixed} — 我会把这些作为 profile evidence`
  }
  if (skillsList) return `你 ${skillsList} — 我会把这些作为 profile evidence`
  if (roleMixed) return `你 ${roleMixed} — 我会把这个作为 profile evidence`
  return "看了一下 CV, 信息不多, 我按你聊的方向先推"
}
