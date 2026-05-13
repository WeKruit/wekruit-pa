/**
 * v1.9 Phase 85 — PiiConfirmPipeline.
 *
 * Runs AFTER `PreScreenPipeline` reaches PASS terminal (and AFTER the Level
 * 1 reveal SMS). Collects 3 contact-PII fields from the candidate via the
 * existing `OnboardingPipeline` infrastructure (iter34 P1):
 *
 *   1. legalName — non-empty
 *   2. email     — RFC-5322-ish regex
 *   3. phone     — E.164 (+digits, 8-15 total)
 *
 * Writes to `pa-users/{uid}.contactPII = {legalName, email, phone,
 * consentedAt, source}` via injected hook + audit event by caller.
 *
 * Skip-if-present is enforced by the caller (CF layer) BEFORE building this
 * pipeline — pipeline itself is stateless about prior consent.
 *
 * PS note: libphonenumber-js is NOT yet in monorepo deps; v1.9 ships with
 * regex validation. Upgrade to libphonenumber-js in v2.0 for international
 * formatting.
 */

import { OnboardingPipeline } from "../onboarding/pipeline.js"
import type {
  PipelineStateProvider,
} from "../onboarding/pipeline.js"
import {
  makeQuestion,
  type AcceptedCtx,
  type BilingualText,
  type JudgeCtx,
  type Lang,
  type Question,
  type RephraseArgs,
} from "../onboarding/question.js"

// ────────────────────────────────────────────────────────────────────────────
// Pure validators (exported for tests)
// ────────────────────────────────────────────────────────────────────────────

const EMAIL_REGEX = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i

export function validateEmail(raw: string): { ok: boolean; normalized?: string } {
  const trimmed = raw.trim().toLowerCase()
  if (!EMAIL_REGEX.test(trimmed)) return { ok: false }
  if (trimmed.length > 200) return { ok: false }
  return { ok: true, normalized: trimmed }
}

const PHONE_DIGIT_RE = /\d/g

export function validatePhone(raw: string): { ok: boolean; normalized?: string } {
  const digits = (raw.match(PHONE_DIGIT_RE) ?? []).join("")
  if (digits.length < 8 || digits.length > 15) return { ok: false }
  const e164 = raw.trim().startsWith("+") ? `+${digits}` : `+${digits}`
  return { ok: true, normalized: e164 }
}

export function validateLegalName(raw: string): { ok: boolean; normalized?: string } {
  const trimmed = raw.trim().replace(/\s+/g, " ")
  if (trimmed.length < 2 || trimmed.length > 120) return { ok: false }
  // Must contain at least one letter (not all numbers / symbols).
  if (!/[A-Za-z一-鿿]/.test(trimmed)) return { ok: false }
  return { ok: true, normalized: trimmed }
}

// ────────────────────────────────────────────────────────────────────────────
// v1.9 Level 1 onboarding validators (yoe / visa / location / salary /
// industry / company_size). All write to pa-users.tags via mergeUserTags
// or direct merge after PII postCollect.
// ────────────────────────────────────────────────────────────────────────────

export function validateYoe(raw: string): { ok: boolean; lowYears?: number; highYears?: number } {
  const trimmed = raw.trim().toLowerCase()
  // Common patterns: "5", "5 years", "3-5", "3 to 5", "<1", "10+", "five"
  const wordNums: Record<string, number> = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  }
  const wordMatch = Object.entries(wordNums).find(([w]) => new RegExp(`\\b${w}\\b`).test(trimmed))
  if (wordMatch) {
    return { ok: true, lowYears: wordMatch[1], highYears: wordMatch[1] }
  }
  const rangeMatch = trimmed.match(/(\d+(?:\.\d+)?)\s*(?:-|to|–|~)\s*(\d+(?:\.\d+)?)/)
  if (rangeMatch) {
    const lo = parseFloat(rangeMatch[1])
    const hi = parseFloat(rangeMatch[2])
    if (lo >= 0 && hi >= lo && hi <= 60) {
      return { ok: true, lowYears: Math.round(lo), highYears: Math.round(hi) }
    }
  }
  const plusMatch = trimmed.match(/(\d+)\s*\+/)
  if (plusMatch) {
    const lo = parseInt(plusMatch[1], 10)
    return { ok: true, lowYears: lo, highYears: Math.min(lo + 5, 60) }
  }
  const lessThan = trimmed.match(/<\s*(\d+)/)
  if (lessThan) {
    return { ok: true, lowYears: 0, highYears: parseInt(lessThan[1], 10) }
  }
  const single = trimmed.match(/(\d+(?:\.\d+)?)/)
  if (single) {
    const n = parseFloat(single[1])
    if (n >= 0 && n <= 60) return { ok: true, lowYears: Math.round(n), highYears: Math.round(n) }
  }
  return { ok: false }
}

const VISA_KEYWORDS: Record<string, "citizen" | "permanent_resident" | "sponsor_needed" | "other"> = {
  citizen: "citizen",
  "us citizen": "citizen",
  usc: "citizen",
  "green card": "permanent_resident",
  gc: "permanent_resident",
  pr: "permanent_resident",
  "permanent resident": "permanent_resident",
  lpr: "permanent_resident",
  h1b: "sponsor_needed",
  "h-1b": "sponsor_needed",
  h1: "sponsor_needed",
  opt: "sponsor_needed",
  cpt: "sponsor_needed",
  "stem opt": "sponsor_needed",
  "f-1": "sponsor_needed",
  f1: "sponsor_needed",
  "sponsorship needed": "sponsor_needed",
  "need sponsorship": "sponsor_needed",
  "require sponsorship": "sponsor_needed",
  o1: "sponsor_needed",
  "o-1": "sponsor_needed",
  tn: "sponsor_needed",
}

export function validateVisa(raw: string): {
  ok: boolean
  status?: "citizen" | "permanent_resident" | "sponsor_needed" | "other"
} {
  const lower = raw.trim().toLowerCase()
  for (const [kw, status] of Object.entries(VISA_KEYWORDS)) {
    if (lower.includes(kw)) return { ok: true, status }
  }
  if (lower.length > 0) return { ok: true, status: "other" }
  return { ok: false }
}

export function validateLocation(raw: string): { ok: boolean; normalized?: string[] } {
  const lower = raw.trim().toLowerCase()
  if (lower.length < 2 || lower.length > 200) return { ok: false }
  // Permissive — accept free text; downstream LLM canonicalize later.
  // Detect "remote", "anywhere", "open"
  if (/\b(remote|anywhere|open|any\s+location)\b/i.test(lower)) {
    return { ok: true, normalized: ["anywhere"] }
  }
  // Split common delimiters
  const parts = lower
    .split(/[;,/]|\sor\s|\sand\s/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 2)
  if (parts.length === 0) return { ok: false }
  return { ok: true, normalized: parts.slice(0, 5) }
}

export function validateSalaryRange(raw: string): { ok: boolean; minUsd?: number } {
  const lower = raw.trim().toLowerCase().replace(/[$,]/g, "")
  // Patterns: "120k", "120,000", "100k-150k", "100k to 150k", "min 100", "open"
  if (/\b(open|negotiable|flex|any|no\s+min)\b/i.test(lower)) {
    return { ok: true, minUsd: 0 }
  }
  // Take lowest number mentioned
  const matches = [...lower.matchAll(/(\d+(?:\.\d+)?)\s*(k|m)?/g)]
  if (matches.length === 0) return { ok: false }
  const nums = matches.map((m) => {
    let n = parseFloat(m[1])
    if (m[2] === "k") n *= 1000
    else if (m[2] === "m") n *= 1_000_000
    else if (n < 1000) n *= 1000 // bare "120" → 120k
    return n
  })
  const min = Math.min(...nums)
  if (min < 1000 || min > 10_000_000) return { ok: false }
  return { ok: true, minUsd: Math.round(min) }
}

export function validateIndustry(raw: string): { ok: boolean; normalized?: string[] } {
  const lower = raw.trim().toLowerCase()
  if (lower.length < 2 || lower.length > 200) return { ok: false }
  if (/\b(open|any|all|don'?t\s+care|no\s+pref)\b/i.test(lower)) {
    return { ok: true, normalized: ["open"] }
  }
  // Free text — split + lowercase + slug; LLM canonicalize downstream.
  const parts = lower
    .split(/[;,/]|\sor\s|\sand\s/)
    .map((p) => p.trim().replace(/\s+/g, "_"))
    .filter((p) => p.length >= 2)
  if (parts.length === 0) return { ok: false }
  return { ok: true, normalized: parts.slice(0, 5) }
}

const COMPANY_SIZE_KEYWORDS: Record<string, "seed" | "early_startup" | "scale_up" | "mid_market" | "enterprise" | "open"> = {
  seed: "seed",
  "pre-seed": "seed",
  series_a: "early_startup",
  "series a": "early_startup",
  "early stage": "early_startup",
  "small startup": "early_startup",
  startup: "early_startup",
  "series b": "scale_up",
  "series c": "scale_up",
  "scale up": "scale_up",
  scaleup: "scale_up",
  growth: "scale_up",
  midsize: "mid_market",
  "mid market": "mid_market",
  "mid-market": "mid_market",
  midmarket: "mid_market",
  enterprise: "enterprise",
  faang: "enterprise",
  "big tech": "enterprise",
  "public company": "enterprise",
  ipo: "enterprise",
  fortune_500: "enterprise",
  "fortune 500": "enterprise",
  any: "open",
  open: "open",
  flexible: "open",
}

export function validateCompanySize(raw: string): {
  ok: boolean
  size?: "seed" | "early_startup" | "scale_up" | "mid_market" | "enterprise" | "open"
} {
  const lower = raw.trim().toLowerCase()
  for (const [kw, size] of Object.entries(COMPANY_SIZE_KEYWORDS)) {
    if (lower.includes(kw)) return { ok: true, size }
  }
  // Headcount fallback: "200 people", "50 employees", "10000+"
  const hcMatch = lower.match(/(\d+)\s*(?:\+)?\s*(?:people|employees|headcount|emp)/)
  if (hcMatch) {
    const n = parseInt(hcMatch[1], 10)
    if (n < 50) return { ok: true, size: "early_startup" }
    if (n < 500) return { ok: true, size: "scale_up" }
    if (n < 5000) return { ok: true, size: "mid_market" }
    return { ok: true, size: "enterprise" }
  }
  if (lower.length > 0) return { ok: true, size: "open" }
  return { ok: false }
}

// ────────────────────────────────────────────────────────────────────────────
// Judges
// ────────────────────────────────────────────────────────────────────────────

import type { Judge, JudgeResult, Rephraser } from "../onboarding/question.js"

class LegalNameJudge implements Judge<string> {
  readonly kind = "pii-legal-name"
  async judge(reply: string, _lang: Lang, _ctx: JudgeCtx): Promise<JudgeResult<string>> {
    const v = validateLegalName(reply)
    if (v.ok) {
      return { accept: true, value: v.normalized! }
    }
    return { accept: false, reason: "unclear" }
  }
}

class EmailFormatJudge implements Judge<string> {
  readonly kind = "pii-email-format"
  async judge(reply: string, _lang: Lang, _ctx: JudgeCtx): Promise<JudgeResult<string>> {
    const v = validateEmail(reply)
    if (v.ok) {
      return { accept: true, value: v.normalized! }
    }
    return { accept: false, reason: "irrelevant" }
  }
}

class PhoneJudge implements Judge<string> {
  readonly kind = "pii-phone"
  async judge(reply: string, _lang: Lang, _ctx: JudgeCtx): Promise<JudgeResult<string>> {
    const v = validatePhone(reply)
    if (v.ok) {
      return { accept: true, value: v.normalized! }
    }
    return { accept: false, reason: "irrelevant" }
  }
}

// ── Level 1 judges ──────────────────────────────────────────────────────

class YoeJudge implements Judge<{ lowYears: number; highYears: number }> {
  readonly kind = "level1-yoe"
  async judge(reply: string, _lang: Lang, _ctx: JudgeCtx) {
    const v = validateYoe(reply)
    if (v.ok) return { accept: true as const, value: { lowYears: v.lowYears!, highYears: v.highYears! } }
    return { accept: false as const, reason: "unclear" as const }
  }
}
class VisaJudge implements Judge<string> {
  readonly kind = "level1-visa"
  async judge(reply: string, _lang: Lang, _ctx: JudgeCtx) {
    const v = validateVisa(reply)
    if (v.ok) return { accept: true as const, value: v.status! }
    return { accept: false as const, reason: "unclear" as const }
  }
}
class LocationJudge implements Judge<string[]> {
  readonly kind = "level1-location"
  async judge(reply: string, _lang: Lang, _ctx: JudgeCtx) {
    const v = validateLocation(reply)
    if (v.ok) return { accept: true as const, value: v.normalized! }
    return { accept: false as const, reason: "unclear" as const }
  }
}
class SalaryJudge implements Judge<number> {
  readonly kind = "level1-salary"
  async judge(reply: string, _lang: Lang, _ctx: JudgeCtx) {
    const v = validateSalaryRange(reply)
    if (v.ok) return { accept: true as const, value: v.minUsd! }
    return { accept: false as const, reason: "irrelevant" as const }
  }
}
class IndustryJudge implements Judge<string[]> {
  readonly kind = "level1-industry"
  async judge(reply: string, _lang: Lang, _ctx: JudgeCtx) {
    const v = validateIndustry(reply)
    if (v.ok) return { accept: true as const, value: v.normalized! }
    return { accept: false as const, reason: "unclear" as const }
  }
}
class CompanySizeJudge implements Judge<string> {
  readonly kind = "level1-company-size"
  async judge(reply: string, _lang: Lang, _ctx: JudgeCtx) {
    const v = validateCompanySize(reply)
    if (v.ok) return { accept: true as const, value: v.size! }
    return { accept: false as const, reason: "unclear" as const }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Rephrasers — minimal static variants per Q
// ────────────────────────────────────────────────────────────────────────────

class StaticRephraser implements Rephraser {
  readonly kind = "pii-static-variants"
  constructor(private readonly variants: BilingualText[]) {}
  async rephrase({ attemptNum, lang }: RephraseArgs): Promise<string> {
    const idx = Math.min(attemptNum - 1, this.variants.length - 1)
    return this.variants[idx][lang]
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Prompts
// ────────────────────────────────────────────────────────────────────────────

// v1.9 hotfix — distinct copy per source. "pass" frames PII as
// employer-sharing. "fail" frames it as future-matching outreach.
const Q_LEGAL_NAME_PROMPT_PASS: BilingualText = {
  en: "Great — to share with the employer, can you confirm your legal full name?",
  zh: "好的 — 为了与招聘方分享, 请确认你的法定全名是?",
}
const Q_LEGAL_NAME_PROMPT_FAIL: BilingualText = {
  en: "Before you go — to keep you in the loop for better-aligned roles, what's your legal full name?",
  zh: "走之前 — 为了之后给你推更合适的机会, 请问你的法定全名是?",
}
const Q_LEGAL_NAME_PROMPT: BilingualText = Q_LEGAL_NAME_PROMPT_PASS
const Q_LEGAL_NAME_RETRIES: BilingualText[] = [
  {
    en: "Need a legal full name (first + last) — what should I send to the employer?",
    zh: "需要法定全名 (姓 + 名) — 我应该给招聘方什么?",
  },
  {
    en: "Just a name, please — e.g. 'Jane Doe' or '张三'.",
    zh: "只需要名字 — 例如 'Jane Doe' 或 '张三'.",
  },
]

const Q_EMAIL_PROMPT: BilingualText = {
  en: "What email should the employer use to reach you?",
  zh: "招聘方应该用哪个 email 联系你?",
}
const Q_EMAIL_RETRIES: BilingualText[] = [
  {
    en: "Looks like that wasn't a valid email — could you re-type it? (e.g. you@gmail.com)",
    zh: "好像不是有效的 email — 重新输入下? (例如 you@gmail.com)",
  },
  {
    en: "I need it in the form 'name@domain.com' — try again?",
    zh: "需要 'name@domain.com' 这种格式 — 再试一次?",
  },
]

const Q_PHONE_PROMPT: BilingualText = {
  en: "And the best phone number for next-step coordination?",
  zh: "另外, 下一步沟通用哪个电话最方便?",
}
const Q_PHONE_RETRIES: BilingualText[] = [
  {
    en: "Need 8-15 digits — country code is optional. Try again?",
    zh: "需要 8-15 位数字 — 国家码可选. 再试一次?",
  },
  {
    en: "E.g. +1 415 555 0123 or 13800138000.",
    zh: "例如 +1 415 555 0123 或 13800138000.",
  },
]

// ── Level 1 onboarding prompts ──────────────────────────────────────────

const Q_YOE_PROMPT: BilingualText = {
  en: "Now a few quick fit-questions for future role matches. Years of relevant work experience?",
  zh: "再问几个匹配相关的小问题. 你相关工作年限大概是?",
}
const Q_YOE_RETRIES: BilingualText[] = [
  { en: "Numeric, e.g. '3' or '3-5' or '<1' or '10+'.", zh: "请填数字, 例如 '3', '3-5', '<1', '10+'." },
]
const Q_VISA_PROMPT: BilingualText = {
  en: "Work-authorization status? (US citizen, green card, H1B / OPT / CPT, sponsorship needed, other)",
  zh: "你的工作授权状态? (美国公民 / 绿卡 / H1B / OPT / CPT / 需要 sponsor / 其他)",
}
const Q_VISA_RETRIES: BilingualText[] = [
  { en: "Pick one: citizen, GC, OPT/H1B (need sponsor), or other.", zh: "选一个: 公民 / 绿卡 / OPT/H1B / 其他." },
]
const Q_LOCATION_PROMPT: BilingualText = {
  en: "Preferred work location(s)? (city / region or 'remote' / 'anywhere')",
  zh: "你倾向的工作地点? (城市/区域, 或 'remote' / 'anywhere')",
}
const Q_LOCATION_RETRIES: BilingualText[] = [
  { en: "Comma-separated cities or 'remote'.", zh: "用逗号分隔城市, 或写 'remote'." },
]
const Q_SALARY_PROMPT: BilingualText = {
  en: "Minimum total compensation expectation? (e.g. '120k' or '$140-180k' or 'open')",
  zh: "期望的最低总薪资? (例如 '120k', '$140-180k', 或 'open')",
}
const Q_SALARY_RETRIES: BilingualText[] = [
  { en: "Numeric in USD, e.g. '120k' or 'open'.", zh: "美金数字, 例如 '120k' 或 'open'." },
]
const Q_INDUSTRY_PROMPT: BilingualText = {
  en: "Industries you're most interested in? (e.g. AI, fintech, healthtech, gaming — or 'open')",
  zh: "你最感兴趣的行业方向? (例如 AI / fintech / healthtech / gaming, 或 'open')",
}
const Q_INDUSTRY_RETRIES: BilingualText[] = [
  { en: "1-3 industries, comma-separated, or 'open'.", zh: "1-3 个行业, 逗号分隔, 或写 'open'." },
]
const Q_COMPANY_SIZE_PROMPT: BilingualText = {
  en: "Preferred company stage? (seed / early-startup / scale-up / mid-market / enterprise / open)",
  zh: "倾向的公司阶段? (种子 / 早期初创 / scale-up / 中型 / 大公司 / open)",
}
const Q_COMPANY_SIZE_RETRIES: BilingualText[] = [
  { en: "Pick one: seed, startup, scale-up, mid, enterprise, or open.", zh: "选一个: seed / startup / scale-up / mid / enterprise / open." },
]

// ────────────────────────────────────────────────────────────────────────────
// Pipeline factory
// ────────────────────────────────────────────────────────────────────────────

export interface Level1Answers {
  yoeRange?: [number, number]
  visaStatus?: "citizen" | "permanent_resident" | "sponsor_needed" | "other"
  targetLocations?: string[]
  minSalaryUsd?: number
  industrySector?: string[]
  companySize?: "seed" | "early_startup" | "scale_up" | "mid_market" | "enterprise" | "open"
}

export interface PiiConfirmAnswers {
  legalName: string
  email: string
  phone: string
  /** v1.9 Level 1 onboarding fields (present when includeLevel1=true). */
  level1?: Level1Answers
}

export interface PiiConfirmHooks {
  /**
   * Called when all 3 (or 9 with includeLevel1) fields are collected.
   * Caller persists to pa-users.{uid}.contactPII + pa-users.{uid}.tags
   * + writes audit event.
   */
  onAllCollected: (answers: PiiConfirmAnswers, ctx: AcceptedCtx) => Promise<void>
}

export type PiiSource = "pass" | "fail"

export interface PiiConfirmPipelineOpts {
  state: PipelineStateProvider
  hooks: PiiConfirmHooks
  /** Outbound emit (caller routes to sendImessage). */
  emit: (
    text: string,
    meta: { qId: string | null; kind: string }
  ) => Promise<void>
  log?: (event: string, payload: Record<string, unknown>) => void
  /**
   * Frames the PII ask copy. "pass" = "share with employer" framing.
   * "fail" = "keep you in the loop for better-aligned roles" framing.
   * Defaults to "pass" for backwards-compat with existing ApplyTrigger flow.
   */
  source?: PiiSource
  /**
   * v1.9 — when true, appends 6 Level 1 onboarding Qs (yoe / visa /
   * location / salary / industry / company_size) after the 3 PII Qs.
   * onAllCollected then receives answers.level1 with all 6 parsed.
   */
  includeLevel1?: boolean
}

/**
 * Build the 3-Q pipeline. Each Q is MUST_HAVE weight=1.0 (defaults). On the
 * last Q accept, the postCollect hook fires `hooks.onAllCollected`.
 */
export function createPiiConfirmPipeline(opts: PiiConfirmPipelineOpts): OnboardingPipeline {
  const source: PiiSource = opts.source ?? "pass"
  const legalNamePrompt = source === "fail" ? Q_LEGAL_NAME_PROMPT_FAIL : Q_LEGAL_NAME_PROMPT_PASS

  const qLegalName: Question<string> = makeQuestion<string>({
    id: "q_pii_legal_name",
    prompt: legalNamePrompt,
    judge: new LegalNameJudge(),
    rephraser: new StaticRephraser(Q_LEGAL_NAME_RETRIES),
    maxAttempts: 3,
  })
  const qEmail: Question<string> = makeQuestion<string>({
    id: "q_pii_email",
    prompt: Q_EMAIL_PROMPT,
    judge: new EmailFormatJudge(),
    rephraser: new StaticRephraser(Q_EMAIL_RETRIES),
    maxAttempts: 3,
  })
  const qPhone: Question<string> = makeQuestion<string>({
    id: "q_pii_phone",
    prompt: Q_PHONE_PROMPT,
    judge: new PhoneJudge(),
    rephraser: new StaticRephraser(Q_PHONE_RETRIES),
    maxAttempts: 3,
  })

  // v1.9 — Level 1 onboarding Qs (optional, appended after PII)
  const qYoe: Question<{ lowYears: number; highYears: number }> = makeQuestion({
    id: "q_l1_yoe",
    prompt: Q_YOE_PROMPT,
    judge: new YoeJudge(),
    rephraser: new StaticRephraser(Q_YOE_RETRIES),
    maxAttempts: 3,
  })
  const qVisa: Question<string> = makeQuestion<string>({
    id: "q_l1_visa",
    prompt: Q_VISA_PROMPT,
    judge: new VisaJudge(),
    rephraser: new StaticRephraser(Q_VISA_RETRIES),
    maxAttempts: 3,
  })
  const qLoc: Question<string[]> = makeQuestion<string[]>({
    id: "q_l1_location",
    prompt: Q_LOCATION_PROMPT,
    judge: new LocationJudge(),
    rephraser: new StaticRephraser(Q_LOCATION_RETRIES),
    maxAttempts: 3,
  })
  const qSalary: Question<number> = makeQuestion<number>({
    id: "q_l1_salary",
    prompt: Q_SALARY_PROMPT,
    judge: new SalaryJudge(),
    rephraser: new StaticRephraser(Q_SALARY_RETRIES),
    maxAttempts: 3,
  })
  const qIndustry: Question<string[]> = makeQuestion<string[]>({
    id: "q_l1_industry",
    prompt: Q_INDUSTRY_PROMPT,
    judge: new IndustryJudge(),
    rephraser: new StaticRephraser(Q_INDUSTRY_RETRIES),
    maxAttempts: 3,
  })
  const qCompanySize: Question<string> = makeQuestion<string>({
    id: "q_l1_company_size",
    prompt: Q_COMPANY_SIZE_PROMPT,
    judge: new CompanySizeJudge(),
    rephraser: new StaticRephraser(Q_COMPANY_SIZE_RETRIES),
    maxAttempts: 3,
  })

  const baseQs: Question<unknown>[] = [
    qLegalName as Question<unknown>,
    qEmail as Question<unknown>,
    qPhone as Question<unknown>,
  ]
  const allQs: Question<unknown>[] = opts.includeLevel1
    ? [
        ...baseQs,
        qYoe as Question<unknown>,
        qVisa as Question<unknown>,
        qLoc as Question<unknown>,
        qSalary as Question<unknown>,
        qIndustry as Question<unknown>,
        qCompanySize as Question<unknown>,
      ]
    : baseQs

  // Caller supplies `emit` — pipeline never sends directly. The CF wrapper
  // routes emitted text through sendImessage / sendMemoryReply.
  const completionMessage: BilingualText =
    source === "fail"
      ? {
          en: "Thanks — I'll text you when stronger matches come up.",
          zh: "收到 — 之后有更合适的我直接推给你.",
        }
      : {
          en: "Thanks — you're all set. The employer will follow up directly.",
          zh: "收到 — 已经记下了. 招聘方会直接联系你.",
        }
  return new OnboardingPipeline({
    questions: allQs,
    state: opts.state,
    haltMessageDefault: {
      en: "We'll come back to this later — please reach out to support if you need to update your contact info.",
      zh: "我们稍后再回来 — 如需更新联系信息, 请联系客服.",
    },
    emit: opts.emit,
    postCollect: async (collected: Record<string, unknown>, ctx: AcceptedCtx) => {
      const answers: PiiConfirmAnswers = {
        legalName: String(collected.q_pii_legal_name ?? ""),
        email: String(collected.q_pii_email ?? ""),
        phone: String(collected.q_pii_phone ?? ""),
      }
      if (opts.includeLevel1) {
        const yoe = collected.q_l1_yoe as { lowYears: number; highYears: number } | undefined
        answers.level1 = {
          yoeRange: yoe ? [yoe.lowYears, yoe.highYears] : undefined,
          visaStatus: collected.q_l1_visa as Level1Answers["visaStatus"],
          targetLocations: collected.q_l1_location as string[] | undefined,
          minSalaryUsd: collected.q_l1_salary as number | undefined,
          industrySector: collected.q_l1_industry as string[] | undefined,
          companySize: collected.q_l1_company_size as Level1Answers["companySize"],
        }
      }
      await opts.hooks.onAllCollected(answers, ctx)
    },
    completionMessage,
    log: opts.log,
  })
}
