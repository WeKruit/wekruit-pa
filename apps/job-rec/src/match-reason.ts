/**
 * match-reason.ts — rich, multi-signal match-reason builder.
 *
 * Adam directive (2026-05-30): the "WHY CLAIRE MATCHED YOU" reason on
 * /me/matches was nonsense + thin ("Matches your resume skills: java,
 * javascript." / "Aligned with your target role area: software_engineering.").
 * The replacement must be a COMPELLING, SPECIFIC, recruiter-style pitch grounded
 * in the real fit signals.
 *
 * This module is the DETERMINISTIC, grounded reason composer. It is:
 *   - the FALLBACK when the LLM-composed reason is unavailable (offline / error
 *     / legacy rec doc with no stored reason), and
 *   - the structural template the LLM path is held to (same signals).
 *
 * It draws on the ACTUAL fit signals the matcher already computed:
 *   - role + stack fit (matched skills, roleFunction overlap)
 *   - seniority / careerStage fit
 *   - the candidate's STATED priority (targetCompanyTags / company-type
 *     preference, urgency)
 *   - company stage / size + industry sector overlap
 *   - location alignment
 *   - salary / growth angle
 *
 * It NEVER emits "matches skills: java, javascript." It composes a 1-2 sentence
 * pitch that names the specific bridge. Grounded ONLY in real facts passed in
 * (no hallucinated company claims — the deterministic path cannot invent).
 *
 * Pure / no Firestore. Unit-tested in __tests__/match-reason.test.ts.
 *
 * @module match-reason
 */

// ---------------------------------------------------------------------------
// Public input types — loose by design so BOTH the V16 matcher (typed UserTags
// + MatchingJob) and the /me API (raw Firestore Record maps) can call this
// without a shared narrow type.
// ---------------------------------------------------------------------------

/** A matched-skill contribution (subset of V16 MatchedSkillContribution). */
export type ReasonMatchedSkill = {
  name?: unknown
  proficiency?: unknown
}

/** Loose candidate-tag projection. Every field optional + defensively read. */
export type ReasonCandidate = {
  /** SkillEntry[] | string[] — the candidate's skill bag. */
  skills?: unknown
  /** Canonical role-function tokens (positive). */
  targetRoleFunction?: unknown
  roleFunction?: unknown
  targetRole?: unknown
  /** Canonical 13-token seniority. */
  careerStage?: unknown
  /** Industry sector preference (42-token vocab) + CV-derived. */
  industrySector?: unknown
  relevantIndustry?: unknown
  /** Company-size preference enum. */
  companySize?: unknown
  prefersStartup?: unknown
  /** Open-vocab company-type tokens the candidate said matter (stated priority). */
  targetCompanyTags?: unknown
  /** Actively-searching flag — surfaces an urgency/growth angle. */
  urgentlySeeking?: unknown
  /** Location hints from chat. */
  targetLocations?: unknown
  /** Salary floor (USD). */
  minSalary?: unknown
  /** Output language. */
  preferredLang?: unknown
}

/** Loose job projection — reads whatever fields the doc carries. */
export type ReasonJob = {
  jobTitle?: unknown
  roleTitle?: unknown
  title?: unknown
  companyName?: unknown
  company?: unknown
  roleFunction?: unknown
  requiredSkills?: unknown
  industrySector?: unknown
  industryEnum?: unknown
  seniorityLevel?: unknown
  companySize?: unknown
  companyStage?: unknown
  jobType?: unknown
  locationRaw?: unknown
  location?: unknown
  locationBuckets?: unknown
  salaryMin?: unknown
  salaryMax?: unknown
}

/** Optional V16 score breakdown — lets the reason foreground the strongest axis. */
export type ReasonScoreBreakdown = {
  industrySector?: unknown
  cvEmbCosine?: unknown
  tagOverlap?: unknown
  companyStageBoost?: unknown
  freshnessBoost?: unknown
  urgencyBoost?: unknown
}

export type BuildRichMatchReasonInput = {
  candidate: ReasonCandidate
  job: ReasonJob
  /** Top matched skills (V16 MatchedSkillContribution[]). */
  matchedSkills?: ReasonMatchedSkill[]
  /** Optional V16 score breakdown. */
  breakdown?: ReasonScoreBreakdown
  /** Optional precomputed company-tag overlap (stated-priority hits). */
  companyTagHits?: string[]
  lang?: "zh" | "en"
}

// ---------------------------------------------------------------------------
// Defensive readers
// ---------------------------------------------------------------------------

function str(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined
  const t = v.trim()
  return t.length > 0 ? t : undefined
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

/** Normalize a value into a clean lowercase token list (skills/tags/roles). */
function tokenList(v: unknown, max = 40): string[] {
  const out: string[] = []
  const ingest = (item: unknown) => {
    if (typeof item === "string") {
      const t = item.trim()
      if (t) out.push(t)
    } else if (item && typeof item === "object") {
      const name = (item as Record<string, unknown>).name
      if (typeof name === "string" && name.trim()) out.push(name.trim())
    }
  }
  if (Array.isArray(v)) {
    for (const item of v) {
      ingest(item)
      if (out.length >= max) break
    }
  } else {
    ingest(v)
  }
  return out
}

function lower(s: string): string {
  return s.trim().toLowerCase()
}

/** Humanize a canonical snake_case token: "software_engineering" → "software engineering". */
export function humanizeToken(token: string): string {
  return token.replace(/_/g, " ").trim()
}

/** Intersection of two token lists, case-insensitive, preserving the first list's casing. */
function overlap(a: string[], b: string[]): string[] {
  const bset = new Set(b.map(lower))
  const seen = new Set<string>()
  const out: string[] = []
  for (const x of a) {
    const k = lower(x)
    if (bset.has(k) && !seen.has(k)) {
      seen.add(k)
      out.push(x)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Company-stage / size phrasing
// ---------------------------------------------------------------------------

const COMPANY_SIZE_PHRASE_EN: Record<string, string> = {
  seed: "an early-stage startup",
  early_startup: "an early-stage startup",
  scale_up: "a fast-scaling startup",
  mid_market: "a mid-size company",
  enterprise: "a large enterprise",
}

const COMPANY_SIZE_PHRASE_ZH: Record<string, string> = {
  seed: "早期初创",
  early_startup: "早期初创",
  scale_up: "快速扩张期公司",
  mid_market: "中型公司",
  enterprise: "大型企业",
}

/** Map a free-text/canonical company-stage signal to a candidate-facing phrase. */
function companyStagePhrase(job: ReasonJob, lang: "zh" | "en"): string | undefined {
  const raw =
    str(job.companySize) ??
    str(job.companyStage)
  if (!raw) return undefined
  const key = lower(raw).replace(/[\s-]+/g, "_")
  const table = lang === "zh" ? COMPANY_SIZE_PHRASE_ZH : COMPANY_SIZE_PHRASE_EN
  if (table[key]) return table[key]
  // Heuristic fallbacks for free-text stage values.
  if (/seed|pre[-_ ]?seed|series[\s-]?a|early/.test(lower(raw))) {
    return lang === "zh" ? "早期初创" : "an early-stage startup"
  }
  if (/series[\s-]?[b-d]|scale|growth/.test(lower(raw))) {
    return lang === "zh" ? "快速扩张期公司" : "a fast-scaling startup"
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Seniority fit
// ---------------------------------------------------------------------------

const SENIORITY_ORDER = [
  "intern",
  "internship",
  "entry",
  "entry_level",
  "new_grad",
  "new_graduate",
  "junior",
  "associate",
  "mid",
  "mid_level",
  "intermediate",
  "senior",
  "staff",
  "principal",
  "lead",
  "manager",
  "director",
  "vp",
  "executive",
]

function seniorityRank(token: string | undefined): number | undefined {
  if (!token) return undefined
  const k = lower(token).replace(/[\s-]+/g, "_")
  const idx = SENIORITY_ORDER.indexOf(k)
  return idx >= 0 ? idx : undefined
}

const SENIORITY_PHRASE_EN: Record<string, string> = {
  intern: "the internship level",
  internship: "the internship level",
  entry: "the junior level",
  entry_level: "the junior level",
  new_grad: "the new-grad level",
  new_graduate: "the new-grad level",
  junior: "the junior level",
  associate: "the associate level",
  mid: "the mid level",
  mid_level: "the mid level",
  intermediate: "the mid level",
  senior: "the senior level",
  staff: "the staff level",
  principal: "the principal level",
  lead: "the lead level",
}

function seniorityPhrase(token: string | undefined, lang: "zh" | "en"): string | undefined {
  if (!token) return undefined
  const k = lower(token).replace(/[\s-]+/g, "_")
  if (lang === "zh") return undefined // zh path keeps it implicit (handled in zh composer)
  return SENIORITY_PHRASE_EN[k]
}

// ---------------------------------------------------------------------------
// Stated-priority phrasing
// ---------------------------------------------------------------------------

/**
 * Map a candidate company-type tag (open vocab, e.g. "high_growth",
 * "equity_upside", "compensation", "work_life_balance", "mission_driven") to a
 * candidate-facing "what you said matters" phrase. Falls back to the humanized
 * token so an unmapped value still reads sensibly.
 */
const PRIORITY_PHRASE_EN: Record<string, string> = {
  compensation: "the comp",
  comp: "the comp",
  high_comp: "the strong comp",
  salary: "the comp",
  equity: "the equity upside",
  equity_upside: "the equity upside",
  early_equity: "early equity",
  ownership: "real ownership",
  high_growth: "fast growth",
  growth: "career growth",
  career_growth: "career growth",
  mission_driven: "mission-driven work",
  mission: "mission-driven work",
  work_life_balance: "work-life balance",
  remote: "remote flexibility",
  fast_paced: "a fast-paced environment",
  impact: "high impact",
  learning: "room to learn fast",
}

function priorityPhrase(token: string, lang: "zh" | "en"): string {
  const k = lower(token).replace(/[\s-]+/g, "_")
  if (lang === "en") return PRIORITY_PHRASE_EN[k] ?? humanizeToken(token)
  return humanizeToken(token)
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

/**
 * Compose a compelling, specific, multi-signal match reason. Returns a single
 * string (1-2 sentences). Always non-empty (worst case: a grounded role/stack
 * line). Never the old "matches skills: a, b." template.
 */
export function buildRichMatchReason(input: BuildRichMatchReasonInput): string {
  const lang: "zh" | "en" =
    input.lang === "zh"
      ? "zh"
      : input.lang === "en"
        ? "en"
        : str(input.candidate.preferredLang) === "zh"
          ? "zh"
          : "en"

  const c = input.candidate
  const j = input.job
  const breakdown = input.breakdown ?? {}

  const jobTitle = str(j.jobTitle) ?? str(j.roleTitle) ?? str(j.title)
  const company = str(j.companyName) ?? str(j.company)

  // --- Signal extraction ----------------------------------------------------
  // 1. Matched skills (strongest, most specific). Prefer the V16 matched list;
  //    fall back to candidate-skills ∩ job-required-skills.
  const matchedFromV16 = (input.matchedSkills ?? [])
    .map((m) => str(m?.name))
    .filter((x): x is string => !!x)
  const candidateSkills = tokenList(c.skills)
  const jobSkills = tokenList(j.requiredSkills)
  const skillOverlap = overlap(candidateSkills, jobSkills)
  const matchedSkills = (matchedFromV16.length > 0 ? matchedFromV16 : skillOverlap).slice(0, 3)

  // 2. Role fit
  const candidateRoles = [
    ...tokenList(c.targetRoleFunction),
    ...tokenList(c.roleFunction),
    ...tokenList(c.targetRole),
  ]
  const jobRoles = tokenList(j.roleFunction)
  const roleHit = overlap(candidateRoles, jobRoles)[0]

  // 3. Seniority fit
  const candidateStage = str(c.careerStage)
  const jobSeniority = str(j.seniorityLevel)
  const candRank = seniorityRank(candidateStage)
  const jobRank = seniorityRank(jobSeniority)
  const seniorityAligned =
    candRank !== undefined && jobRank !== undefined && Math.abs(candRank - jobRank) <= 1

  // 4. Industry overlap
  const candidateIndustries = [
    ...tokenList(c.industrySector),
    ...tokenList(c.relevantIndustry),
  ]
  const jobIndustries = [...tokenList(j.industrySector), ...tokenList(j.industryEnum)]
  const industryHit = overlap(candidateIndustries, jobIndustries)[0]

  // 5. Company stage
  const stagePhrase = companyStagePhrase(j, lang)
  const stageWanted =
    (str(c.companySize) && lower(str(c.companySize)!) !== "open") ||
    (str(c.prefersStartup) && lower(str(c.prefersStartup)!) !== "either")

  // 6. Stated priority (the candidate's "what matters most" — targetCompanyTags)
  const priorityHits =
    input.companyTagHits && input.companyTagHits.length > 0
      ? input.companyTagHits
      : tokenList(c.targetCompanyTags).slice(0, 2)

  // 7. Location
  const candidateLocations = tokenList(c.targetLocations).map(lower)
  const jobLoc = lower(str(j.locationRaw) ?? str(j.location) ?? "")
  const jobLocBuckets = tokenList(j.locationBuckets).map(lower)
  const locationAligned =
    candidateLocations.length > 0 &&
    jobLoc.length > 0 &&
    candidateLocations.some(
      (loc) =>
        loc === "anywhere" ||
        loc === "remote" ||
        jobLoc.includes(loc) ||
        loc.includes(jobLoc) ||
        jobLocBuckets.some((b) => b.includes(loc) || loc.includes(b)),
    )
  const wantsRemote = candidateLocations.includes("remote") && /remote/.test(jobLoc)

  // 8. Salary / growth
  const minSalary = num(c.minSalary)
  const jobSalaryMax = num(j.salaryMax)
  const salaryClears = minSalary !== undefined && jobSalaryMax !== undefined && jobSalaryMax >= minSalary

  // --- Compose --------------------------------------------------------------
  return lang === "zh"
    ? composeZh({
        jobTitle,
        company,
        stagePhrase,
        matchedSkills,
        roleHit,
        seniorityAligned,
        candidateStage,
        industryHit,
        priorityHits,
        locationAligned,
        wantsRemote,
        salaryClears,
      })
    : composeEn({
        jobTitle,
        company,
        stagePhrase,
        stageWanted: !!stageWanted,
        matchedSkills,
        roleHit,
        seniorityAligned,
        seniorityPhraseStr: seniorityPhrase(jobSeniority ?? candidateStage, "en"),
        industryHit,
        priorityHits,
        locationAligned,
        wantsRemote,
        salaryClears,
      })
}

// ---------------------------------------------------------------------------
// English composer — recruiter-style 1-2 sentence pitch.
// ---------------------------------------------------------------------------

type ComposeEnArgs = {
  jobTitle?: string
  company?: string
  stagePhrase?: string
  stageWanted: boolean
  matchedSkills: string[]
  roleHit?: string
  seniorityAligned: boolean
  seniorityPhraseStr?: string
  industryHit?: string
  priorityHits: string[]
  locationAligned: boolean
  wantsRemote: boolean
  salaryClears: boolean
}

function joinSkills(skills: string[]): string {
  const parts = skills.map(humanizeToken)
  if (parts.length === 1) return parts[0]!
  if (parts.length === 2) return `${parts[0]} + ${parts[1]}`
  return `${parts.slice(0, -1).join(", ")} + ${parts[parts.length - 1]}`
}

function composeEn(a: ComposeEnArgs): string {
  // Lead clause: the role at the company (+ stage), or a graceful role-only lead.
  const roleNoun = a.roleHit ? humanizeToken(a.roleHit) : a.jobTitle ? a.jobTitle : "role"
  let lead: string
  if (a.jobTitle && a.company && a.stagePhrase) {
    lead = `${a.jobTitle} at ${a.company}, ${a.stagePhrase}`
  } else if (a.jobTitle && a.company) {
    lead = `${a.jobTitle} at ${a.company}`
  } else if (a.jobTitle) {
    lead = a.jobTitle
  } else if (a.stagePhrase) {
    lead = `a ${roleNoun} role at ${a.stagePhrase}`
  } else {
    lead = `a ${roleNoun} role`
  }

  // Fit clauses — ordered by strength.
  const fits: string[] = []
  if (a.matchedSkills.length > 0) {
    fits.push(`your ${joinSkills(a.matchedSkills)} background fits the stack`)
  } else if (a.roleHit) {
    fits.push(`it sits squarely in ${humanizeToken(a.roleHit)}, your target area`)
  }
  if (a.seniorityAligned && a.seniorityPhraseStr) {
    fits.push(`${a.seniorityPhraseStr} lines up`)
  } else if (a.seniorityAligned) {
    fits.push(`the seniority lines up`)
  }
  if (a.industryHit) {
    fits.push(`it's in ${humanizeToken(a.industryHit)}, where you've worked`)
  }
  if (a.locationAligned) {
    fits.push(a.wantsRemote ? `it's remote like you wanted` : `the location works for you`)
  }

  // Priority clause — what the candidate said matters most.
  let priorityClause = ""
  if (a.priorityHits.length > 0) {
    const phrases = a.priorityHits.map((p) => priorityPhrase(p, "en"))
    const joined =
      phrases.length === 1
        ? phrases[0]
        : `${phrases.slice(0, -1).join(", ")} and ${phrases[phrases.length - 1]}`
    priorityClause = `it leans into ${joined} you said matter most`
  } else if (a.salaryClears) {
    priorityClause = `the comp clears your floor`
  } else if (a.stagePhrase && a.stageWanted) {
    priorityClause = `it's the company stage you're after`
  }

  // Assemble. First sentence = lead + strongest 1-2 fits. Second = priority.
  const primaryFits = fits.slice(0, 2)
  let sentence1: string
  if (primaryFits.length > 0) {
    sentence1 = `${lead} — ${primaryFits.join(", and ")}.`
  } else {
    sentence1 = `${lead} — a strong fit on your saved profile.`
  }

  if (priorityClause) {
    const cap = priorityClause.charAt(0).toUpperCase() + priorityClause.slice(1)
    return `${sentence1} ${cap}.`
  }
  // No explicit priority signal: fold a 3rd fit in if we have one, else stop.
  const extraFit = fits[2]
  if (extraFit) {
    const cap = extraFit.charAt(0).toUpperCase() + extraFit.slice(1)
    return `${sentence1} ${cap}.`
  }
  return sentence1
}

// ---------------------------------------------------------------------------
// Chinese composer.
// ---------------------------------------------------------------------------

type ComposeZhArgs = {
  jobTitle?: string
  company?: string
  stagePhrase?: string
  matchedSkills: string[]
  roleHit?: string
  seniorityAligned: boolean
  candidateStage?: string
  industryHit?: string
  priorityHits: string[]
  locationAligned: boolean
  wantsRemote: boolean
  salaryClears: boolean
}

function composeZh(a: ComposeZhArgs): string {
  const roleNoun = a.roleHit ? humanizeToken(a.roleHit) : a.jobTitle ?? "这个岗位"
  let lead: string
  if (a.jobTitle && a.company && a.stagePhrase) {
    lead = `${a.company} 这个 ${a.jobTitle}（${a.stagePhrase}）`
  } else if (a.jobTitle && a.company) {
    lead = `${a.company} 的 ${a.jobTitle}`
  } else if (a.jobTitle) {
    lead = a.jobTitle
  } else if (a.stagePhrase) {
    lead = `${a.stagePhrase}的 ${roleNoun} 岗`
  } else {
    lead = `${roleNoun} 岗`
  }

  const fits: string[] = []
  if (a.matchedSkills.length > 0) {
    fits.push(`你的 ${joinSkills(a.matchedSkills)} 跟这岗位的技术栈对得上`)
  } else if (a.roleHit) {
    fits.push(`正好在你的目标方向 ${humanizeToken(a.roleHit)} 上`)
  }
  if (a.seniorityAligned) fits.push("级别也对得上")
  if (a.industryHit) fits.push(`又是你做过的 ${humanizeToken(a.industryHit)} 行业`)
  if (a.locationAligned) fits.push(a.wantsRemote ? "而且是你想要的 remote" : "地点也合适")

  let priorityClause = ""
  if (a.priorityHits.length > 0) {
    priorityClause = `而且它正好踩中你最看重的 ${a.priorityHits.map((p) => priorityPhrase(p, "zh")).join("、")}`
  } else if (a.salaryClears) {
    priorityClause = "薪资也过了你的底线"
  }

  const primaryFits = fits.slice(0, 3)
  let s1: string
  if (primaryFits.length > 0) {
    s1 = `${lead}，${primaryFits.join("，")}。`
  } else {
    s1 = `${lead}，整体跟你的画像挺合。`
  }
  return priorityClause ? `${s1}${priorityClause}。` : s1
}
