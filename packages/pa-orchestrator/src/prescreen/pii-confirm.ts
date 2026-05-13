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

// ────────────────────────────────────────────────────────────────────────────
// Pipeline factory
// ────────────────────────────────────────────────────────────────────────────

export interface PiiConfirmAnswers {
  legalName: string
  email: string
  phone: string
}

export interface PiiConfirmHooks {
  /**
   * Called when all 3 fields are collected. Caller persists to
   * pa-users.{uid}.contactPII + writes audit event.
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
    questions: [qLegalName as Question<unknown>, qEmail as Question<unknown>, qPhone as Question<unknown>],
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
      await opts.hooks.onAllCollected(answers, ctx)
    },
    completionMessage,
    log: opts.log,
  })
}
