import type { PartialUserTags } from "./tags/user-tags-writer.js"
import { mapAnswerToLocations } from "./tags/onboarding-mappers.js"
import {
  WEKRUIT_CANDIDATE_SOURCE,
  WEKRUIT_LAYOFF_SOURCE,
  type WekruitSignupSource,
} from "./onboarding.js"

export const SHARED_ONBOARDING_EVENT_SOURCE = "shared_onboarding"
export const SHARED_ONBOARDING_EVENT_KIND = "onboarding_started"
export const SHARED_ONBOARDING_WORK_SESSION_KIND = "shared_onboarding"
export const SHARED_ONBOARDING_BOUNDARY = "website_sms_onboarding"

export type SharedOnboardingQuestionId =
  | "main_goal"
  | "culture_stage"
  | "industry_interest"
  | "location_relocation"
  | "special_context"

export type SharedOnboardingQuestion = {
  id: SharedOnboardingQuestionId
  label: string
  prompt: string
}

export type SharedOnboardingPromptContext = {
  firstName?: string
  recentCompanies?: string[]
  recentTitles?: string[]
  recentLocations?: string[]
  currentLocation?: string
  skills?: string[]
  industryTags?: string[]
}

export const SHARED_ONBOARDING_QUESTIONS: readonly SharedOnboardingQuestion[] = [
  {
    id: "main_goal",
    label: "main goal for next company",
    prompt:
      "Before I match roles, what matters most in your next company: career growth, compensation, stability, mission, learning, or something else?",
  },
  {
    id: "culture_stage",
    label: "company culture and stage",
    prompt:
      "What kind of company culture and size or stage tends to work best for you: early startup, scale-up, larger company, high ownership, calm team, or something else?",
  },
  {
    id: "industry_interest",
    label: "industry interests",
    prompt:
      "Which industries or domains are you most interested in right now? Free-form is fine.",
  },
  {
    id: "location_relocation",
    label: "location and relocation",
    prompt:
      "Where do you want to work, and are you open to remote, onsite, or relocating to another city?",
  },
  {
    id: "special_context",
    label: "special context",
    prompt:
      "Anything special I should know before matching you: constraints, strengths, dealbreakers, timing, or context that is not obvious from your resume?",
  },
]

const QUESTION_IDS = SHARED_ONBOARDING_QUESTIONS.map((q) => q.id)
const QUESTION_BY_ID = new Map(SHARED_ONBOARDING_QUESTIONS.map((q) => [q.id, q]))

function cleanPromptString(value: unknown, max = 80): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim().replace(/\s+/g, " ")
  if (!trimmed) return undefined
  return trimmed.slice(0, max)
}

function cleanPromptList(value: unknown, maxItems = 3, maxLen = 80): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const clean = cleanPromptString(item, maxLen)
    if (!clean) continue
    const key = clean.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(clean)
    if (out.length >= maxItems) break
  }
  return out
}

function firstNameFrom(value: unknown): string | undefined {
  const clean = cleanPromptString(value, 60)
  if (!clean) return undefined
  return clean.split(/\s+/)[0]
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function experiencesFrom(parsedResume: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(parsedResume.experiences)
    ? parsedResume.experiences.filter((item): item is Record<string, unknown> => (
      item !== null && typeof item === "object" && !Array.isArray(item)
    ))
    : []
}

export function buildSharedOnboardingPromptContext(input: {
  user?: Record<string, unknown> | null
  parsedResume?: Record<string, unknown> | null
}): SharedOnboardingPromptContext {
  const user = input.user ?? {}
  const parsedResume = input.parsedResume ?? {}
  const candidateProfile = objectValue(parsedResume.candidateProfile)
  const layoffContext = objectValue(user.layoffContext)
  const candidateContext = objectValue(user.candidateContext)
  const experiences = experiencesFrom(parsedResume)
  const recentCompanies = cleanPromptList([
    layoffContext.lastCompany,
    user.lastCompany,
    ...experiences.map((exp) => exp.company),
  ])
  const recentTitles = cleanPromptList([
    layoffContext.jobTitle,
    user.jobTitle,
    ...experiences.map((exp) => exp.title),
  ])
  const recentLocations = cleanPromptList([
    layoffContext.location,
    user.location,
    candidateContext.location,
    ...experiences.map((exp) => exp.location),
  ])
  const ctx: SharedOnboardingPromptContext = {
    firstName: firstNameFrom(user.firstName) ?? firstNameFrom(user.displayName) ?? firstNameFrom(candidateProfile.name),
    recentCompanies,
    recentTitles,
    recentLocations,
    currentLocation: cleanPromptString(user.location ?? candidateContext.location ?? layoffContext.location, 80),
    skills: cleanPromptList(candidateProfile.skills, 4, 40),
    industryTags: cleanPromptList(parsedResume.industryTags, 3, 80),
  }
  return Object.fromEntries(
    Object.entries(ctx).filter(([, value]) => Array.isArray(value) ? value.length > 0 : value !== undefined)
  ) as SharedOnboardingPromptContext
}

export function cleanSharedOnboardingPromptContext(value: unknown): SharedOnboardingPromptContext {
  const raw = objectValue(value)
  const ctx: SharedOnboardingPromptContext = {
    firstName: firstNameFrom(raw.firstName),
    recentCompanies: cleanPromptList(raw.recentCompanies),
    recentTitles: cleanPromptList(raw.recentTitles),
    recentLocations: cleanPromptList(raw.recentLocations),
    currentLocation: cleanPromptString(raw.currentLocation, 80),
    skills: cleanPromptList(raw.skills, 4, 40),
    industryTags: cleanPromptList(raw.industryTags, 3, 80),
  }
  return Object.fromEntries(
    Object.entries(ctx).filter(([, value]) => Array.isArray(value) ? value.length > 0 : value !== undefined)
  ) as SharedOnboardingPromptContext
}

function joinHuman(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ""
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`
}

function workSummary(ctx: SharedOnboardingPromptContext): string | null {
  const titles = ctx.recentTitles ?? []
  const companies = ctx.recentCompanies ?? []
  const skills = ctx.skills ?? []
  if (titles.length > 0 && companies.length > 0) return `${joinHuman(titles.slice(0, 2))} work at ${joinHuman(companies.slice(0, 2))}`
  if (companies.length > 0) return `work at ${joinHuman(companies.slice(0, 2))}`
  if (titles.length > 0) return `${joinHuman(titles.slice(0, 2))} work`
  if (skills.length > 0) return `${joinHuman(skills.slice(0, 3))} work`
  return null
}

function locationSummary(ctx: SharedOnboardingPromptContext): string | null {
  if (ctx.currentLocation) return `you listed ${ctx.currentLocation}`
  const locations = ctx.recentLocations ?? []
  if (locations.length > 0) return `your resume has ${joinHuman(locations.slice(0, 2))}`
  return null
}

export function buildSharedOnboardingPrompt(
  id: SharedOnboardingQuestionId,
  context?: SharedOnboardingPromptContext | null,
): string {
  const ctx = cleanSharedOnboardingPromptContext(context)
  const question = getSharedOnboardingQuestion(id)
  if (id === "main_goal") {
    const greeting = ctx.firstName ? `Hey ${ctx.firstName}, ` : ""
    const work = workSummary(ctx)
    const resumeLead = work ? `I saw from your resume that you've done ${work}. ` : ""
    return `${greeting}${resumeLead}For this next phase, what matters most in your next company: career growth, compensation, stability, mission, learning, or something else?`
  }
  if (id === "industry_interest" && (ctx.industryTags?.length ?? 0) > 0) {
    return `Your resume points toward ${joinHuman(ctx.industryTags ?? [])}. Which industries or domains are you actually most interested in right now? Free-form is fine.`
  }
  if (id === "location_relocation") {
    const location = locationSummary(ctx)
    const lead = location ? `I see ${location}. ` : ""
    return `${lead}Where do you want to work next, and are you open to remote, onsite, or relocating to another city?`
  }
  return question.prompt
}

export function getSharedOnboardingQuestion(id: SharedOnboardingQuestionId): SharedOnboardingQuestion {
  const question = QUESTION_BY_ID.get(id)
  if (!question) throw new Error(`unknown_shared_onboarding_question:${id}`)
  return question
}

export function isSharedOnboardingQuestionId(value: unknown): value is SharedOnboardingQuestionId {
  return typeof value === "string" && QUESTION_BY_ID.has(value as SharedOnboardingQuestionId)
}

export function resolveNextSharedOnboardingQuestionId(id: SharedOnboardingQuestionId): {
  nextQuestionId: SharedOnboardingQuestionId | null
  completed: boolean
  shouldRecommend: boolean
} {
  const index = QUESTION_IDS.indexOf(id)
  const nextQuestionId = index >= 0 ? QUESTION_IDS[index + 1] ?? null : QUESTION_IDS[0]
  return {
    nextQuestionId,
    completed: nextQuestionId === null,
    shouldRecommend: nextQuestionId === null,
  }
}

export function buildSharedOnboardingStartedState(
  nowIso: string,
  source: WekruitSignupSource = WEKRUIT_LAYOFF_SOURCE,
  promptContext?: SharedOnboardingPromptContext | null,
): Record<string, unknown> {
  const cleanContext = cleanSharedOnboardingPromptContext(promptContext)
  return {
    onboardingStatus: "invited",
    onboardingState: "pending",
    workSession: {
      kind: SHARED_ONBOARDING_WORK_SESSION_KIND,
      status: "active",
      startedAt: nowIso,
      boundary: SHARED_ONBOARDING_BOUNDARY,
      currentQuestionId: "main_goal",
    },
    sharedOnboarding: {
      source,
      status: "active",
      startedAt: nowIso,
      updatedAt: nowIso,
      currentQuestionId: "main_goal",
      questionOrder: QUESTION_IDS,
      answers: {},
      ...(Object.keys(cleanContext).length > 0 ? { promptContext: cleanContext } : {}),
      completed: false,
    },
    ...(source === WEKRUIT_LAYOFF_SOURCE
      ? { layoffOnboardingStartedAt: nowIso }
      : { candidateOnboardingStartedAt: nowIso }),
  }
}

function normalizedSource(value: unknown): WekruitSignupSource {
  return value === WEKRUIT_CANDIDATE_SOURCE ? WEKRUIT_CANDIDATE_SOURCE : WEKRUIT_LAYOFF_SOURCE
}

export function sharedOnboardingSignupSource(value: unknown): WekruitSignupSource {
  return normalizedSource(value)
}

export function isSharedOnboardingRuntimeEvent(rawMeta: unknown): boolean {
  if (!rawMeta || typeof rawMeta !== "object") return false
  const meta = rawMeta as Record<string, unknown>
  return (
    meta.runtimeEvent === true &&
    meta.runtimeEventSource === SHARED_ONBOARDING_EVENT_SOURCE &&
    meta.runtimeEventKind === SHARED_ONBOARDING_EVENT_KIND
  )
}

export function isSharedOnboardingActiveUser(user: unknown): boolean {
  if (!user || typeof user !== "object") return false
  const doc = user as Record<string, unknown>
  const shared = doc.sharedOnboarding && typeof doc.sharedOnboarding === "object"
    ? doc.sharedOnboarding as Record<string, unknown>
    : null
  const workSession = doc.workSession && typeof doc.workSession === "object"
    ? doc.workSession as Record<string, unknown>
    : null
  if (shared?.completed === true || shared?.status === "complete") return false
  if (workSession?.kind === SHARED_ONBOARDING_WORK_SESSION_KIND && workSession.status === "active") return true
  return shared?.status === "active"
}

export function currentSharedOnboardingQuestionId(user: unknown): SharedOnboardingQuestionId {
  if (!user || typeof user !== "object") return "main_goal"
  const doc = user as Record<string, unknown>
  const shared = doc.sharedOnboarding && typeof doc.sharedOnboarding === "object"
    ? doc.sharedOnboarding as Record<string, unknown>
    : null
  const workSession = doc.workSession && typeof doc.workSession === "object"
    ? doc.workSession as Record<string, unknown>
    : null
  const fromShared = shared?.currentQuestionId
  if (isSharedOnboardingQuestionId(fromShared)) return fromShared
  const fromWorkSession = workSession?.currentQuestionId
  if (isSharedOnboardingQuestionId(fromWorkSession)) return fromWorkSession
  return "main_goal"
}

function tagToken(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80)
}

function industryTags(text: string): string[] {
  const rules: Array<{ token: string; pattern: RegExp }> = [
    {
      token: "artificial_intelligence_and_machine_learning",
      pattern: /\b(ai|ml|machine\s+learning|artificial\s+intelligence|llm|deep\s+learning)\b/i,
    },
    { token: "financial_technology", pattern: /\b(fintech|financial\s+technology|payments?|banking)\b/i },
    { token: "crypto_web3_blockchain", pattern: /\b(crypto|web3|blockchain|defi)\b/i },
    { token: "software_and_saas", pattern: /\b(saas|software|developer\s+tools?)\b/i },
    { token: "cybersecurity", pattern: /\b(cyber\s*security|security)\b/i },
    { token: "healthcare_and_life_sciences", pattern: /\b(healthcare|health\s+tech|life\s+sciences?)\b/i },
    { token: "education_technology", pattern: /\b(edtech|education\s+technology)\b/i },
    { token: "gaming_and_esports", pattern: /\b(gaming|esports?)\b/i },
    { token: "clean_energy_and_climate_tech", pattern: /\b(climate|clean\s+energy|energy)\b/i },
  ]
  return rules.filter((rule) => rule.pattern.test(text)).map((rule) => rule.token)
}

function locationMentionIndex(text: string, token: string): number {
  const rules: Record<string, RegExp[]> = {
    new_york_metro: [/\bnyc\b/i, /new\s*york/i, /纽约/i],
    remote_united_states: [/\bremote\b/i, /在家/i],
    remote_anywhere: [/\banywhere\b/i, /\bremote\b/i],
    remote_global: [/\bremote\b/i],
    san_francisco_bay_area: [/\bsf\b/i, /san\s*francisco/i, /bay\s*area/i, /湾区/i],
    seattle_metro: [/seattle/i, /西雅图/i],
    los_angeles_metro: [/\bla\b/i, /los\s*angeles/i, /洛杉矶/i],
  }
  let best = Number.POSITIVE_INFINITY
  for (const rule of rules[token] ?? [new RegExp(token.replace(/_/g, "\\s+"), "i")]) {
    const hit = text.match(rule)
    if (hit?.index !== undefined && hit.index < best) best = hit.index
  }
  return best
}

function orderedLocations(text: string): string[] {
  return [...mapAnswerToLocations(text)].sort((a, b) => locationMentionIndex(text, a) - locationMentionIndex(text, b))
}

function relocationOpen(text: string): boolean | undefined {
  if (/\b(not|can't|cannot|won't|no)\b.{0,24}\b(relocat|move|moving)\b/i.test(text)) return false
  if (/\b(open|willing|can|would|able)\b.{0,32}\b(relocat|move|moving)\b/i.test(text)) return true
  if (/\brelocat(?:e|ing|ion)\b/i.test(text)) return true
  return undefined
}

function companySize(text: string): PartialUserTags["companySize"] | undefined {
  if (/\b(seed|pre[-\s]?seed|founding|early[-\s]?stage|startup)\b/i.test(text)) return "early_startup"
  if (/\b(series\s+[bcde]|scale[-\s]?up|growth[-\s]?stage)\b/i.test(text)) return "scale_up"
  if (/\b(mid[-\s]?market|medium[-\s]?sized)\b/i.test(text)) return "mid_market"
  if (/\b(enterprise|big\s*tech|large\s+company|public\s+company)\b/i.test(text)) return "enterprise"
  if (/\b(open|no\s+preference|either|any)\b/i.test(text)) return "open"
  return undefined
}

function companyGoalTags(text: string): string[] {
  const tags: string[] = []
  if (/\b(growth|career|promot|level\s*up|leadership)\b/i.test(text)) tags.push("career_growth")
  if (/\b(comp|compensation|pay|salary|tc|equity|money)\b/i.test(text)) tags.push("high_compensation")
  if (/\b(stability|stable|secure|security)\b/i.test(text)) tags.push("stability")
  if (/\b(mission|impact|purpose|meaningful)\b/i.test(text)) tags.push("mission_driven")
  if (/\b(learning|learn|mentor|mentorship)\b/i.test(text)) tags.push("learning")
  return tags
}

export function projectSharedOnboardingAnswer(
  questionId: SharedOnboardingQuestionId,
  answer: string,
): {
  memoryFact: string
  tags: PartialUserTags
  statedPreferences: Record<string, unknown>
  evidence: Record<string, unknown>
} {
  const trimmed = answer.trim()
  const question = getSharedOnboardingQuestion(questionId)
  const tags: PartialUserTags = {}
  const statedPreferences: Record<string, unknown> = {}
  const evidence: Record<string, unknown> = { questionId, answer: trimmed }

  if (questionId === "main_goal") {
    const targetCompanyTags = companyGoalTags(trimmed)
    if (targetCompanyTags.length > 0) tags.targetCompanyTags = targetCompanyTags
    if (targetCompanyTags.length > 0) statedPreferences.nextCompanyGoals = targetCompanyTags
  }

  if (questionId === "culture_stage") {
    const size = companySize(trimmed)
    const stageTags = [
      ...(/\b(high\s+ownership|ownership|autonomy)\b/i.test(trimmed) ? ["high_ownership"] : []),
      ...(/\b(calm|low\s+ego|collaborative|kind)\b/i.test(trimmed) ? ["calm_collaborative_culture"] : []),
    ]
    if (size) tags.companySize = size
    if (/\b(startup|early[-\s]?stage|seed|founding)\b/i.test(trimmed)) tags.prefersStartup = "startup"
    else if (/\b(big\s*tech|enterprise|large\s+company)\b/i.test(trimmed)) tags.prefersStartup = "bigtech"
    else if (/\b(either|open|no\s+preference)\b/i.test(trimmed)) tags.prefersStartup = "either"
    if (stageTags.length > 0) tags.targetCompanyTags = stageTags.map(tagToken)
    if (size) statedPreferences.companySize = size
  }

  if (questionId === "industry_interest") {
    const industries = industryTags(trimmed)
    if (industries.length > 0) tags.industrySector = industries
    if (industries.length > 0) statedPreferences.industrySector = industries
  }

  if (questionId === "location_relocation") {
    const targetLocations = orderedLocations(trimmed)
    const relocate = relocationOpen(trimmed)
    if (targetLocations.length > 0) tags.targetLocations = targetLocations
    if (targetLocations.length > 0) statedPreferences.targetLocations = targetLocations
    if (relocate !== undefined) {
      statedPreferences.relocationOpen = relocate
      evidence.relocationOpen = relocate
    }
  }

  if (questionId === "special_context") {
    const specialTags = []
    if (/\b(visa|sponsor|h[-\s]?1b|opt|cpt)\b/i.test(trimmed)) specialTags.push("visa_context")
    if (/\b(laid\s*off|layoff|severance|urgent|asap)\b/i.test(trimmed)) specialTags.push("urgent_search_context")
    if (/\b(parent|caregiver|health|family)\b/i.test(trimmed)) specialTags.push("personal_constraint")
    if (specialTags.length > 0) tags.targetCompanyTags = specialTags
    statedPreferences.specialContext = trimmed
  }

  return {
    memoryFact: `Candidate onboarding answer (${question.label}): ${trimmed}`,
    tags,
    statedPreferences,
    evidence,
  }
}
