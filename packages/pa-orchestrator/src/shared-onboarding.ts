import type { PartialUserTags } from "./tags/user-tags-writer.js"
import { mapAnswerToLocations, mapAnswerToRoleFunction } from "./tags/onboarding-mappers.js"
import { PA_COLLECTIONS } from "@pa/core-types"
import type { IndustrySector } from "@wekruit/shared-tags"
import type { JudgeResult, Lang } from "./onboarding/question.js"
import { GuidedOpenJudge, type LlmCallFn } from "./onboarding/judges/guided-open.js"
import {
  WEKRUIT_CANDIDATE_SOURCE,
  WEKRUIT_LAYOFF_SOURCE,
  type WekruitSignupSource,
} from "./onboarding.js"

export const SHARED_ONBOARDING_EVENT_SOURCE = "shared_onboarding"
export const SHARED_ONBOARDING_EVENT_KIND = "onboarding_started"
export const SHARED_ONBOARDING_WORK_SESSION_KIND = "shared_onboarding"
export const SHARED_ONBOARDING_BOUNDARY = "website_sms_onboarding"
export const CANDIDATE_PROFILE_URL = "https://wekruit.com/me/profile"

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
  resumeSummary?: string
}

export type SharedOnboardingAnswerJudgeArgs = {
  questionId: SharedOnboardingQuestionId
  answer: string
  lang?: Lang
  userId?: string
  turnId?: string
  log?: (event: string, payload: Record<string, unknown>) => void
  llmCallFactory?: () => LlmCallFn
}

type FirestoreDocSnapshotLike = {
  exists?: boolean
  data?: () => unknown
}

type FirestoreCollectionLike = {
  doc?: (id: string) => { get: () => Promise<FirestoreDocSnapshotLike> }
  where?: (field: string, op: string, value: unknown) => {
    orderBy?: (field: string, direction?: "asc" | "desc") => {
      limit?: (count: number) => { get: () => Promise<{ empty?: boolean; docs?: FirestoreDocSnapshotLike[] }> }
      get?: () => Promise<{ empty?: boolean; docs?: FirestoreDocSnapshotLike[] }>
    }
    limit?: (count: number) => { get: () => Promise<{ empty?: boolean; docs?: FirestoreDocSnapshotLike[] }> }
    get?: () => Promise<{ empty?: boolean; docs?: FirestoreDocSnapshotLike[] }>
  }
}

type FirestoreLike = {
  collection: (name: string) => FirestoreCollectionLike
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
    prompt: "Any non-negotiables I should keep in mind before matching you?",
  },
]

const QUESTION_IDS = SHARED_ONBOARDING_QUESTIONS.map((q) => q.id)
const QUESTION_BY_ID = new Map(SHARED_ONBOARDING_QUESTIONS.map((q) => [q.id, q]))
const PARSED_CANDIDATE_RESUMES = "parsedCandidateResumes"

function normalizeControlText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** Visible iMessage opener prefix (Adam 2026-05-19 + user_id bind 2026-05-20). */
export const HELLO_WEKRUIT_OPENER_PREFIX = "Hello, WeKruit!"

const HELLO_WEKRUIT_OPENER_RE =
  /^hello,?\s*wekruit!?\s*([a-z0-9][a-z0-9_-]{7,127})?\s*$/i
const WEKRUIT_JOB_OPENER_RE =
  /(?:^|\s)wekruit_([a-z0-9][a-z0-9-]{1,160})_([a-z0-9][a-z0-9_-]{7,127})_job(?:\s|$)/i

/** Build the sms: deep-link body candidates send to bind phone → pa-users/{candidateId}. */
export function buildHelloWekruitOpenerBody(candidateId: string): string {
  const id = candidateId.trim()
  if (!id) return HELLO_WEKRUIT_OPENER_PREFIX
  return `${HELLO_WEKRUIT_OPENER_PREFIX} ${id}`
}

/** Parse inbound opener; returns candidateId when the suffix is present. */
export function parseHelloWekruitOpener(value: string): { candidateId: string } | null {
  const trimmed = value.trim()
  const jobMatch = trimmed.match(WEKRUIT_JOB_OPENER_RE)
  if (jobMatch?.[2]) return { candidateId: jobMatch[2].trim() }
  const match = trimmed.match(HELLO_WEKRUIT_OPENER_RE)
  if (!match) return null
  const candidateId = match[1]?.trim()
  return candidateId ? { candidateId } : null
}

export function isSharedOnboardingGreetingOrKickoff(value: string): boolean {
  if (parseHelloWekruitOpener(value)) return true
  const normalized = normalizeControlText(value)
  if (!normalized) return true
  if (normalized === "pa reset") return true
  if (/^wekruit\s+(?:candidate\s+hi|laid\s+off|rain\s+software\s+engineer)/i.test(normalized)) return true
  if (/^hello wekruit(?: [a-z0-9_-]+)?$/.test(normalized)) return true
  return /^(?:hello|hi|hey|yo|sup|\u4f60\u597d|\u60a8\u597d|\u54c8\u55bd|\u5728\u5417)(?:\s+(?:wekruit|claire))?$/.test(normalized)
}

/**
 * Q1-only: duplicate hello/kickoff while still on main_goal — ignore, do not
 * advance or re-ask (user is not answering the question yet).
 */
export function shouldIgnoreSharedOnboardingDuplicateKickoff(
  questionId: SharedOnboardingQuestionId,
  answer: string,
): boolean {
  return questionId === "main_goal" && isSharedOnboardingGreetingOrKickoff(answer)
}

/**
 * Shared onboarding never re-asks the same slot verbatim — judge rejections,
 * LLM timeouts, and unclear parses still advance with the raw reply stored.
 * Re-asking the canonical prompt feels glitchy in iMessage (Adam 2026-05-19).
 */
export function shouldSharedOnboardingAdvanceDespiteJudge(
  questionId: SharedOnboardingQuestionId,
  answer: string,
): boolean {
  return !shouldIgnoreSharedOnboardingDuplicateKickoff(questionId, answer)
}

function parseSharedJudgeValue(raw: unknown): string | null {
  if (typeof raw === "string") {
    const trimmed = raw.trim().replace(/\s+/g, " ")
    return trimmed && !isSharedOnboardingGreetingOrKickoff(trimmed) ? trimmed.slice(0, 280) : null
  }
  if (Array.isArray(raw)) {
    const joined = raw
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim().replace(/\s+/g, " "))
      .filter(Boolean)
      .slice(0, 5)
      .join(", ")
    return joined && !isSharedOnboardingGreetingOrKickoff(joined) ? joined.slice(0, 280) : null
  }
  return null
}

function sharedJudgeHints(questionId: SharedOnboardingQuestionId): string[] {
  if (questionId === "main_goal") {
    return ["career_growth", "compensation", "stability", "mission", "learning", "ownership", "work_life_balance"]
  }
  if (questionId === "culture_stage") {
    return ["early_startup", "scale_up", "larger_company", "high_ownership", "calm_team", "collaborative", "open"]
  }
  if (questionId === "industry_interest") {
    return ["financial_technology", "artificial_intelligence", "crypto_web3_blockchain", "software_saas", "healthcare", "developer_tools", "open"]
  }
  if (questionId === "location_relocation") {
    return ["remote", "onsite", "hybrid", "new_york", "san_francisco", "seattle", "relocation_open", "no_relocation"]
  }
  return ["constraints", "strengths", "dealbreakers", "timing", "visa", "none"]
}

function sharedJudgeExamples(questionId: SharedOnboardingQuestionId): Array<{ reply: string; value: string; confidence: number }> {
  if (questionId === "main_goal") {
    return [
      { reply: "career growth and learning matter most", value: "career growth and learning", confidence: 0.95 },
      { reply: "compensation and stability, but mission matters too", value: "compensation, stability, and mission", confidence: 0.95 },
    ]
  }
  if (questionId === "culture_stage") {
    return [
      { reply: "early startup with high ownership", value: "early startup with high ownership", confidence: 0.95 },
      { reply: "larger calm team, less chaos", value: "larger calm team", confidence: 0.9 },
    ]
  }
  if (questionId === "industry_interest") {
    return [
      { reply: "fintech and AI infrastructure", value: "fintech and AI infrastructure", confidence: 0.95 },
      { reply: "open, but developer tools are interesting", value: "developer tools, open", confidence: 0.9 },
    ]
  }
  if (questionId === "location_relocation") {
    return [
      { reply: "NYC or remote, open to Seattle", value: "NYC, remote, open to Seattle", confidence: 0.95 },
      { reply: "Bay Area onsite is fine, not relocating", value: "Bay Area onsite, not relocating", confidence: 0.95 },
    ]
  }
  return [
    { reply: "nothing else, I can start quickly", value: "nothing else, can start quickly", confidence: 0.9 },
    { reply: "I need sponsorship and want backend-heavy work", value: "needs sponsorship, backend-heavy work", confidence: 0.95 },
  ]
}

function sharedJudgeBloom(questionId: SharedOnboardingQuestionId): Array<{ pattern: RegExp; value: string }> {
  // Shared onboarding blooms are accept signals; preserve the candidate's raw
  // answer instead of storing an internal label.
  const preserveRawAnswer = ""
  if (questionId === "main_goal") {
    return [
      { pattern: /\b(career\s+growth|growth|learning|mentor|compensation|salary|pay|equity|stability|stable|mission|impact|ownership|work[-\s]?life)\b/i, value: preserveRawAnswer },
    ]
  }
  if (questionId === "culture_stage") {
    return [
      { pattern: /\b(startup|early[-\s]?stage|seed|founding|scale[-\s]?up|larger|large\s+company|big\s*tech|enterprise|ownership|autonomy|calm|collaborative|open|no\s+preference)\b/i, value: preserveRawAnswer },
    ]
  }
  if (questionId === "industry_interest") {
    return [
      { pattern: /\b(fintech|finance|ai|machine\s+learning|ml|crypto|web3|blockchain|saas|software|developer\s+tools?|security|healthcare|edtech|gaming|climate|open|anything)\b/i, value: preserveRawAnswer },
    ]
  }
  if (questionId === "location_relocation") {
    return [
      { pattern: /\b(remote|onsite|hybrid|relocat|move|nyc|new\s+york|sf|san\s+francisco|bay\s+area|seattle|los\s+angeles|la|austin|boston|chicago|miami|canada|united\s+states|u\.?s\.?)\b/i, value: preserveRawAnswer },
    ]
  }
  return [
    {
      pattern:
        /\b(none|nothing|nope|no\s+special|visa|sponsor|h[-\s]?1b|opt|cpt|urgent|asap|timing|dealbreaker|constraint|strength|backend|frontend|full[-\s]?stack|systems?|real[-\s]?time|communication|webrtc|infrastructure|distributed|worthy|experience|built|handl\w*)\b/i,
      value: preserveRawAnswer,
    },
  ]
}

export async function judgeSharedOnboardingAnswer(
  args: SharedOnboardingAnswerJudgeArgs,
): Promise<JudgeResult<string>> {
  const answer = args.answer.trim()
  if (isSharedOnboardingGreetingOrKickoff(answer)) {
    return { accept: false, reason: "irrelevant" }
  }
  const question = getSharedOnboardingQuestion(args.questionId)
  const bloomRegex = sharedJudgeBloom(args.questionId)
  if (bloomRegex.some((bloom) => bloom.pattern.test(answer))) {
    return { accept: true, value: answer, confidence: 1.0 }
  }
  const judge = new GuidedOpenJudge<string>({
    questionLabel: question.label,
    hints: sharedJudgeHints(args.questionId),
    examples: sharedJudgeExamples(args.questionId),
    bloomRegex,
    parseValue: parseSharedJudgeValue,
    confidenceThreshold: 0.62,
    minMeaningfulChars: 2,
    failOpenOnLlmError: true,
    ...(args.llmCallFactory ? { llmCallFactory: args.llmCallFactory } : {}),
  })
  return judge.judge(answer, args.lang ?? "en", {
    userId: args.userId ?? "unknown",
    turnId: args.turnId ?? "unknown",
    log: args.log,
  })
}

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

function summaryTextFrom(value: Record<string, unknown>): string | undefined {
  const raw =
    value.candidateProfileSummary ??
    value.profileSummary ??
    value.resumeSummary ??
    value.summary
  const clean = cleanPromptString(raw, 220)
  return clean?.replace(/^User resume summary:\s*/i, "").trim()
}

function experienceFromSummary(summary: string | undefined): Record<string, unknown> | null {
  if (!summary) return null
  const match =
    summary.match(/(?:currently\/last|currently|last)\s+(.+?)\s+at\s+(.+?)(?:\s*\(|[.;]|$)/i) ??
    summary.match(/[—-]\s*(.+?)\s+at\s+(.+?)(?:\s*\(|[.;]|$)/)
  const title = cleanPromptString(match?.[1], 80)
  const company = cleanPromptString(match?.[2], 80)
  if (!title && !company) return null
  return {
    ...(title ? { title } : {}),
    ...(company ? { company } : {}),
  }
}

function skillsFromSummary(summary: string | undefined): string[] {
  const match = summary?.match(/\bSkills:\s*([^.]+)/i)
  if (!match?.[1]) return []
  return cleanPromptList(match[1].split(/[,;/|]+/), 8, 40)
}

function parsedResumeFromArtifactSummary(artifact: Record<string, unknown>): Record<string, unknown> | null {
  const summary = summaryTextFrom(artifact)
  const experience = experienceFromSummary(summary)
  const skills = skillsFromSummary(summary)
  if (!summary && !experience && skills.length === 0) return null
  return {
    ...(summary ? { candidateProfileSummary: summary } : {}),
    ...(experience ? { experiences: [experience] } : {}),
    ...(skills.length > 0 ? { candidateProfile: { skills } } : {}),
  }
}

function objectDocData(snap: FirestoreDocSnapshotLike | undefined | null): Record<string, unknown> | null {
  if (!snap) return null
  if (snap.exists === false) return null
  const data = snap.data?.()
  return data && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown>
    : null
}

export async function loadSharedOnboardingParsedResumeForPrompt(
  db: FirestoreLike,
  userId: string,
  user?: Record<string, unknown> | null,
  log?: (event: string, payload?: Record<string, unknown>) => void,
): Promise<Record<string, unknown> | null> {
  const latestResumeArtifactId = cleanPromptString(user?.latestResumeArtifactId, 240)
  if (latestResumeArtifactId) {
    try {
      const artifactDoc = db.collection(PA_COLLECTIONS.resumeArtifacts).doc?.(latestResumeArtifactId)
      const artifact = objectDocData(await artifactDoc?.get())
      if (!artifact) {
        log?.("shared_onboarding.resume_prompt_context.artifact_miss", {
          userId,
          latestResumeArtifactId,
        })
      } else {
        const parsedCandidateResumeId = cleanPromptString(artifact.parsedCandidateResumeId, 240)
        if (parsedCandidateResumeId) {
          const parsedDoc = db.collection(PARSED_CANDIDATE_RESUMES).doc?.(parsedCandidateResumeId)
          const parsedResume = objectDocData(await parsedDoc?.get())
          if (parsedResume) return parsedResume
          const artifactResume = parsedResumeFromArtifactSummary(artifact)
          if (artifactResume) return artifactResume
          log?.("shared_onboarding.resume_prompt_context.parsed_resume_miss", {
            userId,
            latestResumeArtifactId,
            parsedCandidateResumeId,
          })
        } else {
          const artifactResume = parsedResumeFromArtifactSummary(artifact)
          if (artifactResume) return artifactResume
          log?.("shared_onboarding.resume_prompt_context.artifact_pointer_miss", {
            userId,
            latestResumeArtifactId,
          })
        }
      }
    } catch (err) {
      log?.("shared_onboarding.resume_prompt_context.artifact_lookup_failed", {
        userId,
        latestResumeArtifactId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  try {
    const collection = db.collection(PARSED_CANDIDATE_RESUMES)
    if (typeof collection.where !== "function") return null
    const query = collection.where("userId", "==", userId)
    const ordered = query.orderBy?.("createdAt", "desc") ?? query
    const limited = ordered.limit?.(1) ?? ordered
    const snap = await limited.get?.()
    if (!snap || snap.empty || !snap.docs || snap.docs.length === 0) return null
    return objectDocData(snap.docs[0])
  } catch (err) {
    log?.("shared_onboarding.resume_prompt_context.lookup_failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
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
  const resumeSummary = summaryTextFrom(parsedResume)
  const summaryExperience = experienceFromSummary(resumeSummary)
  const experiences = experiencesFrom(parsedResume)
  const promptExperiences = experiences.length > 0
    ? experiences
    : summaryExperience
      ? [summaryExperience]
      : []
  const parsedSkills = [
    ...cleanPromptList(candidateProfile.skills, 8, 40),
    ...skillsFromSummary(resumeSummary),
  ]
  const recentCompanies = cleanPromptList([
    layoffContext.lastCompany,
    user.lastCompany,
    ...promptExperiences.map((exp) => exp.company),
  ])
  const recentTitles = cleanPromptList([
    layoffContext.jobTitle,
    user.jobTitle,
    ...promptExperiences.map((exp) => exp.title),
  ])
  const recentLocations = cleanPromptList([
    layoffContext.location,
    user.location,
    candidateContext.location,
    ...promptExperiences.map((exp) => exp.location),
  ])
  const ctx: SharedOnboardingPromptContext = {
    firstName: firstNameFrom(user.firstName) ?? firstNameFrom(user.displayName) ?? firstNameFrom(candidateProfile.name),
    recentCompanies,
    recentTitles,
    recentLocations,
    currentLocation: cleanPromptString(user.location ?? candidateContext.location ?? layoffContext.location, 80),
    skills: cleanPromptList(parsedSkills, 4, 40),
    industryTags: cleanPromptList(parsedResume.industryTags, 3, 80),
    resumeSummary,
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
    resumeSummary: cleanPromptString(raw.resumeSummary, 220),
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

function humanizeSignal(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
  if (!cleaned) return cleaned
  return cleaned
    .replace(/\bai\b/gi, "AI")
    .replace(/\bml\b/gi, "ML")
    .replace(/\bsaas\b/gi, "SaaS")
}

function humanSignalList(items: readonly string[] | undefined, maxItems = 3): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of items ?? []) {
    const clean = humanizeSignal(item)
    if (!clean) continue
    const key = clean.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(clean)
    if (out.length >= maxItems) break
  }
  return out
}

function workSummary(ctx: SharedOnboardingPromptContext): string | null {
  const titles = ctx.recentTitles ?? []
  const companies = ctx.recentCompanies ?? []
  const skills = humanSignalList(ctx.skills, 3)
  if (titles.length > 0 && companies.length > 0) return `${joinHuman(titles.slice(0, 2))} work at ${joinHuman(companies.slice(0, 2))}`
  if (companies.length > 0) return `work at ${joinHuman(companies.slice(0, 2))}`
  if (titles.length > 0) return `${joinHuman(titles.slice(0, 2))} work`
  if (skills.length > 0) return `${joinHuman(skills.slice(0, 3))} work`
  return null
}

function openingResumeDetail(ctx: SharedOnboardingPromptContext): string | null {
  const title = ctx.recentTitles?.[0]
  const company = ctx.recentCompanies?.[0]
  const location = ctx.currentLocation ?? ctx.recentLocations?.[0]
  const industries = humanSignalList(ctx.industryTags, 2)
  const skills = humanSignalList(ctx.skills, 2)
  if (title && location && company) return `${title} in ${location} at ${company}`
  if (title && company) return `${title} work at ${company}`
  if (title && location) return `${title} in ${location}`
  if (company && location) return `${company} in ${location}`
  if (title) return title
  if (company) return `${company} on there`
  if (industries.length > 0) return `${joinHuman(industries)} background`
  if (skills.length > 0) return `${joinHuman(skills)} experience`
  return null
}

export function buildSharedOnboardingOpeningPrompt(
  context?: SharedOnboardingPromptContext | null,
): string {
  const ctx = cleanSharedOnboardingPromptContext(context)
  const greeting = ctx.firstName ? `Hey ${ctx.firstName}!` : "Hey!"
  const detail = openingResumeDetail(ctx)
  const resumeLine = detail
    ? ` Saw your resume come through: ${detail}.`
    : " Saw your resume come through."
  return [
    `${greeting}${resumeLine}`,
    "If there's a strong fit, I'll connect you with the hiring manager.",
    `You can also update ${CANDIDATE_PROFILE_URL}, or just tell me here.`,
    getSharedOnboardingQuestion("main_goal").prompt,
  ].join(" ")
}

export type SharedOnboardingPostPrescreenContext = {
  jobTitle?: string | null
  company?: string | null
}

export function buildSharedOnboardingPostPrescreenOpeningPrompt(
  context: SharedOnboardingPromptContext | null | undefined,
  postPrescreen: SharedOnboardingPostPrescreenContext | null | undefined,
): string {
  const ctx = cleanSharedOnboardingPromptContext(context)
  const greeting = ctx.firstName ? `Hey ${ctx.firstName}!` : "Hey!"
  const jobTitle = typeof postPrescreen?.jobTitle === "string" ? postPrescreen.jobTitle.trim() : ""
  const company = typeof postPrescreen?.company === "string" ? postPrescreen.company.trim() : ""
  const roleText =
    jobTitle && company
      ? ` for ${jobTitle} at ${company}`
      : jobTitle
        ? ` for ${jobTitle}`
        : company
          ? ` at ${company}`
          : ""
  return [
    `${greeting} Thanks for completing the role screen${roleText}.`,
    "By the way, I can keep looking for jobs that meet your expectations, but I need one bit of broader context first.",
    getSharedOnboardingQuestion("main_goal").prompt,
  ].join(" ")
}

/**
 * Pulls a one-line "resume anchor" the LLM can quote when opening a question.
 * Used by `buildOnboardingSurfaceIntent` to make Q1 (main_goal) and Q2
 * (culture_stage) feel sexy/personal — Claire references the candidate's
 * actual title/company before asking the canonical question.
 *
 * Returns null when there's nothing useful on file (no companies, no titles,
 * no skills) so the surface stays generic instead of fabricating a quote.
 *
 * Slot-aware so we can phrase differently for Q1 vs Q2; today Q3
 * (industry_interest) already has resume copy inside `buildSharedOnboardingPrompt`,
 * so we don't double-anchor it here. Q4 (location) and Q5 (special) stay
 * generic.
 */
export function buildSharedOnboardingResumeAnchor(
  slot: SharedOnboardingQuestionId,
  promptContext?: SharedOnboardingPromptContext | null,
): string | null {
  if (slot !== "main_goal" && slot !== "culture_stage") return null
  const ctx = cleanSharedOnboardingPromptContext(promptContext)
  const work = workSummary(ctx)
  if (slot === "main_goal") {
    const openingDetail = openingResumeDetail(ctx)
    if (openingDetail) return `Saw your resume come through: ${openingDetail}.`
    if (work) return `Saw you've done ${work}.`
    if (ctx.resumeSummary) return `Quick summary I noted: ${ctx.resumeSummary}.`
    return null
  }
  // culture_stage — bias toward company stage references when we have them
  const titles = ctx.recentTitles ?? []
  const companies = ctx.recentCompanies ?? []
  if (titles.length > 0 && companies.length > 0) {
    return `Given your ${joinHuman(titles.slice(0, 1))} background at ${joinHuman(companies.slice(0, 2))},`
  }
  if (companies.length > 0) return `Given your ${joinHuman(companies.slice(0, 2))} background,`
  if (titles.length > 0) return `Given your ${joinHuman(titles.slice(0, 2))} background,`
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
    const resumeLead = work
      ? `I saw from your resume that you've done ${work}. `
      : ctx.resumeSummary
        ? `I saw your resume summary: ${ctx.resumeSummary}. `
        : ""
    return `${greeting}${resumeLead}For this next phase, what matters most in your next company: career growth, compensation, stability, mission, learning, or something else?`
  }
  if (id === "industry_interest" && (ctx.industryTags?.length ?? 0) > 0) {
    return `Your resume points toward ${joinHuman(humanSignalList(ctx.industryTags))}. Which industries or domains are you actually most interested in right now? Free-form is fine.`
  }
  if (id === "location_relocation") {
    const location = locationSummary(ctx)
    const lead = location ? `I see ${location}. ` : ""
    return `${lead}Where should I look next: specific cities, remote, onsite, or open to relocating?`
  }
  return question.prompt
}

export function buildSharedOnboardingReask(
  id: SharedOnboardingQuestionId,
  context?: SharedOnboardingPromptContext | null,
  judgeResult?: Extract<JudgeResult<string>, { accept: false }>,
): string {
  const clarification = judgeResult?.clarifyingQuestion?.trim()
  if (clarification) return clarification
  const prompt = buildSharedOnboardingPrompt(id, context)
  return `I can help with that, but I need this part first so I can match roles correctly. ${prompt}`
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

/**
 * QA 2026-05-28 (#3) — which shared-onboarding slots are already satisfied by the
 * unified user tags / statedPreferences. The extract-first capture (forceTrigger
 * extractor on every onboarding turn) can fill `industrySector` + `targetLocations`
 * from an out-of-slot message; only those two axes are emittable by the chat
 * extractor (conversation-extractor.ts tagPatch). main_goal / culture_stage /
 * special_context are onboarding-specific concepts the extractor can't produce, so
 * they're never auto-satisfied (always asked in order).
 */
export function isSharedOnboardingSlotSatisfied(
  slot: SharedOnboardingQuestionId,
  tags: Record<string, unknown> | null | undefined,
  statedPreferences: Record<string, unknown> | null | undefined,
): boolean {
  const t = tags ?? {}
  const sp = statedPreferences ?? {}
  const nonEmptyArr = (v: unknown): boolean => Array.isArray(v) && v.length > 0
  if (slot === "industry_interest") {
    return nonEmptyArr(t.industrySector) || nonEmptyArr(sp.industrySector)
  }
  if (slot === "location_relocation") {
    return nonEmptyArr(t.targetLocations) || nonEmptyArr(sp.targetLocations)
  }
  return false
}

/**
 * Like {@link resolveNextSharedOnboardingQuestionId} but SKIPS slots already
 * satisfied by captured tags — so extract-first onboarding asks only what's still
 * missing instead of re-asking a slot the user already volunteered out of order
 * (the QA 2026-05-28 re-ask loop: location asked again after the user gave it).
 */
export function resolveNextMissingSharedOnboardingQuestionId(
  fromId: SharedOnboardingQuestionId,
  tags: Record<string, unknown> | null | undefined,
  statedPreferences: Record<string, unknown> | null | undefined,
): { nextQuestionId: SharedOnboardingQuestionId | null; completed: boolean; shouldRecommend: boolean } {
  const startIdx = QUESTION_IDS.indexOf(fromId)
  for (let i = startIdx + 1; i < QUESTION_IDS.length; i++) {
    const candidate = QUESTION_IDS[i]!
    if (!isSharedOnboardingSlotSatisfied(candidate, tags, statedPreferences)) {
      return { nextQuestionId: candidate, completed: false, shouldRecommend: false }
    }
  }
  return { nextQuestionId: null, completed: true, shouldRecommend: true }
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
  return value === WEKRUIT_LAYOFF_SOURCE ? WEKRUIT_LAYOFF_SOURCE : WEKRUIT_CANDIDATE_SOURCE
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

function industryTags(text: string): IndustrySector[] {
  const rules: Array<{ token: IndustrySector; pattern: RegExp }> = [
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
    { token: "media_and_entertainment", pattern: /\b(media|entertainment|film|movie|youtube|creator|streaming)\b/i },
    { token: "fashion_and_apparel", pattern: /\b(fashion|apparel|clothing|lifestyle)\b/i },
    { token: "consumer_goods", pattern: /\bconsumer\s+(brand|brands|goods|products?)\b/i },
    { token: "advertising_and_marketing", pattern: /\b(advertising|marketing|brand)\b/i },
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

function mainGoalRoleFunction(text: string): ReturnType<typeof mapAnswerToRoleFunction> {
  if (!/\b(growth\s+(and\s+)?(ops|operations|marketing|role|roles)|growth\s+marketing|gtm|go[-\s]?to[-\s]?market)\b/i.test(text)) {
    return []
  }
  return mapAnswerToRoleFunction(text)
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
  const opportunisticLocations = orderedLocations(trimmed)

  if (questionId === "main_goal") {
    const targetCompanyTags = companyGoalTags(trimmed)
    const targetRoleFunction = mainGoalRoleFunction(trimmed)
    if (targetCompanyTags.length > 0) tags.targetCompanyTags = targetCompanyTags
    if (targetCompanyTags.length > 0) statedPreferences.nextCompanyGoals = targetCompanyTags
    if (targetRoleFunction.length > 0) {
      tags.targetRoleFunction = targetRoleFunction
      statedPreferences.targetRoleFunction = targetRoleFunction
    }
    if (opportunisticLocations.length > 0) {
      tags.targetLocations = opportunisticLocations
      statedPreferences.targetLocations = opportunisticLocations
    }
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
    const targetRoleFunction = mapAnswerToRoleFunction(trimmed)
    if (industries.length > 0) tags.industrySector = industries
    if (industries.length > 0) statedPreferences.industrySector = industries
    if (targetRoleFunction.length > 0) {
      tags.targetRoleFunction = targetRoleFunction
      statedPreferences.targetRoleFunction = targetRoleFunction
    }
  }

  if (questionId === "location_relocation") {
    const targetLocations = orderedLocations(trimmed)
    const industries = industryTags(trimmed)
    const relocate = relocationOpen(trimmed)
    if (targetLocations.length > 0) tags.targetLocations = targetLocations
    if (targetLocations.length > 0) statedPreferences.targetLocations = targetLocations
    if (industries.length > 0) {
      tags.industrySector = industries
      statedPreferences.industrySector = industries
    }
    if (relocate !== undefined) {
      statedPreferences.relocationOpen = relocate
      evidence.relocationOpen = relocate
    }
  }

  if (questionId === "special_context") {
    const targetRoleFunction = mapAnswerToRoleFunction(trimmed)
    const industries = industryTags(trimmed)
    const specialTags = []
    if (/\b(visa|sponsor|h[-\s]?1b|opt|cpt)\b/i.test(trimmed)) specialTags.push("visa_context")
    if (/\b(laid\s*off|layoff|severance|urgent|asap)\b/i.test(trimmed)) specialTags.push("urgent_search_context")
    if (/\b(parent|caregiver|health|family)\b/i.test(trimmed)) specialTags.push("personal_constraint")
    if (specialTags.length > 0) tags.targetCompanyTags = specialTags
    if (targetRoleFunction.length > 0) {
      tags.targetRoleFunction = targetRoleFunction
      statedPreferences.targetRoleFunction = targetRoleFunction
    }
    if (industries.length > 0) {
      tags.industrySector = industries
      statedPreferences.industrySector = industries
    }
    if (opportunisticLocations.length > 0) {
      tags.targetLocations = opportunisticLocations
      statedPreferences.targetLocations = opportunisticLocations
    }
    statedPreferences.specialContext = trimmed
  }

  return {
    memoryFact: `Candidate onboarding answer (${question.label}): ${trimmed}`,
    tags,
    statedPreferences,
    evidence,
  }
}
