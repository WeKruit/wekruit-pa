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

// ────────────────────────────────────────────────────────────────────────────
// v1.8 Phase 74 (PS1-PS5): ScoredJudgeResult — additive variant for the
// pre-screening pipeline. Existing binary JudgeResult is untouched; scored
// judges (KeywordSetJudge, future) emit this richer shape.
//
// Discriminated by `kind: "scored"` so a pipeline can branch without losing
// the safety of TypeScript exhaustiveness.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Per-keyword evaluation cell. Emitted by scored judges. The pipeline uses
 * `match`/`confidence` for scoring; `evidence`/`reasoning` are observability
 * fields surfaced in admin dashboards (NEVER shown to candidates).
 */
export interface PerKeywordEvaluation {
  /** The keyword from the JD-side KeywordSet (PS1-PS3). */
  keyword: string
  /** m_ij ∈ [0,1] — semantic match score from the LLM evaluator. */
  match: number
  /** ĉ_ij ∈ [0,1] — confidence in the match score. */
  confidence: number
  /** ≤60-char excerpt of the candidate reply that supports the score. */
  evidence: string
  /** ≤80-char LLM explanation for why this match score was assigned. */
  reasoning: string
}

/**
 * Aggregate score for a single Question after keyword-set evaluation.
 * Computed by the judge after assembling perKeyword cells.
 */
export interface ScoredAggregate {
  /** s_i ∈ [0,1] — weighted-mean match across keywords. */
  s: number
  /** c_i ∈ [0,1] — weighted-mean confidence across keywords. */
  c: number
  /** One-sentence (≤120 char) human-readable summary for the dashboard. */
  summary: string
}

/**
 * Optional hint for the Pipeline upper layer — distinguishes routing actions
 * (clarify vs decline vs off-topic) from raw score signals. Pipelines can
 * consult this to short-circuit the Type Gate when the candidate clearly
 * declined or went off-topic.
 */
export interface AbortHint {
  kind: "low_confidence" | "off_topic" | "decline" | "ambiguous"
  reason: string
}

/**
 * ScoredJudgeResult — emitted by judges that compute per-keyword scores.
 * Additive over JudgeResult: pipelines branch on `kind === "scored"`.
 *
 * The `accept` field is derived (not opinionated): scored judges leave the
 * type-gate decision to the pipeline, which combines `s`, `c`, the Question's
 * `type` (MUST_HAVE / PROBING / GOOD_TO_HAVE), and `abortHint` to decide.
 */
export interface ScoredJudgeResult<TAnswer = unknown> {
  readonly kind: "scored"
  /** Whether the judge believes the answer was successfully captured. */
  answered: boolean
  /** Optional captured value (e.g. canonical form). */
  value?: TAnswer
  /** Per-keyword evaluation cells in the same order as the KeywordSet. */
  perKeyword: PerKeywordEvaluation[]
  /** Question-level aggregate. */
  aggregate: ScoredAggregate
  /** Pipeline routing hint — see AbortHint. */
  abortHint?: AbortHint
}

/**
 * Type-guard for routing in pipelines that handle both binary and scored
 * judges. Use in `OnboardingPipeline` to branch the Type Gate.
 */
export function isScoredJudgeResult<T>(
  r: JudgeResult<T> | ScoredJudgeResult<T>
): r is ScoredJudgeResult<T> {
  return (r as ScoredJudgeResult<T>).kind === "scored"
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

// ────────────────────────────────────────────────────────────────────────────
// v1.8 Phase 74 (PS2-PS3): QuestionType + per-Q weight.
//
// Onboarding Qs default to "MUST_HAVE" + weight 1.0 — zero behavior change
// for existing 11 onboarding Qs. Pre-screen Qs explicitly set type and
// weight to drive the Type Gate (MUST_HAVE/PROBING hard-stop) and weighted
// score aggregation (S = Σ s_i · W_{Q_i}).
// ────────────────────────────────────────────────────────────────────────────

export type QuestionType = "MUST_HAVE" | "PROBING" | "GOOD_TO_HAVE"

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
   * v1.8 PS2 — Question type drives the Type Gate. Defaults to "MUST_HAVE"
   * for backwards compatibility with existing onboarding Qs.
   *   - MUST_HAVE: any mismatch (s_i < 1.0) → HARD_STOP terminal
   *   - PROBING: s_i < τ_m OR c_i < τ_c → HARD_STOP terminal
   *   - GOOD_TO_HAVE: never hard-stops; low scores still accumulate
   */
  type?: QuestionType
  /**
   * v1.8 PS3 — per-Q weight contributing to W_{Q_i} in score aggregation.
   * Defaults to 1.0. Used by pre-screening pipeline; onboarding ignores.
   */
  weight?: number
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
   * Optional hook fired before the initial prompt is emitted when the question
   * becomes active. Use this when durable candidate state can answer a gate
   * without asking the user again (for example: parsed resume already on file).
   */
  onEnter?(
    ctx: AcceptedCtx
  ): Promise<{ accept: true; value: TAnswer; confidence?: number } | null | undefined>
  /**
   * When this question is the terminal question and onAccepted already owns
   * the user-facing completion flow, mark pipeline complete without emitting
   * the generic post-all-Qs completion copy.
   */
  suppressTerminalCompletionMessage?: boolean
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
    type: "MUST_HAVE",
    weight: 1.0,
    ...spec,
  }
}
