import { randomUUID } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"
import { getFirestore } from "firebase-admin/firestore"
import { HttpsError, onCall } from "firebase-functions/v2/https"
import { defineSecret } from "firebase-functions/params"
import { logger } from "firebase-functions/v2"
import { z } from "zod"
import {
  canonicalizeLinkedInUrl,
  CoresignalCollectError,
  fetchEmployeeCollect,
  searchEmployeeIdByLinkedinUrl,
  normalizeEmail,
  type CoresignalEmployeeCollectV2,
} from "@pa/external-supply"
import {
  getOrFetchCoresignalById,
  getOrFetchCoresignalByLinkedin,
} from "./lib/coresignal-cache.js"

const CORESIGNAL_API_KEY = defineSecret("CORESIGNAL_API_KEY")
const CORESIGNAL_AGENTIC_SEARCH_URL =
  "https://api.coresignal.com/cdapi/v2/agentic_search/reasoning"
const SURFACE = "chrome_extension_recruiter_similar_candidates"

const SimilarCandidatesPayloadSchema = z.object({
  source: z.object({
    activeTabUrl: z.string().min(1),
    pageType: z.literal("linkedin_profile"),
    title: z.string().optional(),
    visibleText: z.string().max(20_000).optional(),
  }),
  profileContext: z.object({
    linkedinUrl: z.string().min(1),
    fullName: z.string().optional(),
    headline: z.string().optional(),
    location: z.string().optional(),
    currentTitle: z.string().optional(),
    currentCompany: z.string().optional(),
  }),
  limit: z.number().int().min(1).max(30).optional(),
})

export type SimilarCandidatesPayload = z.infer<typeof SimilarCandidatesPayloadSchema>

export type SimilarCandidateResultRow = {
  linkedinUrl: string
  canonicalLinkedInUrl: string
  coresignalEmployeeId: number | null
  rank: number
  fullName: string
  headline: string | null
  currentTitle: string | null
  currentCompany: string | null
  location: string | null
  education: string[]
  pastCompanies: string[]
  skills: string[]
  primaryProfessionalEmail: string | null
  professionalEmails: string[]
  similarityScore: number
  similarityReasons: string[]
  profileSummary: string
  fromCache: boolean
}

export type SimilarCandidatesResponse = {
  ok: true
  source: {
    linkedinUrl: string
    canonicalLinkedInUrl: string
    coresignalEmployeeId: number | null
    fullName: string | null
    headline: string | null
    currentTitle: string | null
    currentCompany: string | null
    location: string | null
  }
  results: SimilarCandidateResultRow[]
  meta: {
    surface: typeof SURFACE
    limit: number
  }
}

type Logger = (event: string, fields?: Record<string, unknown>) => void

export type CoresignalAgenticSearchRequest = {
  prompt: string
  returnData: true
  allowClarification: false
  limit: number
  sessionId: string
}

type RunDeps = {
  auth?: { uid?: string } | null
  data: unknown
  db: Firestore
  apiKey: string | null
  now?: string
  searchEmployeeIdByLinkedinUrl?: (
    canonicalLinkedInUrl: string,
    cfg: { apiKey: string },
  ) => Promise<number | null>
  fetchEmployeeCollect?: (
    id: number,
    cfg: { apiKey: string },
  ) => Promise<CoresignalEmployeeCollectV2>
  agenticSearch?: (request: CoresignalAgenticSearchRequest) => Promise<unknown>
  log?: Logger
}

class CoresignalAgenticSearchError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly body?: unknown,
  ) {
    super(message)
    this.name = "CoresignalAgenticSearchError"
  }
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function uniqueStrings(values: Array<string | null | undefined>, limit = 8): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const trimmed = value?.trim()
    if (!trimmed) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
    if (out.length >= limit) break
  }
  return out
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function numericId(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value)
  const record = recordOf(value)
  if (!record) return null
  return numericId(record.id ?? record.coresignalEmployeeId ?? record.coresignal_id ?? record._id)
}

function activeExperience(employee: Record<string, unknown>): Record<string, unknown> | null {
  const experience = Array.isArray(employee.experience) ? employee.experience : []
  for (const row of experience) {
    const record = recordOf(row)
    if (!record) continue
    const active = record.active_experience
    if (active === true || active === 1 || active === "1") return record
  }
  return recordOf(experience[0])
}

function employeeLinkedInUrl(employee: Record<string, unknown>): string | null {
  return (
    cleanString(employee.linkedin_url) ??
    cleanString(employee.canonical_linkedin_url) ??
    cleanString(employee.linkedinUrl) ??
    cleanString(employee.canonicalLinkedInUrl) ??
    cleanString(employee.profile_url)
  )
}

function fullName(employee: Record<string, unknown>): string | null {
  return (
    cleanString(employee.full_name) ??
    cleanString(employee.fullName) ??
    cleanString(employee.name)
  )
}

function headline(employee: Record<string, unknown>): string | null {
  return cleanString(employee.headline)
}

function currentTitle(employee: Record<string, unknown>): string | null {
  const active = activeExperience(employee)
  return (
    cleanString(employee.active_experience_title) ??
    cleanString(employee.currentTitle) ??
    cleanString(active?.position_title) ??
    cleanString(active?.title)
  )
}

function currentCompany(employee: Record<string, unknown>): string | null {
  const active = activeExperience(employee)
  return (
    cleanString(employee.active_experience_company_name) ??
    cleanString(employee.currentCompany) ??
    cleanString(active?.company_name) ??
    cleanString(active?.company)
  )
}

function location(employee: Record<string, unknown>): string | null {
  return (
    cleanString(employee.location_full) ??
    cleanString(employee.location) ??
    cleanString(employee.location_city)
  )
}

function education(employee: Record<string, unknown>): string[] {
  const rows = Array.isArray(employee.education) ? employee.education : []
  return uniqueStrings(
    rows.map((row) => {
      const record = recordOf(row)
      if (!record) return null
      const school = cleanString(record.institution_name) ?? cleanString(record.school)
      const degree = cleanString(record.degree)
      if (school && degree) return `${school}, ${degree}`
      return school ?? degree
    }),
    6,
  )
}

function companyHistory(employee: Record<string, unknown>): {
  allCompanies: string[]
  pastCompanies: string[]
} {
  const rows = Array.isArray(employee.experience) ? employee.experience : []
  const all: string[] = []
  const past: string[] = []
  for (const row of rows) {
    const record = recordOf(row)
    if (!record) continue
    const company = cleanString(record.company_name) ?? cleanString(record.company)
    if (!company) continue
    all.push(company)
    const active = record.active_experience
    if (!(active === true || active === 1 || active === "1")) past.push(company)
  }
  return {
    allCompanies: uniqueStrings(all, 10),
    pastCompanies: uniqueStrings(past, 8),
  }
}

function skills(employee: Record<string, unknown>): string[] {
  const values: string[] = []
  for (const key of ["inferred_skills", "historical_skills", "skills"]) {
    const raw = employee[key]
    if (Array.isArray(raw)) {
      for (const item of raw) {
        const value = cleanString(item)
        if (value) values.push(value)
      }
    }
  }
  return uniqueStrings(values, 12)
}

function professionalEmails(employee: Record<string, unknown>): {
  primary: string | null
  emails: string[]
} {
  const candidates: string[] = []
  const primary = normalizeEmail(cleanString(employee.primary_professional_email))
  if (primary) candidates.push(primary)
  const rows = Array.isArray(employee.professional_emails_collection)
    ? employee.professional_emails_collection
    : []
  for (const row of rows) {
    const record = recordOf(row)
    const email = normalizeEmail(cleanString(record?.professional_email))
    if (email) candidates.push(email)
  }
  const emails = uniqueStrings(candidates, 5)
  return { primary: primary ?? emails[0] ?? null, emails }
}

function tokenSet(value: string | null): Set<string> {
  if (!value) return new Set()
  const stop = new Set(["and", "the", "at", "of", "to", "for", "in", "on", "lead"])
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9+#]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !stop.has(token)),
  )
}

function intersections(a: string[], b: string[], limit = 3): string[] {
  const bSet = new Set(b.map((value) => value.toLowerCase()))
  return uniqueStrings(a.filter((value) => bSet.has(value.toLowerCase())), limit)
}

const GENERIC_SKILL_TERMS = new Set([
  "algorithm",
  "algorithms",
  "api",
  "apis",
  "banking service",
  "c++",
  "cloud",
  "cloud computing",
  "communication",
  "communication skills",
  "computer science",
  "core java",
  "collaboration",
  "coordination",
  "css",
  "design",
  "developer",
  "development",
  "engineer",
  "engineering",
  "feature",
  "hosting",
  "html",
  "java",
  "java, python",
  "jquery",
  "junit",
  "interpersonal",
  "leading",
  "leadership",
  "management",
  "mentoring",
  "python",
  "senior software engineer",
  "sde",
  "software",
  "software engineering",
  "teams",
  "testing",
  "technology",
  "writing",
])

function meaningfulSkills(employee: Record<string, unknown>): string[] {
  return skills(employee).filter((skill) => {
    const normalized = skill.trim().toLowerCase()
    return normalized.length > 2 && !GENERIC_SKILL_TERMS.has(normalized)
  })
}

function titleOverlap(a: string | null, b: string | null): string[] {
  const bTokens = tokenSet(b)
  return [...tokenSet(a)].filter((token) => bTokens.has(token)).slice(0, 4)
}

function schoolNames(values: string[]): string[] {
  return values.map((value) => value.split(",")[0]?.trim()).filter(Boolean) as string[]
}

function sameTitleFamily(a: string | null, b: string | null): boolean {
  if (!a || !b) return false
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replace(/\b(i{1,3}|iv|v|staff|senior|sr|lead|principal|associate)\b/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
  const left = normalize(a)
  const right = normalize(b)
  return Boolean(left && right && (left === right || left.includes(right) || right.includes(left)))
}

const MAJOR_TECH_OR_PRODUCT_COMPANIES = new Set([
  "adobe",
  "airbnb",
  "amazon",
  "apple",
  "databricks",
  "google",
  "meta",
  "microsoft",
  "netflix",
  "openai",
  "plaid",
  "salesforce",
  "stripe",
  "tesla",
  "uber",
])

function normalizedCompanyName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|corporation|company|co)\b\.?/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

function majorTechCompany(companies: string[]): string | null {
  for (const company of companies) {
    const normalized = normalizedCompanyName(company)
    if (MAJOR_TECH_OR_PRODUCT_COMPANIES.has(normalized)) return company
  }
  return null
}

function locationTokens(value: string | null): Set<string> {
  if (!value) return new Set()
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((token) => token.length >= 4 && token !== "united" && token !== "states"),
  )
}

function locationOverlap(a: string | null, b: string | null): string | null {
  if (!a || !b) return null
  if (a.toLowerCase() === b.toLowerCase()) return a
  const bTokens = locationTokens(b)
  const shared = [...locationTokens(a)].find((token) => bTokens.has(token))
  return shared ? shared[0]!.toUpperCase() + shared.slice(1) : null
}

function collectEvidenceStrings(value: unknown, out: string[], depth = 0): void {
  if (out.length >= 220 || depth > 4 || value == null) return
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (trimmed) out.push(trimmed)
    return
  }
  if (typeof value === "number" || typeof value === "boolean") return
  if (Array.isArray(value)) {
    for (const item of value) collectEvidenceStrings(item, out, depth + 1)
    return
  }
  const record = recordOf(value)
  if (!record) return
  for (const [key, child] of Object.entries(record)) {
    if (/email|phone|url|avatar|image|logo/i.test(key)) continue
    collectEvidenceStrings(child, out, depth + 1)
  }
}

function profileEvidenceText(employee: Record<string, unknown>): string {
  const values: string[] = []
  collectEvidenceStrings(employee, values)
  return uniqueStrings(values, 160).join(" ").toLowerCase()
}

const TRAJECTORY_SIGNAL_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "elite award or ranking", pattern: /\b(top\s*0?\.\d+%|national award|awardee|olympiad|icpc|hackathon|ranked)\b/i },
  { label: "founder or acquired-company background", pattern: /\b(co-?founder|founder|founded|acquired|startup|entrepreneur|bootstrapp(?:ed|ing)?)\b/i },
  { label: "fast-growth career signal", pattern: /\b(high[- ]growth|fast[- ]growing|rapid growth|accelerated career|early career acceleration|rapid promot(?:ed|ion)|promoted .*?(senior|staff|lead|principal))\b/i },
]

const BUILDER_SIGNAL_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "built or launched product work", pattern: /\b(built|build|launched|shipped|owned|created|designed)\b.{0,80}\b(product|platform|system|application|app|service|tool|feature|workflow|marketplace|dashboard|saas)\b|\b(saas development|web development|database development)\b/i },
  { label: "startup or founder product work", pattern: /\b(co-?founder|founder|startup|acquired|bootstrapp(?:ed|ing)?)\b/i },
  { label: "developer tool or platform work", pattern: /\b(developer productivity|devtools?|framework|sdk|library|open source|platform)\b/i },
]

const DOMAIN_SIGNAL_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "applied AI/LLM", pattern: /\b(ai|llm|large language models?|genai|nlp|generative|machine learning|deep learning|artificial intelligence)\b/i },
  { label: "distributed/backend systems", pattern: /\b(distributed|backend|message queue|transaction|kubernetes|infrastructure|microservice|systems design)\b/i },
  { label: "developer productivity/devtools", pattern: /\b(developer productivity|devtools?|framework|sdk|library|open source)\b/i },
  { label: "web/platform product engineering", pattern: /\b(web platform|platform engineer|platform engineering|full-stack|frontend|mobile)\b/i },
  { label: "data/recommendation/search products", pattern: /\b(recommendation|ranking|search|ads|ad-serving|data model|analytics)\b/i },
]

function matchingSignalLabels(text: string, patterns: Array<{ label: string; pattern: RegExp }>, limit = 4): string[] {
  return uniqueStrings(
    patterns.map(({ label, pattern }) => (pattern.test(text) ? label : null)),
    limit,
  )
}

function roleEvidenceText(employee: Record<string, unknown>): string {
  return [
    currentTitle(employee),
    headline(employee),
    activeExperience(employee)?.position_title,
    activeExperience(employee)?.title,
  ]
    .map((value) => cleanString(value))
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
}

function isHandsOnSoftwareText(text: string): boolean {
  return /\b(swe|software engineer|software engineering|staff engineer|principal engineer|backend engineer|frontend engineer|full[- ]stack engineer|platform engineer|ml engineer|ai engineer|research engineer|ai researcher|machine learning engineer|developer|architect|technical lead|tech lead)\b/i.test(
    text,
  )
}

function isHandsOnSoftwareProfile(employee: Record<string, unknown>): boolean {
  return isHandsOnSoftwareText(roleEvidenceText(employee))
}

function isNonComparableOperatorRole(employee: Record<string, unknown>): boolean {
  const text = roleEvidenceText(employee)
  if (!text) return false
  const hasHandsOnSoftware = isHandsOnSoftwareProfile(employee)
  return (
    /\b(engineering manager|manager|mentor|consultant|evangelist|advocate|developer relations|devrel|community|content creator|coach|advisor|director|vp|head of|product manager|program manager)\b/i.test(
      text,
    ) && !hasHandsOnSoftware
  )
}

function hasCareerCoachingSignal(employee: Record<string, unknown>): boolean {
  const text = [headline(employee), currentTitle(employee), profileEvidenceText(employee)]
    .map((value) => cleanString(value))
    .filter(Boolean)
    .join(" ")
  return /\b(interview coach|career coach|compensation coach|helping software engineers|crack top tech|crack faang|2x (their )?compensation|salary negotiation|linkedin top voice)\b/i.test(
    text,
  )
}

function isRoleCompatibleWithSource(
  source: Record<string, unknown>,
  candidate: Record<string, unknown>,
): boolean {
  if (!isHandsOnSoftwareProfile(source)) return true
  const candidateCurrentTitle = cleanString(currentTitle(candidate))
  if (candidateCurrentTitle) {
    const normalizedCurrentTitle = candidateCurrentTitle.toLowerCase()
    if (/\b(advocate|developer relations|devrel|community|content creator|evangelist)\b/i.test(normalizedCurrentTitle)) {
      return false
    }
    if (isNonComparableOperatorRole({ active_experience_title: normalizedCurrentTitle })) return false
    if (!isHandsOnSoftwareText(normalizedCurrentTitle)) return false
  }
  if (isNonComparableOperatorRole(candidate)) return false
  return isHandsOnSoftwareProfile(candidate)
}

function hasStrongNonGenericOverlap(
  source: Record<string, unknown>,
  candidate: Record<string, unknown>,
): boolean {
  const sourceText = profileEvidenceText(source)
  const candidateText = profileEvidenceText(candidate)
  const matchingDomains = intersections(
    matchingSignalLabels(sourceText, DOMAIN_SIGNAL_PATTERNS, 8),
    matchingSignalLabels(candidateText, DOMAIN_SIGNAL_PATTERNS, 8),
    3,
  )
  if (matchingDomains.length > 0) return true
  if (intersections(companyHistory(source).allCompanies, companyHistory(candidate).allCompanies, 1).length > 0) {
    return true
  }
  if (intersections(schoolNames(education(source)), schoolNames(education(candidate)), 1).length > 0) {
    return true
  }
  if (intersections(meaningfulSkills(source), meaningfulSkills(candidate), 1).length > 0) {
    return true
  }
  const sourceBuilder = matchingSignalLabels(sourceText, BUILDER_SIGNAL_PATTERNS)
  const candidateBuilder = matchingSignalLabels(candidateText, BUILDER_SIGNAL_PATTERNS)
  const candidateTrajectory = matchingSignalLabels(candidateText, TRAJECTORY_SIGNAL_PATTERNS)
  return (
    sourceBuilder.length > 0 &&
    candidateBuilder.length > 0 &&
    candidateTrajectory.some((label) => label !== "fast-growth career signal")
  )
}

function deriveSimilarityReasons(
  source: Record<string, unknown>,
  candidate: Record<string, unknown>,
): string[] {
  const reasons: string[] = []
  const sourceText = profileEvidenceText(source)
  const candidateText = profileEvidenceText(candidate)
  const sourceTrajectory = matchingSignalLabels(sourceText, TRAJECTORY_SIGNAL_PATTERNS)
  const candidateTrajectory = matchingSignalLabels(candidateText, TRAJECTORY_SIGNAL_PATTERNS)
  if (sourceTrajectory.length > 0 && candidateTrajectory.length > 0) {
    reasons.push(
      `Trajectory overlap: source has ${sourceTrajectory.slice(0, 2).join(", ")}; candidate has ${candidateTrajectory
        .slice(0, 2)
        .join(", ")}.`,
    )
  }

  const sourceBuilder = matchingSignalLabels(sourceText, BUILDER_SIGNAL_PATTERNS)
  const candidateBuilder = matchingSignalLabels(candidateText, BUILDER_SIGNAL_PATTERNS)
  if (sourceBuilder.length > 0 && candidateBuilder.length > 0) {
    reasons.push(
      `Builder/product overlap: source shows ${sourceBuilder.slice(0, 2).join(", ")}; candidate shows ${candidateBuilder
        .slice(0, 2)
        .join(", ")}.`,
    )
  }

  const matchingDomains = intersections(
    matchingSignalLabels(sourceText, DOMAIN_SIGNAL_PATTERNS, 8),
    matchingSignalLabels(candidateText, DOMAIN_SIGNAL_PATTERNS, 8),
    3,
  )
  if (matchingDomains.length > 0) {
    reasons.push(`Product/domain overlap: both profiles show ${matchingDomains.join(", ")} evidence.`)
  }

  const sourceTitle = currentTitle(source) ?? headline(source)
  const candidateTitle = currentTitle(candidate) ?? headline(candidate)
  if (sameTitleFamily(sourceTitle, candidateTitle) && sourceTitle && candidateTitle) {
    reasons.push(`Role/function overlap: source role is ${sourceTitle}; candidate role is ${candidateTitle}.`)
  } else {
    const matchingTitleTerms = titleOverlap(sourceTitle, candidateTitle)
      .filter((token) => !["software", "engineer", "engineering", "senior"].includes(token))
    if (matchingTitleTerms.length > 0) {
      reasons.push(`Role/function overlap: both profiles include ${matchingTitleTerms.join(", ")} signals.`)
    }
  }

  const sourceCompanies = companyHistory(source).allCompanies
  const candidateCompanies = companyHistory(candidate).allCompanies
  const matchingCompanies = intersections(sourceCompanies, candidateCompanies, 3)
  if (matchingCompanies.length > 0) {
    reasons.push(`Company overlap: ${matchingCompanies.join(", ")} appears in both career histories.`)
  }
  const sourceMajorCompany = majorTechCompany(sourceCompanies)
  const candidateMajorCompany = majorTechCompany(candidateCompanies)
  if (
    matchingCompanies.length === 0 &&
    sourceMajorCompany &&
    candidateMajorCompany &&
    sourceTitle &&
    candidateTitle &&
    titleOverlap(sourceTitle, candidateTitle).length > 0
  ) {
    reasons.push(
      `Career pattern overlap: both show software engineering roles at major product/technology companies (${sourceMajorCompany}, ${candidateMajorCompany}).`,
    )
  }

  const sourceSchools = schoolNames(education(source))
  const candidateSchools = schoolNames(education(candidate))
  const matchingSchools = intersections(sourceSchools, candidateSchools, 2)
  if (matchingSchools.length > 0) {
    reasons.push(`Education overlap: both profiles include ${matchingSchools.join(", ")}.`)
  }

  const matchingSkills = intersections(meaningfulSkills(source), meaningfulSkills(candidate), 4)
  if (matchingSkills.length > 0) {
    reasons.push(`Skill overlap: ${matchingSkills.join(", ")}.`)
  }

  const sourceLocation = location(source)
  const candidateLocation = location(candidate)
  const sharedLocation = locationOverlap(sourceLocation, candidateLocation)
  if (sharedLocation) {
    reasons.push(`Location overlap: both profiles include ${sharedLocation}.`)
  }

  const sourceActive = activeExperience(source)
  const candidateActive = activeExperience(candidate)
  const sourceLevel = cleanString(source.active_experience_management_level) ?? cleanString(sourceActive?.management_level)
  const candidateLevel =
    cleanString(candidate.active_experience_management_level) ?? cleanString(candidateActive?.management_level)
  if (sourceLevel && candidateLevel && sourceLevel.toLowerCase() === candidateLevel.toLowerCase()) {
    reasons.push(`Seniority overlap: both profiles show ${sourceLevel} seniority signals.`)
  }

  if (reasons.length === 0) {
    const explicit = cleanString(candidate.similarityReason) ?? cleanString(candidate.reasoning)
    if (explicit) reasons.push(explicit)
  }
  return reasons
    .sort((a, b) => reasonPriority(a) - reasonPriority(b))
    .slice(0, 6)
}

function reasonPriority(reason: string): number {
  if (/^(Company|Education|Skill) overlap:/i.test(reason)) return 0
  if (/^Trajectory overlap:/i.test(reason)) return 1
  if (/^Builder\/product overlap:/i.test(reason)) return 2
  if (/^Product\/domain overlap:/i.test(reason)) return 3
  if (/^Role\/function overlap:/i.test(reason)) return 4
  if (/^Location overlap:/i.test(reason)) return 5
  if (/^Seniority overlap:/i.test(reason)) return 6
  if (/^Career pattern overlap:/i.test(reason)) return 7
  return 8
}

function similarityEvidenceQuality(reasons: string[]): {
  passes: boolean
  evidenceScore: number
} {
  let trajectorySignals = 0
  let builderSignals = 0
  let domainSignals = 0
  let exactStrongSignals = 0
  let genericSignals = 0
  let candidateFastGrowthSignal = false

  for (const reason of reasons) {
    if (/^Trajectory overlap:/i.test(reason)) {
      trajectorySignals += 1
      if (/candidate has .*?(elite award or ranking|fast-growth career signal)/i.test(reason)) {
        candidateFastGrowthSignal = true
      }
    } else if (/^Builder\/product overlap:/i.test(reason)) {
      builderSignals += 1
    } else if (/^Product\/domain overlap:/i.test(reason)) {
      domainSignals += 1
    } else if (/^(Company|Education|Skill) overlap:/i.test(reason)) {
      exactStrongSignals += 1
    } else if (/^(Role\/function|Career pattern|Location|Seniority) overlap:/i.test(reason)) {
      genericSignals += 1
    }
  }

  const hasConcreteWorkOverlap = domainSignals > 0 || builderSignals > 0
  const passes =
    exactStrongSignals >= 2 ||
    (exactStrongSignals >= 1 && (hasConcreteWorkOverlap || trajectorySignals > 0)) ||
    (candidateFastGrowthSignal && hasConcreteWorkOverlap)
  const evidenceScore = Math.min(
    0.97,
    0.42 +
      trajectorySignals * 0.18 +
      domainSignals * 0.16 +
      builderSignals * 0.1 +
      exactStrongSignals * 0.13 +
      genericSignals * 0.035,
  )
  return { passes, evidenceScore: Math.round(evidenceScore * 100) / 100 }
}

function hasDisplayableSimilarityEvidence(reasons: string[]): boolean {
  const hasExact = reasons.some((reason) => /^(Company|Education|Skill) overlap:/i.test(reason))
  const hasTrajectory = reasons.some((reason) => /^Trajectory overlap:/i.test(reason))
  const hasDomain = reasons.some((reason) => /^Product\/domain overlap:/i.test(reason))
  return hasExact || hasTrajectory || hasDomain
}

function numericScore(
  candidate: Record<string, unknown>,
  reasons: string[],
  ordinal: number,
  evidenceScore: number,
): number {
  const explicit = candidate.similarityScore ?? candidate.similarity_score ?? candidate.score ?? candidate._score
  if (typeof explicit === "number" && Number.isFinite(explicit)) {
    const normalizedExplicit =
      explicit > 1 ? Math.max(0, Math.min(1, explicit / 100)) : Math.max(0, Math.min(1, explicit))
    return Math.min(normalizedExplicit, Math.min(0.98, evidenceScore + 0.04))
  }
  const reasonScore = Math.min(0.9, reasons.length * 0.08)
  const rankScore = Math.max(0, 0.25 - ordinal * 0.01)
  return Math.min(0.98, Math.round(Math.max(evidenceScore, 0.34 + reasonScore + rankScore) * 100) / 100)
}

function profileSummary(employee: Record<string, unknown>): string {
  const title = currentTitle(employee)
  const company = currentCompany(employee)
  const loc = location(employee)
  const parts = [
    title && company ? `${title} at ${company}` : title ?? company,
    loc,
    skills(employee).slice(0, 3).join(", "),
  ].filter(Boolean)
  return parts.join(" · ")
}

function extractAgenticRows(response: unknown): unknown[] {
  if (Array.isArray(response)) return response
  const root = recordOf(response)
  if (!root) return []
  for (const key of ["data", "results", "rows", "employees", "candidates"]) {
    const value = root[key]
    if (Array.isArray(value)) return value
  }
  const nested = recordOf(root.response)
  if (nested) {
    for (const key of ["data", "results", "rows", "employees", "candidates"]) {
      const value = nested[key]
      if (Array.isArray(value)) return value
    }
  }
  return []
}

export function normalizeSimilarCandidateRows(
  rows: unknown[],
  opts: {
    source: CoresignalEmployeeCollectV2
    sourceCanonicalLinkedInUrl: string
    sourceVisibleText?: string | null
    limit: number
  },
): SimilarCandidateResultRow[] {
  const sourceRecord = {
    ...(opts.source as unknown as Record<string, unknown>),
    __visibleProfileText: opts.sourceVisibleText ?? undefined,
  }
  const sourceId = numericId(opts.source)
  const normalized: SimilarCandidateResultRow[] = []
  const seen = new Set<string>()

  rows.forEach((row, ordinal) => {
    const record = typeof row === "number" ? { id: row } : recordOf(row)
    if (!record) return
    const id = numericId(record)
    if (sourceId && id === sourceId) return
    const rawLinkedIn = employeeLinkedInUrl(record)
    const canonicalLinkedInUrl = canonicalizeLinkedInUrl(rawLinkedIn)
    if (!canonicalLinkedInUrl || canonicalLinkedInUrl === opts.sourceCanonicalLinkedInUrl) return
    if (seen.has(canonicalLinkedInUrl)) return
    const name = fullName(record)
    if (!name) return
    if (!isRoleCompatibleWithSource(sourceRecord, record)) return
    if (hasCareerCoachingSignal(record) && !hasStrongNonGenericOverlap(sourceRecord, record)) return
    const reasons = deriveSimilarityReasons(sourceRecord, record)
    if (reasons.length === 0) return
    const quality = similarityEvidenceQuality(reasons)
    if (!quality.passes && !hasDisplayableSimilarityEvidence(reasons)) return
    const emails = professionalEmails(record)
    const history = companyHistory(record)
    seen.add(canonicalLinkedInUrl)
    normalized.push({
      linkedinUrl: rawLinkedIn ?? canonicalLinkedInUrl,
      canonicalLinkedInUrl,
      coresignalEmployeeId: id,
      rank: normalized.length + 1,
      fullName: name,
      headline: headline(record),
      currentTitle: currentTitle(record),
      currentCompany: currentCompany(record),
      location: location(record),
      education: education(record),
      pastCompanies: history.pastCompanies,
      skills: skills(record),
      primaryProfessionalEmail: emails.primary,
      professionalEmails: emails.emails,
      similarityScore: numericScore(record, reasons, ordinal, quality.evidenceScore),
      similarityReasons: reasons,
      profileSummary: profileSummary(record),
      fromCache: record.fromCache === true || record.__fromCache === true,
    })
  })

  return normalized
    .sort((a, b) => b.similarityScore - a.similarityScore)
    .slice(0, opts.limit)
    .map((row, index) => ({ ...row, rank: index + 1 }))
}

export function buildSimilarCandidatesPrompt(args: {
  source: CoresignalEmployeeCollectV2
  profileContext: SimilarCandidatesPayload["profileContext"]
  visibleText?: string | null
  limit: number
}): string {
  const target = similarCandidatesPromptTarget(args)
  return [
    "Find genuinely similar candidate LinkedIn profiles for recruiters.",
    `Return up to ${args.limit} employees with return_data=true.`,
    "Similarity means concrete overlap in the person's career story, not only the same generic job title.",
    "Prioritize candidates with at least two strong evidence categories: fast-growth or elite trajectory, builder/founder/creator/product ownership, similar product/domain work, exact current/past company overlap, exact school/education overlap, or specific non-generic skill overlap.",
    "For fast-growing hands-on software profiles, prefer people with comparable acceleration, elite awards/rankings, founder/acquired-company work, creator signals, applied AI/product-builder evidence, or similar systems/product engineering work.",
    "Keep the role comparable to the target. For a senior software engineer target, do not return managers, mentors, consultants, technical evangelists, product managers, or advisors unless their current role is still hands-on software, AI, platform, backend, frontend, research, or architecture engineering.",
    "Reject candidates whose only overlap is software engineer title, seniority, location, or employment at a different major technology company.",
    "Do not infer similarity from Tesla, automotive, or EV wording by itself; only use that evidence when the candidate has concrete Tesla/autonomous/vehicle software work.",
    "Do not over-optimize for a single company or school. Exclude the target profile itself.",
    "Prefer candidates with valid LinkedIn profile URLs and professional work history evidence.",
    "For every returned candidate, include concrete reasoning tied to overlapping trajectory, product/domain work, builder evidence, companies, education, skills, role/function, seniority, location, or career pattern.",
    `Target CoreSignal employee record summary:\n${JSON.stringify(target, null, 2)}`,
  ].join("\n\n")
}

function similarCandidatesPromptTarget(args: {
  source: CoresignalEmployeeCollectV2
  profileContext: SimilarCandidatesPayload["profileContext"]
  visibleText?: string | null
}): Record<string, unknown> {
  const source = args.source as unknown as Record<string, unknown>
  const history = companyHistory(source)
  const sourceEvidenceText = [profileEvidenceText(source), args.visibleText ?? ""].join(" ")
  return {
    fullName: fullName(source) ?? args.profileContext.fullName ?? null,
    linkedinUrl: employeeLinkedInUrl(source) ?? args.profileContext.linkedinUrl,
    headline: headline(source) ?? args.profileContext.headline ?? null,
    currentTitle: currentTitle(source) ?? args.profileContext.currentTitle ?? null,
    currentCompany: currentCompany(source) ?? args.profileContext.currentCompany ?? null,
    location: location(source) ?? args.profileContext.location ?? null,
    pastCompanies: history.pastCompanies,
    education: education(source),
    skills: skills(source).slice(0, 12),
    trajectorySignals: matchingSignalLabels(sourceEvidenceText, TRAJECTORY_SIGNAL_PATTERNS),
    builderSignals: matchingSignalLabels(sourceEvidenceText, BUILDER_SIGNAL_PATTERNS),
    productDomainSignals: matchingSignalLabels(sourceEvidenceText, DOMAIN_SIGNAL_PATTERNS, 8),
  }
}

function buildSimilarCandidatesFastPrompt(args: {
  source: CoresignalEmployeeCollectV2
  profileContext: SimilarCandidatesPayload["profileContext"]
  visibleText?: string | null
  limit: number
}): string {
  const target = similarCandidatesPromptTarget(args)
  const retryLimit = Math.min(args.limit, 5)
  return [
    "Fast retry: find only the highest-confidence similar candidate LinkedIn profiles.",
    `Return at most ${retryLimit} employees with valid LinkedIn profile URLs and return_data=true.`,
    "Hard filter: every returned person must be hands-on software, AI, platform, backend, frontend, research, architecture, or technical product engineering.",
    "Hard filter: every returned person must have at least two concrete overlaps with the target: exact company, exact school, non-generic technical skill, applied AI/devtools/backend/platform/product work, founder/acquired/startup builder evidence, elite trajectory, or closely similar product-building career pattern.",
    "Reject coaches, consultants, PMs, advisors, evangelists, creator-only profiles, and generic senior software engineers whose only evidence is title, seniority, location, or a different major-tech employer.",
    "For fast-growth/product-builder targets, prefer comparable fast-growth engineers, product builders, founders, acquired-startup alumni, or people who worked on similar SaaS, AI, devtool, backend, platform, or data products.",
    "Exclude the target profile itself.",
    `Target CoreSignal employee record summary:\n${JSON.stringify(target, null, 2)}`,
  ].join("\n\n")
}

async function callCoresignalAgenticSearch(args: {
  apiKey: string
  request: CoresignalAgenticSearchRequest
}): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(CORESIGNAL_AGENTIC_SEARCH_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        apikey: args.apiKey,
      },
      body: JSON.stringify({
        prompt: args.request.prompt,
        return_data: true,
        allow_clarification: false,
        session_id: args.request.sessionId,
        limit: args.request.limit,
      }),
    })
  } catch (err) {
    throw new CoresignalAgenticSearchError(
      err instanceof Error ? err.message : "network_error",
      null,
    )
  }
  const text = await res.text()
  let body: unknown
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { raw: text.slice(0, 500) }
  }
  if (!res.ok) {
    throw new CoresignalAgenticSearchError(`coresignal_${res.status}`, res.status, body)
  }
  return body
}

function coresignalStatus(err: unknown): number | null {
  if (err instanceof CoresignalCollectError) return err.status
  if (err instanceof CoresignalAgenticSearchError) return err.status
  const status = recordOf(err)?.status
  return typeof status === "number" ? status : null
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function errorBodySnippet(err: unknown): string | null {
  const body = err instanceof CoresignalAgenticSearchError ? err.body : recordOf(err)?.body
  if (body == null) return null
  try {
    return JSON.stringify(body).slice(0, 700)
  } catch {
    return String(body).slice(0, 700)
  }
}

function isCoresignalAgenticTimeout(err: unknown): boolean {
  const status = coresignalStatus(err)
  if (status !== 503 && status !== 504 && status !== 408) return false
  const text = [errorMessage(err), errorBodySnippet(err)].filter(Boolean).join(" ")
  return /\b(timed out|timeout)\b/i.test(text)
}

function throwCoresignalHttpsError(err: unknown): never {
  const status = coresignalStatus(err)
  if (status === 429) {
    throw new HttpsError("resource-exhausted", "coresignal_fast_429", { retryable: true })
  }
  if (status && (status >= 500 || status === 408 || status === 409 || status === 425)) {
    throw new HttpsError("unavailable", `coresignal_fast_${status}`, { retryable: true })
  }
  if (status === 401 || status === 403) {
    throw new HttpsError("permission-denied", `coresignal_${status}`)
  }
  if (status === 400 || status === 422) {
    throw new HttpsError("invalid-argument", `coresignal_${status}`)
  }
  logger.error("pa_extension_similar_candidates.coresignal_failed", {
    error: err instanceof Error ? err.message : String(err),
  })
  throw new HttpsError("internal", "coresignal_failed")
}

async function enrichRowsByCoresignalId(args: {
  rows: unknown[]
  db: Firestore
  apiKey: string
  now: string
  sourceEmployee: CoresignalEmployeeCollectV2
  fetchEmployee: (id: number, cfg: { apiKey: string }) => Promise<CoresignalEmployeeCollectV2>
  log?: Logger
}): Promise<unknown[]> {
  const sourceId = numericId(args.sourceEmployee)
  const enriched: unknown[] = []
  for (const row of args.rows) {
    const id = numericId(row)
    if (!id || (sourceId && id === sourceId)) {
      enriched.push(row)
      continue
    }
    const record = typeof row === "number" ? { id } : recordOf(row)
    const canonical = canonicalizeLinkedInUrl(record ? employeeLinkedInUrl(record) : null)
    try {
      const collected = await getOrFetchCoresignalById({
        db: args.db,
        id,
        apiKey: args.apiKey,
        now: args.now,
        source: SURFACE,
        fetch: args.fetchEmployee,
        link: canonical ?? undefined,
        rethrow: false,
        log: args.log,
      })
      enriched.push(collected ?? row)
    } catch {
      enriched.push(row)
    }
  }
  return enriched
}

export async function runExtensionFindSimilarCandidates(
  args: RunDeps,
): Promise<SimilarCandidatesResponse> {
  const uid = args.auth?.uid
  if (!uid) {
    throw new HttpsError("unauthenticated", "sign_in_required")
  }
  const parsed = SimilarCandidatesPayloadSchema.safeParse(args.data)
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", parsed.error.message)
  }
  const input = parsed.data
  const sourceCanonical = canonicalizeLinkedInUrl(input.source.activeTabUrl)
  const profileCanonical = canonicalizeLinkedInUrl(input.profileContext.linkedinUrl)
  if (!sourceCanonical || !profileCanonical) {
    throw new HttpsError("invalid-argument", "linkedin_profile_url_required")
  }
  if (sourceCanonical !== profileCanonical) {
    throw new HttpsError("invalid-argument", "active_tab_profile_mismatch")
  }
  const apiKey = args.apiKey
  if (!apiKey) {
    throw new HttpsError("failed-precondition", "CORESIGNAL_API_KEY missing")
  }

  const now = args.now ?? new Date().toISOString()
  const limit = input.limit ?? 20
  const searchByLinkedin = args.searchEmployeeIdByLinkedinUrl ?? searchEmployeeIdByLinkedinUrl
  const fetchEmployee = args.fetchEmployeeCollect ?? fetchEmployeeCollect
  const sourceEmployee = await getOrFetchCoresignalByLinkedin({
    db: args.db,
    link: profileCanonical,
    apiKey,
    now,
    source: SURFACE,
    search: searchByLinkedin,
    fetch: fetchEmployee,
    log: args.log,
  })
  if (!sourceEmployee) {
    throw new HttpsError("not-found", "source_profile_not_found")
  }

  const prompt = buildSimilarCandidatesPrompt({
    source: sourceEmployee,
    profileContext: input.profileContext,
    visibleText: input.source.visibleText ?? null,
    limit,
  })
  const agenticSearch =
    args.agenticSearch ??
    ((request: CoresignalAgenticSearchRequest) =>
      callCoresignalAgenticSearch({ apiKey, request }))

  let agenticResponse: unknown
  let effectiveLimit = limit
  try {
    args.log?.("similar_candidates_agentic_search_started", {
      sourceLinkedInUrl: profileCanonical,
      sourceEmployeeId: numericId(sourceEmployee),
      limit,
    })
    agenticResponse = await agenticSearch({
      prompt,
      returnData: true,
      allowClarification: false,
      limit,
      sessionId: randomUUID(),
    })
  } catch (err) {
    args.log?.("similar_candidates_agentic_search_failed", {
      sourceLinkedInUrl: profileCanonical,
      sourceEmployeeId: numericId(sourceEmployee),
      status: coresignalStatus(err),
      error: errorMessage(err),
      body: errorBodySnippet(err),
    })
    if (!isCoresignalAgenticTimeout(err)) {
      throwCoresignalHttpsError(err)
    }
    effectiveLimit = Math.min(limit, 5)
    const retryPrompt = buildSimilarCandidatesFastPrompt({
      source: sourceEmployee,
      profileContext: input.profileContext,
      visibleText: input.source.visibleText ?? null,
      limit: effectiveLimit,
    })
    try {
      args.log?.("similar_candidates_agentic_search_retry_started", {
        sourceLinkedInUrl: profileCanonical,
        sourceEmployeeId: numericId(sourceEmployee),
        limit: effectiveLimit,
        originalLimit: limit,
      })
      agenticResponse = await agenticSearch({
        prompt: retryPrompt,
        returnData: true,
        allowClarification: false,
        limit: effectiveLimit,
        sessionId: randomUUID(),
      })
    } catch (retryErr) {
      args.log?.("similar_candidates_agentic_search_retry_failed", {
        sourceLinkedInUrl: profileCanonical,
        sourceEmployeeId: numericId(sourceEmployee),
        status: coresignalStatus(retryErr),
        error: errorMessage(retryErr),
        body: errorBodySnippet(retryErr),
        limit: effectiveLimit,
        originalLimit: limit,
      })
      throwCoresignalHttpsError(retryErr)
    }
  }

  const rows = extractAgenticRows(agenticResponse)
  args.log?.("similar_candidates_agentic_search_completed", {
    sourceLinkedInUrl: profileCanonical,
    sourceEmployeeId: numericId(sourceEmployee),
    rawRows: rows.length,
    limit: effectiveLimit,
    originalLimit: limit,
  })
  const enrichedRows = await enrichRowsByCoresignalId({
    rows,
    db: args.db,
    apiKey,
    now,
    sourceEmployee,
    fetchEmployee,
    log: args.log,
  })
  const results = normalizeSimilarCandidateRows(enrichedRows, {
    source: sourceEmployee,
    sourceCanonicalLinkedInUrl: profileCanonical,
    sourceVisibleText: input.source.visibleText ?? null,
    limit: effectiveLimit,
  })
  args.log?.("similar_candidates_normalized", {
    sourceLinkedInUrl: profileCanonical,
    sourceEmployeeId: numericId(sourceEmployee),
    rawRows: rows.length,
    enrichedRows: enrichedRows.length,
    resultCount: results.length,
    limit: effectiveLimit,
    originalLimit: limit,
  })
  const sourceRecord = sourceEmployee as unknown as Record<string, unknown>
  return {
    ok: true,
    source: {
      linkedinUrl: employeeLinkedInUrl(sourceRecord) ?? profileCanonical,
      canonicalLinkedInUrl: profileCanonical,
      coresignalEmployeeId: numericId(sourceEmployee),
      fullName: fullName(sourceRecord),
      headline: headline(sourceRecord),
      currentTitle: currentTitle(sourceRecord),
      currentCompany: currentCompany(sourceRecord),
      location: location(sourceRecord),
    },
    results,
    meta: {
      surface: SURFACE,
      limit: effectiveLimit,
    },
  }
}

export const paExtensionFindSimilarCandidates = onCall(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 180,
    secrets: [CORESIGNAL_API_KEY],
  },
  async (req): Promise<SimilarCandidatesResponse> =>
    runExtensionFindSimilarCandidates({
      auth: req.auth ? { uid: req.auth.uid } : null,
      data: req.data,
      db: getFirestore(),
      apiKey: CORESIGNAL_API_KEY.value(),
      log: (event, fields) => logger.info(event, fields),
    }),
)
