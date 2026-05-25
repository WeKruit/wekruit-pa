import {
  CAREER_STAGE_VOCAB,
  INDUSTRY_SECTOR_VOCAB,
  JOB_TYPE_VOCAB,
  ROLE_FUNCTION_VOCAB,
  type CareerStage,
  type JobType,
  type RoleFunction,
} from "@wekruit/shared-tags"

type AnyRecord = Record<string, unknown>

export type ResumeBaselinePatch = {
  proposed: Record<string, unknown>
  sources: Record<string, string>
  reasoning: Record<string, string>
  confidence: Record<string, number>
}

export type ResumeBaselineInput = {
  existingTags?: AnyRecord | null
  mergedTags?: AnyRecord | null
  statedPreferences?: AnyRecord | null
  parsedResume?: AnyRecord | null
  nowYear?: number
}

const ROLE_SET = new Set<string>(ROLE_FUNCTION_VOCAB)
const STAGE_SET = new Set<string>(CAREER_STAGE_VOCAB)
const JOB_TYPE_SET = new Set<string>(JOB_TYPE_VOCAB)
const INDUSTRY_SECTOR_SET = new Set<string>(INDUSTRY_SECTOR_VOCAB)

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function lowerText(values: unknown[]): string {
  return values
    .map((value) => stringValue(value))
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    const normalized = stringValue(raw).toLowerCase()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  return out
}

function validTokenArray(value: unknown, valid: Set<string>): string[] {
  return stringArray(value).filter((token) => valid.has(token))
}

function axisPresent(value: unknown): boolean {
  if (value == null) return false
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === "string") return value.trim().length > 0
  return true
}

function firstAxis(input: ResumeBaselineInput, axis: string): unknown {
  const existing = input.existingTags?.[axis]
  if (axisPresent(existing)) return existing
  const merged = input.mergedTags?.[axis]
  if (axisPresent(merged)) return merged
  return undefined
}

function axisMissing(input: ResumeBaselineInput, axis: string): boolean {
  return !axisPresent(firstAxis(input, axis))
}

function objectArray(value: unknown): AnyRecord[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is AnyRecord => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)))
}

function collectWorkEntries(resume: AnyRecord | null | undefined): AnyRecord[] {
  if (!resume) return []
  const workHistory = objectArray(resume.workHistory)
  const experiences = objectArray(resume.experiences)
  const out: AnyRecord[] = []
  const seen = new Set<string>()
  for (const entry of [...workHistory, ...experiences]) {
    const key = lowerText([entry.title, entry.role, entry.company, entry.startDate, entry.endDate])
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(entry)
  }
  return out
}

function collectEducation(resume: AnyRecord | null | undefined): AnyRecord[] {
  return resume ? objectArray(resume.education) : []
}

function collectSkills(resume: AnyRecord | null | undefined): string[] {
  const raw: unknown[] = []
  const profile = resume?.candidateProfile
  if (profile && typeof profile === "object" && !Array.isArray(profile)) {
    raw.push(...stringArray((profile as AnyRecord).skills))
  }
  raw.push(...stringArray(resume?.skills))
  raw.push(...stringArray(resume?.topSkills))
  for (const entry of collectWorkEntries(resume)) raw.push(...stringArray(entry.skills))
  return stringArray(raw)
}

function parseYear(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const year = Math.trunc(value)
    return year >= 1970 && year <= 2035 ? year : null
  }
  if (typeof value !== "string") return null
  const match = value.match(/\b(19[7-9]\d|20[0-3]\d)\b/)
  return match ? Number(match[1]) : null
}

function isPresentDate(value: unknown): boolean {
  return typeof value === "string" && /\b(present|current|now|ongoing)\b/i.test(value)
}

function inferExperienceYears(work: AnyRecord[], nowYear: number): number | null {
  let earliest: number | null = null
  let latest: number | null = null
  for (const entry of work) {
    const start = parseYear(entry.startDate ?? entry.start ?? entry.from)
    const endRaw = entry.endDate ?? entry.end ?? entry.to
    const parsedEnd = isPresentDate(endRaw) ? nowYear : parseYear(endRaw)
    const end = start != null && (isPresentDate(endRaw) || endRaw == null) ? nowYear : parsedEnd
    if (start == null && end == null) continue
    const s = start ?? end
    const e = end ?? start
    if (s == null || e == null) continue
    earliest = earliest == null ? s : Math.min(earliest, s)
    latest = latest == null ? e : Math.max(latest, e)
  }
  if (earliest == null || latest == null) return null
  return Math.max(0, latest - earliest)
}

function yoeRangeForYears(years: number): [number, number] {
  if (years <= 1) return [0, 1]
  if (years <= 3) return [1, 3]
  if (years <= 5) return [3, 5]
  if (years <= 8) return [5, 8]
  if (years <= 12) return [8, 12]
  return [12, 20]
}

function yoeRangeFromUnknown(value: unknown): [number, number] | null {
  if (Array.isArray(value) && value.length === 2) {
    const min = Number(value[0])
    const max = Number(value[1])
    if (Number.isFinite(min) && Number.isFinite(max)) return [min, max]
  }
  return null
}

function careerStageFromYoeRange(range: [number, number]): CareerStage {
  const max = Math.max(range[0], range[1])
  if (max <= 3) return "entry_level"
  if (max <= 5) return "mid_level"
  if (max <= 8) return "senior"
  if (max <= 12) return "staff"
  return "principal"
}

function recentTitle(work: AnyRecord[]): string {
  const entry = work[0]
  return entry ? lowerText([entry.title, entry.role]) : ""
}

function hasActiveEducation(education: AnyRecord[], nowYear: number): boolean {
  return education.some((entry) => {
    const end = parseYear(entry.endDate ?? entry.graduationYear ?? entry.expectedGraduation)
    return end != null && end >= nowYear
  })
}

function inferStageFromTitles(work: AnyRecord[], education: AnyRecord[], nowYear: number): CareerStage | null {
  const title = recentTitle(work)
  const allTitles = lowerText(work.flatMap((entry) => [entry.title, entry.role]))
  if (/\b(c[- ]?level|chief|ceo|cto|cfo|coo)\b/.test(title)) return "c_level"
  if (/\bvp|vice president\b/.test(title)) return "vp"
  if (/\bdirector\b/.test(title)) return "director"
  if (/\bfounder|co[- ]?founder\b/.test(title)) return "founder"
  if (/\bmanager|lead\b/.test(title) && !/\bintern\b/.test(title)) return "manager"
  if (/\bintern(ship)?\b|co[- ]?op\b/.test(allTitles)) return "intern"
  if (hasActiveEducation(education, nowYear) && work.length === 0) return "student"
  if (/\b(senior|sr\.?)\b/.test(title)) return "senior"
  if (/\bjunior|entry[- ]?level|associate|new grad|graduate\b/.test(title)) return "entry_level"
  return null
}

function inferYoeRange(input: ResumeBaselineInput, work: AnyRecord[], education: AnyRecord[], nowYear: number): [number, number] | null {
  const explicit = yoeRangeFromUnknown(firstAxis(input, "yoeRange")) ?? yoeRangeFromUnknown(input.statedPreferences?.yoeRange)
  if (explicit) return explicit
  const title = recentTitle(work)
  if (/\bintern(ship)?\b|co[- ]?op\b/.test(title)) return [0, 1]
  const years = inferExperienceYears(work, nowYear)
  if (years != null) return yoeRangeForYears(years)
  const stage = inferStageFromTitles(work, education, nowYear)
  if (stage === "entry_level" || stage === "student" || stage === "intern") return [0, 1]
  if (stage === "mid_level" || stage === "manager") return [3, 5]
  if (stage === "senior" || stage === "director") return [5, 8]
  return null
}

function addScore(scores: Map<RoleFunction, number>, role: RoleFunction, weight: number): void {
  scores.set(role, (scores.get(role) ?? 0) + weight)
}

function scoreRoles(work: AnyRecord[], education: AnyRecord[], skills: string[]): RoleFunction[] {
  const scores = new Map<RoleFunction, number>()
  const titleTexts = work.map((entry, idx) => ({ text: lowerText([entry.title, entry.role, entry.description]), weight: idx === 0 ? 5 : 2 }))
  const skillText = skills.join(" ").toLowerCase()
  const eduText = lowerText(education.flatMap((entry) => [entry.degree, entry.field, entry.major]))

  for (const { text, weight } of titleTexts) {
    if (/\b(data scientist|data analyst|analytics?|business intelligence|bi engineer|machine learning|ml engineer|forecasting)\b/.test(text)) addScore(scores, "data_analysis", weight)
    if (/\b(product manager|product management|product owner|technical product manager|\bpm\b)\b/.test(text)) addScore(scores, "product_management", weight)
    if (/\b(product marketing|marketing|growth|brand|content|social media|seo|sem|campaign|lifecycle|retention|acquisition|digital)\b/.test(text)) addScore(scores, "marketing", weight)
    if (/\b(business analyst|implementation manager|systems analyst|operations analyst|strategy analyst)\b/.test(text)) addScore(scores, "business_analyst", weight)
    if (/\b(software engineer|software developer|backend|frontend|full[- ]?stack|developer|swe|sde|programmer)\b/.test(text)) addScore(scores, "software_engineering", weight)
    if (/\b(electrical|mechanical|controls?|industrial|civil|manufacturing|hardware) engineer\b/.test(text)) addScore(scores, "engineering_and_development", weight)
    if (/\b(designer|ux|ui|visual design|graphic design)\b/.test(text)) addScore(scores, "creatives_and_design", weight)
    if (/\b(sales|account executive|business development|customer success)\b/.test(text)) addScore(scores, "sales", weight)
    if (/\b(finance|accounting|financial analyst|fp&a)\b/.test(text)) addScore(scores, "accounting_and_finance", weight)
    if (/\b(recruiter|talent acquisition|human resources|people operations)\b/.test(text)) addScore(scores, "human_resources", weight)
    if (/\b(teacher|tutor|teaching|education)\b/.test(text)) addScore(scores, "education_and_training", weight)
    if (/\b(legal|compliance|paralegal|counsel)\b/.test(text)) addScore(scores, "legal_and_compliance", weight)
    if (/\b(customer support|customer service|support specialist)\b/.test(text)) addScore(scores, "customer_service_and_support", weight)
  }

  if (/\b(sql|tableau|power_bi|power bi|looker|snowflake|dbt|pandas|numpy|forecasting|statistics)\b/.test(skillText)) addScore(scores, "data_analysis", 2)
  if (/\b(roadmapping|product_strategy|product strategy|user research)\b/.test(skillText)) addScore(scores, "product_management", 2)
  if (/\b(marketing|seo|sem|campaign|google analytics|lifecycle|retention|acquisition|content)\b/.test(skillText)) addScore(scores, "marketing", 2)
  if (/\b(react|typescript|javascript|node|java|c\+\+|kubernetes|docker|aws|gcp|azure)\b/.test(skillText)) addScore(scores, "software_engineering", 2)
  if (/\b(computer science|software engineering)\b/.test(eduText)) addScore(scores, "software_engineering", 1)
  if (/\b(data science|statistics|analytics|information systems)\b/.test(eduText)) addScore(scores, "data_analysis", 1)
  if (/\b(marketing|communications)\b/.test(eduText)) addScore(scores, "marketing", 1)

  const priority: RoleFunction[] = [
    "data_analysis",
    "product_management",
    "software_engineering",
    "marketing",
    "business_analyst",
    "engineering_and_development",
    "creatives_and_design",
    "sales",
    "accounting_and_finance",
    "human_resources",
    "education_and_training",
    "legal_and_compliance",
    "customer_service_and_support",
    "management_and_executive",
  ]
  return [...scores.entries()]
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1] || priority.indexOf(a[0]) - priority.indexOf(b[0]))
    .map(([role]) => role)
    .slice(0, 3)
}

function inferJobType(
  work: AnyRecord[],
  education: AnyRecord[],
  hasResumeSignal: boolean,
  nowYear: number,
  inferredYoe: [number, number] | null,
): JobType[] {
  const text = lowerText([
    ...work.flatMap((entry) => [entry.title, entry.role, entry.description]),
    ...education.flatMap((entry) => [entry.degree, entry.field]),
  ])
  const activeEducation = hasActiveEducation(education, nowYear)
  const recent = recentTitle(work)
  const recentEntry = work[0]
  const recentExperienceType = lowerText([recentEntry?.experienceType])
  const allWorkIsInternship =
    work.length > 0 &&
    work.every((entry) => /\bintern(ship)?\b|co[- ]?op\b/i.test(lowerText([entry.title, entry.role, entry.experienceType])))
  const yoeMax = inferredYoe ? Math.max(inferredYoe[0], inferredYoe[1]) : null
  const isEarlyCareer = yoeMax == null || yoeMax <= 3
  const hasRecentInternshipIntent =
    /\bintern(ship)?\b/.test(recent) ||
    /\bintern(ship)?\b/.test(recentExperienceType) ||
    allWorkIsInternship
  const hasRecentCoopIntent =
    /\bco[- ]?op\b/.test(recent) ||
    /\bco[- ]?op\b/.test(recentExperienceType)

  if (hasRecentCoopIntent && (isEarlyCareer || activeEducation || allWorkIsInternship)) return ["co_op_rotation"]
  if (hasRecentInternshipIntent && (isEarlyCareer || activeEducation || allWorkIsInternship)) return ["internship"]
  if (/\bnew grad|new graduate|recent graduate|graduate program\b/.test(text)) return ["new_graduate"]
  if (/\bcontract(or)?\b/.test(text)) return ["contract"]
  if (/\bpart[- ]?time\b/.test(text)) return ["part_time"]
  if (/\bfreelance|self[- ]?employed\b/.test(text)) return ["freelance"]
  if (/\bfellow(ship)?\b/.test(text)) return ["fellowship"]
  if (/\bapprentice(ship)?\b/.test(text)) return ["apprenticeship"]
  if (hasActiveEducation(education, nowYear) && work.length === 0) return ["new_graduate"]
  return hasResumeSignal ? ["full_time"] : []
}

function hasOnlyOther(value: unknown): boolean {
  const arr = stringArray(value)
  return arr.length === 0 || arr.every((item) => item === "other")
}

function addProposal(out: ResumeBaselinePatch, key: string, value: unknown, source: string, reasoning: string, confidence = 0.75): void {
  if (!axisPresent(value)) return
  out.proposed[key] = value
  out.sources[key] = source
  out.reasoning[key] = reasoning
  out.confidence[key] = confidence
}

export function computeResumeBaselineTagPatch(input: ResumeBaselineInput): ResumeBaselinePatch {
  const out: ResumeBaselinePatch = { proposed: {}, sources: {}, reasoning: {}, confidence: {} }
  const resume = input.parsedResume
  if (!resume || typeof resume !== "object" || Array.isArray(resume)) return out

  const nowYear = input.nowYear ?? new Date().getUTCFullYear()
  const work = collectWorkEntries(resume)
  const education = collectEducation(resume)
  const skills = collectSkills(resume)
  const hasResumeSignal = work.length > 0 || education.length > 0 || skills.length > 0

  if (axisMissing(input, "targetRoleFunction")) {
    const roles = scoreRoles(work, education, skills)
    if (roles.length > 0) {
      addProposal(out, "targetRoleFunction", roles, "resume_baseline", `roles inferred from recent titles, skills, and education`, 0.78)
    }
  }

  const inferredYoe = inferYoeRange(input, work, education, nowYear)
  if (axisMissing(input, "yoeRange") && inferredYoe) {
    addProposal(out, "yoeRange", inferredYoe, "resume_baseline", `yoe inferred from resume dates/titles`, 0.72)
  }

  if (axisMissing(input, "careerStage")) {
    const stageFromTitle = inferStageFromTitles(work, education, nowYear)
    const stage = stageFromTitle ?? (inferredYoe ? careerStageFromYoeRange(inferredYoe) : null)
    if (stage && STAGE_SET.has(stage)) {
      addProposal(out, "careerStage", stage, "resume_baseline", `career stage inferred from resume titles and YoE`, 0.74)
    }
  }

  if (axisMissing(input, "targetJobType")) {
    const jobTypes = inferJobType(work, education, hasResumeSignal, nowYear, inferredYoe).filter((token) => JOB_TYPE_SET.has(token))
    if (jobTypes.length > 0) {
      addProposal(out, "targetJobType", jobTypes, "resume_baseline", `job type inferred from explicit resume signals or conservative full-time default`, 0.7)
    }
  }

  if (axisMissing(input, "industrySector")) {
    const industrySector = validTokenArray(resume.industrySector ?? resume.industries, INDUSTRY_SECTOR_SET)
    if (industrySector.length > 0) addProposal(out, "industrySector", industrySector, "resume_baseline", "industry sector from parsed resume", 0.8)
  }
  if (axisMissing(input, "relevantIndustry")) {
    const relevantIndustry = stringArray(resume.relevantIndustry)
    if (relevantIndustry.length > 0) addProposal(out, "relevantIndustry", relevantIndustry, "resume_baseline", "relevant industry from parsed resume", 0.8)
  }
  const existingIndustry = firstAxis(input, "industryEnum")
  if (hasOnlyOther(existingIndustry)) {
    const industryEnum = stringArray(resume.industryTags).filter((token) => token !== "other")
    if (industryEnum.length > 0) addProposal(out, "industryEnum", industryEnum, "resume_baseline", "non-other industry bucket from parsed resume", 0.8)
  }

  for (const key of ["targetRoleFunction", "targetJobType"]) {
    if (Array.isArray(out.proposed[key])) {
      out.proposed[key] = (out.proposed[key] as string[]).filter((token) => {
        if (key === "targetRoleFunction") return ROLE_SET.has(token)
        return JOB_TYPE_SET.has(token)
      })
    }
  }

  return out
}
