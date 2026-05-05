/**
 * EmailJudge — three-stage decision for q_email replies:
 *   1. Cheap regex check — clean valid email shape → accept immediately,
 *      skips LLM cost on the happy path (most users type a real email).
 *   2. LLM extract — when regex misses, ask extractEmailIntent (LLM)
 *      whether the reply contains a typo'd email, declined, or noise.
 *   3. Fallback irrelevant — LLM returned null / threw → re-ask via rephraser.
 *
 * Adam directive 2026-05-05 ("不只是 email, 包括所有一开始的 deterministic
 * 的 question 都需要加这个") — email Q has the same expect+rephrase contract
 * as the rest of the probe Qs.
 */
import type { Judge, JudgeCtx, JudgeResult, Lang } from "../question.js"

export type EmailIntentResult =
  | { intent: "provided"; email: string; confidence: number }
  | { intent: "typo"; original: string; suggestion: string }
  | { intent: "declined" }
  | { intent: "unclear"; clarifyingQuestion: string }

export type ExtractEmailIntentFn = (
  reply: string,
  lang: Lang
) => Promise<EmailIntentResult | null>

export interface EmailJudgeOpts {
  extractEmailIntent?: ExtractEmailIntentFn
  /** Min confidence to accept a regex+LLM "provided". Default 0.7. */
  confidenceThreshold?: number
}

/** Permissive RFC-5322-ish regex — good enough as a cheap pre-filter. */
const CHEAP_EMAIL_RE = /\b([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/i

export class EmailJudge implements Judge<string> {
  readonly kind = "email"

  constructor(private readonly opts: EmailJudgeOpts = {}) {}

  async judge(reply: string, lang: Lang, ctx: JudgeCtx): Promise<JudgeResult<string>> {
    // (1) Cheap regex — happy path. Most users type a real email; no LLM cost.
    const m = CHEAP_EMAIL_RE.exec(reply.trim())
    if (m && m[1]) {
      ctx.log?.("pa.onboarding.judge.email.regex_hit", {
        userId: ctx.userId,
        turnId: ctx.turnId,
      })
      return { accept: true, value: m[1].toLowerCase(), confidence: 1.0 }
    }

    // (2) LLM extract for typo / declined / unclear.
    if (!this.opts.extractEmailIntent) {
      return { accept: false, reason: "irrelevant" }
    }

    let intent: EmailIntentResult | null = null
    try {
      ctx.log?.("pa.onboarding.judge.email.llm_invoke", {
        userId: ctx.userId,
        turnId: ctx.turnId,
        replyLen: reply.length,
      })
      intent = await this.opts.extractEmailIntent(reply, lang)
    } catch (err) {
      ctx.log?.("pa.onboarding.judge.email.llm_error", {
        userId: ctx.userId,
        turnId: ctx.turnId,
        error: err instanceof Error ? err.message : String(err),
      })
      return { accept: false, reason: "irrelevant" }
    }

    if (!intent) return { accept: false, reason: "irrelevant" }

    const threshold = this.opts.confidenceThreshold ?? 0.7
    if (intent.intent === "provided" && intent.confidence >= threshold) {
      return { accept: true, value: intent.email.toLowerCase(), confidence: intent.confidence }
    }
    if (intent.intent === "typo") {
      return { accept: false, reason: "typo", suggestion: intent.suggestion }
    }
    if (intent.intent === "declined") {
      return { accept: false, reason: "declined" }
    }
    if (intent.intent === "unclear") {
      return {
        accept: false,
        reason: "unclear",
        clarifyingQuestion: intent.clarifyingQuestion,
      }
    }
    return { accept: false, reason: "irrelevant" }
  }
}
