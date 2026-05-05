/**
 * iter34 P1 — Q-as-class abstraction (Adam directive 2026-05-05).
 *
 * Each onboarding question is a self-contained Question<TAnswer> instance
 * with three pluggable behaviors:
 *
 *   1. **Judge** — decides whether the user's reply ANSWERS the question.
 *      Built-in judges: EmailJudge, CodeJudge, LLMRelevanceJudge, YesNoJudge,
 *      ResumeJudge. Custom judges live alongside in /judges.
 *
 *   2. **Rephraser** — generates a re-ask phrasing when judge rejects.
 *      Built-in: StaticVariantsRephraser (rotate from a fixed array),
 *      LLMRephraser (regen via LLM), HybridRephraser (variants → LLM fallback).
 *
 *   3. **onAccepted** (optional) — side effect to fire after a successful
 *      answer is captured. E.g. q_email writes contactEmail to user doc;
 *      q_email_verify stamps contactEmailVerifiedAt.
 *
 * Pipelines (see pipeline.ts) compose Question instances in a list. Adding
 * a new Q = appending one Question to the list. Re-asks, attempt counting,
 * halt-at-N, lang preservation, system flags — ALL handled by pipeline.
 *
 * Goal: replace the 1700-line if/else flow in onboarding-deterministic.ts
 * with a config-driven Question[] registry. Onboarding becomes data, not code.
 */

export type Lang = "zh" | "en"

export type BilingualText = { zh: string; en: string }

/**
 * Result of a Judge.judge() call. Three buckets, each with action implications:
 *
 *   - accept=true → pipeline records `value`, fires onAccepted, advances to next Q
 *   - accept=false reason=irrelevant → pipeline bumps attempt counter, asks
 *     rephraser for next phrasing. Common case: noise / unrelated reply.
 *   - accept=false reason=unclear → same as irrelevant from the pipeline's
 *     perspective, but passes the judge's clarifyingQuestion (if any) into
 *     the Rephraser as a hint. LLM judges typically return this.
 *   - accept=false reason=declined → user explicitly said no/refused. Pipeline
 *     calls Question.onDeclined (if present) and may halt or skip per config.
 *   - accept=false reason=typo → judge identified a near-miss (e.g. gmal.com).
 *     The judge populates `suggestion` with the corrected form for the
 *     rephraser to surface as confirmation prompt.
 *
 * `confidence` is informational; pipelines can use it for logging or to
 * threshold-gate fragile judges (e.g. LLM extractors at <0.6).
 */
export type JudgeResult<TAnswer> =
  | { accept: true; value: TAnswer; confidence?: number }
  | {
      accept: false
      reason: "irrelevant" | "unclear" | "declined" | "typo"
      clarifyingQuestion?: string
      suggestion?: string
      confidence?: number
    }

/**
 * Context handed to a Judge for cases where the decision needs more than
 * the user's text reply. Examples:
 *   - CodeJudge needs Firestore access to fetch the stored hash
 *   - EmailJudge needs Mailgun deps to start a verify challenge
 *   - ResumeJudge needs the inbound rawPayload to inspect attachments
 */
export interface JudgeCtx {
  userId: string
  turnId: string
  rawPayload?: unknown // iMessage raw payload, etc.
  db?: unknown // Firestore (typed as any to avoid pulling firebase-admin into the abstraction layer)
  log?(event: string, payload: Record<string, unknown>): void
}

export interface Judge<TAnswer> {
  /**
   * Stable identifier for this judge type. Used in logs + telemetry.
   * Examples: "email", "code", "llm-relevance", "yesno", "resume".
   */
  readonly kind: string
  judge(reply: string, lang: Lang, ctx: JudgeCtx): Promise<JudgeResult<TAnswer>>
}

/**
 * Args handed to a Rephraser. The rephraser decides what string to send
 * back to the user when the judge rejected an answer.
 */
export interface RephraseArgs {
  questionId: string
  originalPrompt: string
  userReply: string
  /** 1-indexed attempt number. attempt 1 = first re-ask after rejecting reply 1. */
  attemptNum: number
  lang: Lang
  /**
   * Hint surfaced by the judge — e.g. LLMRelevanceJudge passes the
   * `clarifyingQuestion` returned by the LLM. Rephrasers MAY use this
   * (HybridRephraser falls back to it after exhausting variants).
   */
  llmClarifyingQuestion?: string
  /**
   * Hint when judge returned reason="typo" — the suggested corrected form.
   * E.g. EmailJudge: "test@gmal.com" → suggestion "test@gmail.com".
   */
  typoSuggestion?: string
}

export interface Rephraser {
  readonly kind: string
  rephrase(args: RephraseArgs): Promise<string>
}

/**
 * Context handed to onAccepted — pipeline plumbing the question needs to
 * write its captured value somewhere (user doc, mem0, etc.).
 */
export interface AcceptedCtx {
  userId: string
  turnId: string
  lang: Lang
  db?: unknown
  log?(event: string, payload: Record<string, unknown>): void
}

/**
 * Question<TAnswer> — single-Q definition. All onboarding behavior is
 * configured here. Pipeline orchestrates ordering + retries + halts.
 */
export interface Question<TAnswer> {
  /** Unique id. Used as the key in collected-answers map + onboardingState. */
  id: string
  /** Initial prompt the user sees when this Q first becomes active. */
  prompt: BilingualText
  /** Decides whether a reply ANSWERS the Q. */
  judge: Judge<TAnswer>
  /** Generates re-ask text after judge rejects. */
  rephraser: Rephraser
  /**
   * Cap on retries before pipeline halts onboarding (Adam directive
   * 2026-05-05: "最多给一个问题5次尝试"). Default 5. Set to Infinity to
   * disable halt for a particular Q.
   */
  maxAttempts?: number
  /**
   * Message sent on halt. Default uses the pipeline's haltMessageDefault
   * if unset. Per-Q override allows custom escalations (e.g. q_email_verify
   * could route to support flow instead).
   */
  haltMessage?: BilingualText
  /**
   * Optional hook fired once judge.accept=true. Use for side effects:
   * persisting captured value to user doc, stamping verifiedAt timestamps,
   * triggering downstream workers. Pipeline awaits this before advancing.
   */
  onAccepted?(value: TAnswer, ctx: AcceptedCtx): Promise<void>
  /**
   * Optional hook fired when judge.reason="declined". Lets a Q customize
   * decline UX (e.g. q_tos sends a "fine, won't store memory" message and
   * skips forward instead of halting). Returns:
   *   - { advance: true } → skip this Q, move to next
   *   - { advance: false, halt?: true } → stay or halt
   *   - undefined → fall through to default behavior (treat as irrelevant)
   */
  onDeclined?(ctx: AcceptedCtx): Promise<{ advance: boolean; halt?: boolean } | undefined>
}

/**
 * Helper to construct a Question with sensible defaults. The class form
 * also makes inheritance easy for one-off subclasses.
 */
export function makeQuestion<TAnswer>(spec: Question<TAnswer>): Question<TAnswer> {
  return {
    maxAttempts: 5,
    ...spec,
  }
}
