import type { PartialUserTags } from "./tags/user-tags-writer.js"
import {
  validateOnboardingCanonicalTags,
  type OnboardingCanonicalTagInput,
} from "./tags/onboarding-canonical-tags.js"
import { PA_COLLECTIONS } from "@pa/core-types"
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
  | "target_role"
  | "industry_interest"
  | "location_relocation"
  | "seniority_comp"
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

/**
 * FULL definition set — ALL 7 onboarding question slots, with their canonical
 * prompts. This is the source of `QUESTION_BY_ID`, `getSharedOnboardingQuestion`,
 * and the `SharedOnboardingQuestionId` union — so every slot (including the 5 that
 * are NO LONGER ASKED upfront) STAYS resolvable. An in-flight user whose durable
 * `currentQuestionId` is e.g. `culture_stage` must still resolve a prompt via the
 * map; that is why we never delete these definitions.
 *
 * 2026-06-02 onboarding trim (Adam #1 friction — "too many questions / minimal
 * upfront / super easy to start"): the ASKED upfront flow (`SHARED_ONBOARDING_QUESTIONS`
 * below) is now only the TWO hard-filter axes — `target_role` then
 * `location_relocation`. The other 5 (`main_goal` / `culture_stage` /
 * `industry_interest` / `seniority_comp` / `special_context`) are SOFT score
 * signals and become EXTRACT-ONLY: `record_onboarding_answer` already pulls every
 * canonical enum (roleFunction / industrySector / companySize / careerStage /
 * minSalary / locations / visa + per-axis hardness) from ANY free-text turn via
 * applyPartialUserTags, so no capture is lost — they're just no longer a wall of
 * upfront questions. GLOBAL trim (all users), migration-safe for in-flight sessions.
 */
export const ALL_SHARED_ONBOARDING_QUESTIONS: readonly SharedOnboardingQuestion[] = [
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
    // Adam 2026-05-30: today targetRoleFunction is only seeded from the résumé;
    // onboarding never confirms what role the candidate actually wants NEXT (a
    // SWE may be pivoting to PM/data/design). One warm question to capture
    // forward intent. The record_onboarding_answer tool extracts
    // targetRoleFunction (canonical roleFunction enum, multi-pick) from this
    // free-text reply — we only define the slot + prompt here (no extraction
    // logic, no regex in this file).
    id: "target_role",
    label: "target role function",
    prompt:
      "What kind of roles are you going for next — same lane (e.g. software engineering), or shifting toward something like product, data, or design?",
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
      "We're US-only right now — where in the US do you want to work, and are you open to remote within the US, onsite, or relocating to another US city?",
  },
  {
    // Adam 2026-05-30: one warm question covering target level (intern vs
    // full-time + entry/junior/mid/senior) AND expected/target salary, AND
    // whether each is flexible/negotiable or firm. The record_onboarding_answer
    // tool extracts careerStage / targetJobType / minSalary + per-axis
    // preferenceHardness (hard vs soft + buffer) from this free-text reply — we
    // only define the slot + prompt here (no extraction logic in this file).
    id: "seniority_comp",
    label: "seniority level and expected salary",
    prompt:
      "Are you targeting internships or full-time roles (and roughly what level — entry, junior, mid, or senior), and what salary are you aiming for? Also, are those flexible/negotiable or pretty firm?",
  },
  {
    id: "special_context",
    label: "special context",
    prompt: "Any non-negotiables I should keep in mind before matching you?",
  },
]

/**
 * The ASKED upfront flow (Adam 2026-06-02 trim). Only the two HARD-filter axes the
 * matcher actually gates on — `target_role` (targetRoleFunction, also the warm
 * forward-intent opener) then `location_relocation` (targetLocations + the only place
 * US-only is surfaced). The FSM walks THIS array, so onboarding COMPLETES after
 * `location_relocation`; every other question stays definition-only (extract-only).
 *
 * This is the array `DEFAULT_ONBOARDING_SLOTS` (onboarding-fsm.ts) derives from, so the
 * thin FSM default slot set becomes length 2 automatically. `QUESTION_BY_ID` /
 * `getSharedOnboardingQuestion` / the union are built from the FULL set above so dropped
 * slots still resolve for in-flight users.
 */
export const SHARED_ONBOARDING_QUESTIONS: readonly SharedOnboardingQuestion[] = [
  ALL_SHARED_ONBOARDING_QUESTIONS.find((q) => q.id === "target_role")!,
  ALL_SHARED_ONBOARDING_QUESTIONS.find((q) => q.id === "location_relocation")!,
]

/** ASKED-flow ids (length 2) — the positional walker (`resolveNext…`) advances over THESE. */
const QUESTION_IDS = SHARED_ONBOARDING_QUESTIONS.map((q) => q.id)
/** VALID ids (all 7) — every dropped slot must still resolve a prompt for in-flight users. */
const ALL_QUESTION_IDS = ALL_SHARED_ONBOARDING_QUESTIONS.map((q) => q.id)
/** Map covers ALL 7 (built from the FULL set) so `getSharedOnboardingQuestion` never strands a slot. */
const QUESTION_BY_ID = new Map(ALL_SHARED_ONBOARDING_QUESTIONS.map((q) => [q.id, q]))
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

/**
 * Visible iMessage opener prefix.
 *
 * 2026-06-02 reword #2 (Adam): the candidate-emitted body is a START GREETING
 * ("Hi, WeKruit! <token>"). The trailing token is QR-campaign TRACKING, not a
 * verification code — the prior "my verification code is" framing both read wrong to
 * the user AND confused the LLM into treating it as a login step. The opener must look
 * like the candidate simply saying hi. Two OLD phrasings are kept ONLY as back-compat
 * parse forms — QR codes already printed/in the wild still emit them, so inbound
 * resolution MUST keep accepting both:
 *   - "Hi, WeKruit, my verification code is <token>" (2026-06-02 reword #1)
 *   - "Hello, WeKruit! <token>"                      (original 2026-05-19 form)
 *
 * `HI_WEKRUIT_OPENER_PREFIX` is what we BUILD today. The other two prefixes are retained
 * for back-compat (parser + LLM sanitizer) and still exported under their historical
 * names so downstream imports do not churn.
 */
export const HI_WEKRUIT_OPENER_PREFIX = "Hi, WeKruit!"
/** Back-compat (2026-06-02 reword #1). No longer BUILT; still parsed + sanitized. */
export const VERIFICATION_CODE_OPENER_PREFIX = "Hi, WeKruit, my verification code is"
/** Legacy opener prefix (Adam 2026-05-19 + user_id bind 2026-05-20). Back-compat only. */
export const HELLO_WEKRUIT_OPENER_PREFIX = "Hello, WeKruit!"

/** New (built) form: "Hi, WeKruit! <token>". Token = QR campaign tracking id. */
const HI_WEKRUIT_OPENER_RE =
  /^hi,?\s*wekruit!?\s*([a-z0-9][a-z0-9_-]{7,127})?\s*$/i
/** Back-compat form: "Hi, WeKruit, my verification code is <token>". */
const VERIFICATION_CODE_OPENER_RE =
  /^hi,?\s*wekruit,?\s*my\s+verification\s+code\s+is\s*:?\s*([a-z0-9][a-z0-9_-]{7,127})?\s*$/i
/** Legacy form: "Hello, WeKruit! <token>". Back-compat — in-flight QR links still emit this. */
const HELLO_WEKRUIT_OPENER_RE =
  /^hello,?\s*wekruit!?\s*([a-z0-9][a-z0-9_-]{7,127})?\s*$/i
// Prescreen job opener. Accepts BOTH forms (2026-06-13):
//   - JOB-ONLY (NEW): "WeKruit_<jobId>_Job" — no uid (phone-is-auth identity).
//   - JOB+UID (LEGACY, back-compat for in-flight tokens): "WeKruit_<jobId>_<uid>_Job".
// jobId is `[a-z0-9-]+` (no underscores — normalizeCompanyName collapses all
// non-alnum to `-`), so the optional uid segment is unambiguous.
const WEKRUIT_JOB_OPENER_RE =
  /(?:^|\s)wekruit_([a-z0-9][a-z0-9-]{1,160})(?:_([a-z0-9][a-z0-9_-]{7,127}))?_job(?:\s|$)/i

/**
 * LinkedIn one-tap re-entry marker (2026-06-03). After the candidate connects
 * LinkedIn on the candidate-domain page, the page reroutes back to iMessage
 * with the body "I've done LinkedIn submission <token>" and the candidate taps
 * Send. The trailing token is the single-use CONNECT token (maps token ->
 * userId server-side via verifyLinkedinConnectToken), NOT a candidateId — so it
 * is parsed SEPARATELY from `parseHelloWekruitOpener` (which returns a
 * candidateId). Inbound resolution stays phone-keyed; this marker only signals
 * "candidate is back in-thread after connecting LinkedIn" (a kickoff/greeting,
 * never a slot answer). The token must be STRIPPED before any LLM sees it.
 */
export const LINKEDIN_DONE_OPENER_PREFIX = "I've done LinkedIn submission"
const LINKEDIN_DONE_OPENER_RE =
  /^i'?ve\s+done\s+linkedin\s+submission\s*:?\s*([a-z0-9][a-z0-9_-]{7,127})?\s*$/i

/** Build the sms: reroute body the connect page sends after LinkedIn connect. */
export function buildLinkedinDoneOpenerBody(token: string): string {
  const t = token.trim()
  return t ? `${LINKEDIN_DONE_OPENER_PREFIX} ${t}` : LINKEDIN_DONE_OPENER_PREFIX
}

/** Canonical candidate-domain base for the LinkedIn one-tap connect page (C-end only).
 *  Apex wekruit.com serves the SAME pa-landing SPA (candidate./pa. are aliases) — Adam 2026-06-03:
 *  candidate-facing links use the apex, not the candidate. subdomain. */
export const CONNECT_LINKEDIN_LINK_BASE = "https://wekruit.com/connect-linkedin"

/**
 * Pure builder for the LinkedIn one-tap connect link the thin agent can utter
 * as a bubble. The page reads `?token=` and resolves it to the user server-side.
 * Exposed here (and re-exported from the barrel) so a future deterministic thin
 * step can emit the link without this branch touching agent.ts/prompt.ts.
 */
export function buildConnectLinkedinUrl(token: string): string {
  const t = token.trim()
  return t ? `${CONNECT_LINKEDIN_LINK_BASE}?token=${encodeURIComponent(t)}` : CONNECT_LINKEDIN_LINK_BASE
}

/** Canonical candidate-domain login surface (C-end only). The "Continue with Google" CTA lives here.
 *  Apex wekruit.com = same pa-landing SPA (Adam 2026-06-03 — apex over candidate. subdomain). */
export const CONNECT_GMAIL_LINK_BASE = "https://wekruit.com/login"

/**
 * WS-3(b) pure builder for the connect-Gmail nudge link the thin agent can utter
 * as a bubble. Points at the existing candidate login surface ("Continue with
 * Google"); no new auth flow. Sibling of buildConnectLinkedinUrl; re-exported
 * from the barrel so a deterministic thin step can emit the link without this
 * branch touching agent.ts/prompt.ts.
 */
export function buildConnectGmailUrl(): string {
  return CONNECT_GMAIL_LINK_BASE
}

/**
 * Parse the LinkedIn-done re-entry marker; returns the CONNECT token (NOT a
 * candidateId) when present. Returns `{ token: "" }` when the bare phrase is
 * sent with no token. Returns `null` when the text isn't this marker at all.
 */
export function parseLinkedinDoneOpener(value: string): { token: string } | null {
  const match = value.trim().match(LINKEDIN_DONE_OPENER_RE)
  if (!match) return null
  return { token: match[1]?.trim() ?? "" }
}

/** Build the sms: deep-link body candidates send to bind phone → pa-users/{candidateId}. */
export function buildHelloWekruitOpenerBody(candidateId: string): string {
  const id = candidateId.trim()
  if (!id) return HI_WEKRUIT_OPENER_PREFIX
  return `${HI_WEKRUIT_OPENER_PREFIX} ${id}`
}

/**
 * Parse inbound opener; returns candidateId when the suffix is present. Accepts the
 * new verification-code phrasing AND the legacy "Hello, WeKruit!" phrasing (back-compat
 * for QR codes already in the wild), plus the "WeKruit_<jobId>_<userId>_Job" job token.
 */
export function parseHelloWekruitOpener(value: string): { candidateId: string } | null {
  const trimmed = value.trim()
  const jobMatch = trimmed.match(WEKRUIT_JOB_OPENER_RE)
  if (jobMatch?.[2]) return { candidateId: jobMatch[2].trim() }
  const match =
    trimmed.match(HI_WEKRUIT_OPENER_RE) ??
    trimmed.match(VERIFICATION_CODE_OPENER_RE) ??
    trimmed.match(HELLO_WEKRUIT_OPENER_RE)
  if (!match) return null
  const candidateId = match[1]?.trim()
  return candidateId ? { candidateId } : null
}

/**
 * True when the text is a prescreen job opener of EITHER form — JOB-ONLY
 * `WeKruit_<jobId>_Job` (2026-06-13, phone-is-auth) or legacy
 * `WeKruit_<jobId>_<uid>_Job`. The job-only form carries no uid, so
 * `parseHelloWekruitOpener` (which returns a candidateId) returns null for it;
 * this predicate exists so kickoff classification still recognizes it.
 */
export function isWekruitJobOpener(value: string): boolean {
  return WEKRUIT_JOB_OPENER_RE.test(value.trim())
}

export function isSharedOnboardingGreetingOrKickoff(value: string): boolean {
  if (parseHelloWekruitOpener(value)) return true
  if (isWekruitJobOpener(value)) return true
  if (parseLinkedinDoneOpener(value)) return true
  const normalized = normalizeControlText(value)
  if (!normalized) return true
  if (normalized === "pa reset") return true
  // LinkedIn one-tap re-entry marker, normalized: "i ve done linkedin submission <token>".
  if (/^i ?ve done linkedin submission(?: [a-z0-9_-]+)?$/.test(normalized)) return true
  if (/^wekruit\s+(?:candidate\s+hi|laid\s+off|rain\s+software\s+engineer)/i.test(normalized)) return true
  if (/^hello wekruit(?: [a-z0-9_-]+)?$/.test(normalized)) return true
  // New verification-code opener phrasing, normalized: "hi wekruit my verification code is <token>".
  if (/^hi wekruit my verification code is(?: [a-z0-9_-]+)?$/.test(normalized)) return true
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
  if (questionId === "target_role") {
    return ["software_engineering", "product_management", "data_analytics", "design", "marketing", "sales", "same_lane", "open"]
  }
  if (questionId === "industry_interest") {
    return ["financial_technology", "artificial_intelligence", "crypto_web3_blockchain", "software_saas", "healthcare", "developer_tools", "open"]
  }
  if (questionId === "location_relocation") {
    return ["remote", "onsite", "hybrid", "new_york", "san_francisco", "seattle", "relocation_open", "no_relocation"]
  }
  if (questionId === "seniority_comp") {
    return ["internship", "full_time", "entry", "junior", "mid", "senior", "salary_target", "negotiable", "firm"]
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
  if (questionId === "target_role") {
    return [
      { reply: "staying in software engineering", value: "software engineering", confidence: 0.95 },
      { reply: "I'm a SWE but want to move into product management", value: "product management", confidence: 0.95 },
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
  if (questionId === "seniority_comp") {
    return [
      { reply: "full-time mid-level, aiming for ~160k but flexible", value: "full-time mid-level, ~160k target, flexible", confidence: 0.95 },
      { reply: "summer internship, 40/hr is firm for me", value: "internship, 40/hr, firm", confidence: 0.95 },
    ]
  }
  return [
    { reply: "nothing else, I can start quickly", value: "nothing else, can start quickly", confidence: 0.9 },
    { reply: "I need sponsorship and want backend-heavy work", value: "needs sponsorship, backend-heavy work", confidence: 0.95 },
  ]
}

export async function judgeSharedOnboardingAnswer(
  args: SharedOnboardingAnswerJudgeArgs,
): Promise<JudgeResult<string>> {
  // No-regex (2026-05-30): the bloom-filter accept-shortcut was the last
  // regex in this path. Answer acceptance is now LLM-only (GuidedOpenJudge),
  // with `failOpenOnLlmError` accepting any substantive reply when the LLM is
  // unavailable so the FSM never stalls re-asking a slot.
  const answer = args.answer.trim()
  if (isSharedOnboardingGreetingOrKickoff(answer)) {
    return { accept: false, reason: "irrelevant" }
  }
  const question = getSharedOnboardingQuestion(args.questionId)
  const judge = new GuidedOpenJudge<string>({
    questionLabel: question.label,
    hints: sharedJudgeHints(args.questionId),
    examples: sharedJudgeExamples(args.questionId),
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
    // LEGACY website-start opener (dead on the thin path, which uses its own PART-2 pitch). The
    // legacy deterministic flow walks the FULL set from main_goal, so the opener leads with it.
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
    // LEGACY post-prescreen opener (dead on the thin path). Leads with main_goal like the legacy flow.
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
    // US-only scope stated ON the question (Adam 2026-05-30): WeKruit operates only in the US, so the
    // location ASK itself must say so — don't make the candidate volunteer a city we can't serve.
    return `${lead}We're US-only right now — where in the US should I look: specific cities, remote within the US, onsite, or open to relocating?`
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

/**
 * LEGACY positional walker — traverses the FULL 7-slot set. This is shared by the legacy
 * deterministic onboarding path (index.ts) which still walks all 7 questions. The thin path does
 * NOT route its asked-flow completion through this; the thin trim is driven by the ASKED
 * `DEFAULT_ONBOARDING_SLOTS` in the FSM (onboarding-fsm.ts / process-tools.ts) and the thin
 * next-asked-slot in mode-selector. Keeping this on the FULL set preserves legacy behavior +
 * the regression chain. (For thin's ASKED next-slot, see `resolveNextAskedSharedOnboardingQuestionId`.)
 */
export function resolveNextSharedOnboardingQuestionId(id: SharedOnboardingQuestionId): {
  nextQuestionId: SharedOnboardingQuestionId | null
  completed: boolean
  shouldRecommend: boolean
} {
  const index = ALL_QUESTION_IDS.indexOf(id)
  const nextQuestionId = index >= 0 ? ALL_QUESTION_IDS[index + 1] ?? null : ALL_QUESTION_IDS[0]
  return {
    nextQuestionId,
    completed: nextQuestionId === null,
    shouldRecommend: nextQuestionId === null,
  }
}

/**
 * THIN-path positional walker — traverses ONLY the trimmed ASKED set (target_role ->
 * location_relocation -> complete). Used by the thin mode-selector to compute the next ASKED
 * question to display, so it agrees with the FSM completion (which keys off the same ASKED
 * `SHARED_ONBOARDING_QUESTIONS`). A stored id that is NOT in the ASKED set (an in-flight user on a
 * now-dropped slot) resolves to the FIRST asked slot — the in-flight rescue, never a stall.
 */
export function resolveNextAskedSharedOnboardingQuestionId(id: SharedOnboardingQuestionId): {
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
 * THIN-path TAG-AWARE walker (2026-06-04 #1 re-ask fix). Like
 * {@link resolveNextAskedSharedOnboardingQuestionId} but over the TRIMMED ASKED set
 * AND it SKIPS any slot already satisfied by `pa-users.tags` / `statedPreferences`
 * (via {@link isSharedOnboardingSlotSatisfied}). This is the thin counterpart of the
 * legacy {@link resolveNextMissingSharedOnboardingQuestionId} — the thin picker
 * (mode-selector) calls THIS so it never re-asks an axis whose canonical tag is
 * already present (e.g. a résumé-enriched candidate with `targetRoleFunction` set
 * being asked "what kind of role" again).
 *
 * Walk semantics mirror the positional resolver: advance from `fromId`'s position in
 * the ASKED set, returning the first FORWARD slot that is NOT tag-satisfied; if every
 * forward slot is satisfied → `{ nextQuestionId: null, completed: true }`. A stored id
 * not in the ASKED set (in-flight on a dropped slot) starts the scan from the head of
 * the ASKED set so it never strands. NO regex — pure presence checks on validated
 * canonical enums.
 */
export function resolveNextAskedMissingSharedOnboardingQuestionId(
  fromId: SharedOnboardingQuestionId,
  tags: Record<string, unknown> | null | undefined,
  statedPreferences: Record<string, unknown> | null | undefined,
): { nextQuestionId: SharedOnboardingQuestionId | null; completed: boolean; shouldRecommend: boolean } {
  const index = QUESTION_IDS.indexOf(fromId)
  // In-flight/unknown id → scan the whole ASKED set from the head (start at -1 + 1 = 0).
  const startIdx = index >= 0 ? index : -1
  for (let i = startIdx + 1; i < QUESTION_IDS.length; i++) {
    const candidate = QUESTION_IDS[i]!
    if (!isSharedOnboardingSlotSatisfied(candidate, tags, statedPreferences)) {
      return { nextQuestionId: candidate, completed: false, shouldRecommend: false }
    }
  }
  return { nextQuestionId: null, completed: true, shouldRecommend: true }
}

/**
 * QA 2026-05-28 (#3) — which shared-onboarding slots are already satisfied by the
 * unified user tags / statedPreferences. The extract-first capture (forceTrigger
 * extractor on every onboarding turn) can fill `industrySector` + `targetLocations`
 * from an out-of-slot message; only those two axes are emittable by the chat
 * extractor (conversation-extractor.ts tagPatch). main_goal / culture_stage /
 * special_context are onboarding-specific concepts the extractor can't produce, so
 * they're never auto-satisfied (always asked in order).
 *
 * 2026-06-04 (#1 re-ask fix) — `target_role` is ALSO tag-satisfiable. The matcher's
 * sole role axis is `tags.targetRoleFunction[]` (D1, ROLE_FUNCTION_VOCAB), and that
 * axis is filled by the résumé parse (`mergeUserTags`) and by the
 * `record_onboarding_answer` extractor (validateOnboardingCanonicalTags). So when a
 * candidate's enriched profile already carries `targetRoleFunction`, re-asking "what
 * kind of role do you want" is redundant — the axis the question exists to capture is
 * already present. Treat the slot as satisfied off the canonical tag (NO regex — pure
 * presence check over the validated closed enum). `statedPreferences.targetRoleFunction`
 * is the legacy mirror some paths still write, kept as a fallback.
 */
export function isSharedOnboardingSlotSatisfied(
  slot: SharedOnboardingQuestionId,
  tags: Record<string, unknown> | null | undefined,
  statedPreferences: Record<string, unknown> | null | undefined,
): boolean {
  const t = tags ?? {}
  const sp = statedPreferences ?? {}
  const nonEmptyArr = (v: unknown): boolean => Array.isArray(v) && v.length > 0
  if (slot === "target_role") {
    return nonEmptyArr(t.targetRoleFunction) || nonEmptyArr(sp.targetRoleFunction)
  }
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
  // LEGACY (dead on the thin path — only the legacy deterministic onboarding turn in
  // index.ts calls this). It still walks the FULL 7-slot set so legacy semantics are
  // unchanged; the thin trim lives in the ASKED `QUESTION_IDS` used by the positional
  // resolver below.
  const startIdx = ALL_QUESTION_IDS.indexOf(fromId)
  for (let i = startIdx + 1; i < ALL_QUESTION_IDS.length; i++) {
    const candidate = ALL_QUESTION_IDS[i]!
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
      // LEGACY website-start seeder (dead on the thin path; the thin cold start uses
      // mode-selector's own bootstrapOnboarding, seeded to the first ASKED slot). The legacy
      // deterministic onboarding path still walks the FULL 7-slot set from main_goal.
      currentQuestionId: "main_goal",
    },
    sharedOnboarding: {
      source,
      status: "active",
      startedAt: nowIso,
      updatedAt: nowIso,
      currentQuestionId: "main_goal",
      // FULL ordered ids for the legacy walker (this seeder is the legacy path).
      questionOrder: ALL_QUESTION_IDS,
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

function hasStringList(value: unknown): boolean {
  return Array.isArray(value) && value.some((item) => typeof item === "string" && item.trim().length > 0)
}

function hasNoLocationRestrictionSignal(normalized: string): boolean {
  return [
    "open to anything",
    "open to anywhere",
    "open to any location",
    "anywhere",
    "wherever",
    "no preference",
  ].some((phrase) => normalized.includes(phrase))
}

function hasUsCountrySignal(normalized: string): boolean {
  const tokens = normalized.split(" ").filter(Boolean)
  return normalized.includes("united states") ||
    tokens.includes("usa") ||
    tokens.includes("states") ||
    tokens.some((token, index) => token === "u" && tokens[index + 1] === "s")
}

function hasSponsorshipNeedSignal(normalized: string): boolean {
  const compact = normalized.replace(/\s+/g, "")
  const hasNegative =
    normalized.includes("no sponsorship") ||
    normalized.includes("do not need sponsorship") ||
    normalized.includes("dont need sponsorship") ||
    normalized.includes("don t need sponsorship") ||
    normalized.includes("no visa sponsorship")
  if (hasNegative) return false
  return compact.includes("h1b") ||
    normalized.includes("sponsorship") ||
    normalized.includes("need sponsor") ||
    normalized.includes("visa sponsor")
}

function parseSalaryFloorUsd(normalized: string): number | undefined {
  const hasFloorSignal = [
    "at least",
    "minimum",
    "min ",
    "below that",
    "below is a no",
    "salary floor",
  ].some((phrase) => normalized.includes(phrase))
  if (!hasFloorSignal) return undefined

  for (const token of normalized.split(" ")) {
    const rawNumber = token.endsWith("k") ? token.slice(0, -1) : token
    const value = Number(rawNumber)
    if (!Number.isFinite(value) || value <= 0) continue
    const salary = token.endsWith("k") ? value * 1000 : value
    if (salary >= 30000 && salary <= 1000000) return Math.floor(salary)
  }
  return undefined
}

function applyMatcherCriticalAnswerFallbacks(
  questionId: SharedOnboardingQuestionId,
  answer: string,
  tags: PartialUserTags,
): void {
  const normalized = normalizeControlText(answer)

  if (questionId === "location_relocation") {
    if (!hasStringList(tags.targetLocations) && hasNoLocationRestrictionSignal(normalized)) {
      tags.targetLocations = ["anywhere"]
    }
    if (!hasStringList(tags.targetCountry)) {
      const countries: string[] = []
      if (hasUsCountrySignal(normalized)) countries.push("usa")
      if (hasNoLocationRestrictionSignal(normalized) && !countries.includes("anywhere")) {
        countries.push("anywhere")
      }
      if (countries.length > 0) tags.targetCountry = countries
    }
  }

  if (questionId === "special_context") {
    if (!(tags as { visaStatus?: unknown }).visaStatus && hasSponsorshipNeedSignal(normalized)) {
      ;(tags as PartialUserTags & { visaStatus?: string }).visaStatus = "sponsor_needed"
      const existing = Array.isArray(tags.targetCompanyTags) ? tags.targetCompanyTags : []
      if (!existing.includes("visa_context")) tags.targetCompanyTags = [...existing, "visa_context"]
    }
    if (typeof tags.minSalary !== "number") {
      const salary = parseSalaryFloorUsd(normalized)
      if (salary !== undefined) tags.minSalary = salary
    }
  }
}

export function currentSharedOnboardingQuestionId(user: unknown): SharedOnboardingQuestionId {
  // Returns the stored slot when present (ANY valid id, incl. now-dropped slots — the FULL map
  // still resolves them, so an in-flight user is never stranded). The cold/unknown fallback stays
  // main_goal for the LEGACY path; the THIN path resolves cold start via mode-selector's
  // FIRST_ASKED_SLOT and rescues an in-flight dropped slot onto the ASKED set (rescueOnboardingSlot).
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

/**
 * Project a shared-onboarding answer into a memory fact + canonical tags +
 * stated-preferences bookkeeping.
 *
 * The LLM-driven extraction (`llmTags`), validated against the
 * `@wekruit/shared-tags` closed enums by {@link validateOnboardingCanonicalTags}
 * (off-vocab values dropped), remains the source for normal tag extraction.
 * This projector also carries a narrow set of matcher-critical literal
 * fallbacks for fail-open turns where the model returned no structured tags:
 * the explicit "anywhere" location bypass, sponsorship-needed, and salary-floor
 * signals. The deterministic FSM still owns slot ORDER; this projector carries
 * the validated picks plus the durable memoryFact / statedPreferences / evidence
 * the downstream relies on.
 *
 * `llmTags` is the agent's STRUCTURED canonical proposal for THIS answer (any
 * subset of axes the answer supports, multi-value = OR). When omitted (e.g. a
 * fail-open path with no model output), only the matcher-critical literal
 * fallbacks above can populate tags; the unified-tags extractor
 * (conversation-extractor) remains the broad semantic tag writer and the slot
 * still advances on the raw answer.
 */
export function projectSharedOnboardingAnswer(
  questionId: SharedOnboardingQuestionId,
  answer: string,
  llmTags?: OnboardingCanonicalTagInput | null,
): {
  memoryFact: string
  tags: PartialUserTags
  statedPreferences: Record<string, unknown>
  evidence: Record<string, unknown>
} {
  const trimmed = answer.trim()
  const question = getSharedOnboardingQuestion(questionId)
  const tags = validateOnboardingCanonicalTags(llmTags)
  applyMatcherCriticalAnswerFallbacks(questionId, trimmed, tags)
  const statedPreferences: Record<string, unknown> = {}
  const evidence: Record<string, unknown> = { questionId, answer: trimmed }

  // Mirror the validated canonical tags into statedPreferences (the legacy
  // bag downstream readers still consult).
  if (tags.targetRoleFunction) statedPreferences.targetRoleFunction = tags.targetRoleFunction
  if (tags.negativeRoleFunction) statedPreferences.negativeRoleFunction = tags.negativeRoleFunction
  if (tags.industrySector) statedPreferences.industrySector = tags.industrySector
  if (tags.negativeIndustrySector) statedPreferences.negativeIndustrySector = tags.negativeIndustrySector
  if (tags.companySize) statedPreferences.companySize = tags.companySize
  if (tags.targetLocations) statedPreferences.targetLocations = tags.targetLocations
  if (tags.targetCountry) statedPreferences.targetCountry = tags.targetCountry
  if (tags.targetJobType) statedPreferences.targetJobType = tags.targetJobType
  if (tags.careerStage) statedPreferences.careerStage = tags.careerStage
  if ((tags as { visaStatus?: unknown }).visaStatus) {
    statedPreferences.visaStatus = (tags as { visaStatus?: unknown }).visaStatus
  }
  if (typeof tags.minSalary === "number") statedPreferences.minSalary = tags.minSalary

  // Q5 keeps the raw free-text around so downstream readers and HITL can see
  // the candidate's verbatim non-negotiables.
  if (questionId === "special_context") {
    statedPreferences.specialContext = trimmed
  }

  return {
    memoryFact: `Candidate onboarding answer (${question.label}): ${trimmed}`,
    tags,
    statedPreferences,
    evidence,
  }
}
