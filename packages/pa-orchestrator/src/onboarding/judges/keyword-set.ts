/**
 * v1.8 Phase 75 — KeywordSetJudge.
 *
 * Per Adam directive 2026-05-11 (LLM evaluation explanation surfaced for
 * evaluation + early abort), every pre-screening question is evaluated against
 * a JD-side keyword set with structured LLM output:
 *
 *   reply ──▶ KeywordSetJudge.judge(reply, lang, ctx)
 *               │
 *               ▼
 *         LLM (gpt-5.4-nano JSON-mode, temp=0, seed)
 *               │
 *               ▼  parsed + Zod-validated
 *         ScoredJudgeResult (kind: "scored")
 *           ├─ perKeyword[] {match m_ij, confidence ĉ_ij, evidence, reasoning}
 *           ├─ aggregate    {s_i = Σ w_ij·m_ij / W_Q, c_i, summary}
 *           └─ abortHint?   {kind: low_confidence|off_topic|decline|ambiguous}
 *
 * Pipeline (Phase 76) uses `aggregate.s/c` + Question.type + clarifyRounds
 * to compute the Type Gate / Viability / Final Decision transitions.
 *
 * LLM caller is injectable (same pattern as CompactionLlmCaller — packages/
 * memory/src/compaction.ts) so unit tests stub without network access; the
 * production wire-up (gpt-5.4-nano primary + Sonnet-4-6 fallback) lives in
 * Phase 78/79 dashboard preview CF + Phase 80 runner.
 *
 * Locked decisions reflected here:
 *   - PS4: ScoredJudgeResult is the OUTPUT shape (discriminated union)
 *   - PS5: explanation fields are MANDATORY (perKeyword[].evidence +
 *          reasoning + aggregate.summary). No silent dropping.
 *   - D-LLM-chain: temperature=0, JSON-mode required, fallback chain
 *          governed by caller (this layer is provider-agnostic)
 *   - PS15: explanation is server-write-only (dashboard reads, candidate
 *          never sees). Enforced at Firestore rules (Phase 79), not here.
 */
import type { Judge, JudgeCtx, JudgeResult, Lang, ScoredJudgeResult } from "../question.js"

// ────────────────────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────────────────────

/** A single keyword in the JD-side KeywordSet with per-keyword weight. */
export interface KeywordSpec {
  /** The keyword to evaluate (e.g. "production react", "kubernetes"). */
  keyword: string
  /** Per-keyword weight w_{i,j}. Caller-supplied; default 1.0. */
  weight?: number
  /** Optional hint passed to the LLM (e.g. "synonyms: k8s, gke"). */
  hint?: string
}

/** Configuration handed to a KeywordSetJudge instance. */
export interface KeywordSetJudgeSpec {
  /** Stable id for telemetry — e.g. "ps_q_react_experience". */
  questionId: string
  /** The keyword set (1+ entries). */
  keywords: KeywordSpec[]
  /**
   * Optional context string (the original Question prompt) so the LLM
   * understands what was asked. Rendered into the prompt.
   */
  questionPrompt?: string
  /**
   * Optional candidate context (résumé / profile summary) so the LLM can
   * CREDIT evidence already proven elsewhere and avoid penalizing a reply
   * for not re-stating it. Rendered into the prompt when present.
   */
  candidateContext?: string
  /**
   * Injected LLM caller. Phase 78/80 wires the gpt-5.4-nano JSON-mode path
   * via agent-runtime. Tests pass canned outputs.
   */
  llmCaller: KeywordSetLlmCaller
}

/** LLM caller seam. Mirrors `CompactionLlmCaller` shape. */
export interface KeywordSetLlmCaller {
  /**
   * Score a single reply against a keyword set. Must return parsed +
   * validated JSON shape. Caller owns temperature=0, JSON-mode, retries,
   * fallback chain.
   */
  score(args: {
    reply: string
    lang: Lang
    keywords: KeywordSpec[]
    questionPrompt?: string
    candidateContext?: string
  }): Promise<KeywordSetLlmOutput>
}

/**
 * Raw shape returned by the LLM caller (already JSON-parsed by the caller).
 * Validated here via `validateLlmOutput` before being assembled into a
 * `ScoredJudgeResult`.
 */
export interface KeywordSetLlmOutput {
  perKeyword: Array<{
    keyword: string
    match: number
    confidence: number
    evidence: string
    reasoning: string
  }>
  /** Optional caller-supplied summary; otherwise auto-computed below. */
  summary?: string
  /** Optional abort hint. */
  abortHint?: {
    kind: "low_confidence" | "off_topic" | "decline" | "ambiguous"
    reason: string
  }
  /** Optional value (canonical-form caller wants to capture, e.g. "yes"). */
  answered?: boolean
}

// ────────────────────────────────────────────────────────────────────────────
// Pure validators + aggregators
// ────────────────────────────────────────────────────────────────────────────

const ABORT_KINDS = new Set([
  "low_confidence",
  "off_topic",
  "decline",
  "ambiguous",
])

/**
 * Validate the LLM output. Throws with a helpful message on shape errors —
 * caller catches and routes to fallback / abortHint.
 *
 * Drops perKeyword entries that don't match the configured keyword list to
 * defend against the LLM inventing new keywords. Clamps match/confidence to
 * [0,1].
 */
export function validateLlmOutput(
  raw: unknown,
  keywords: KeywordSpec[]
): KeywordSetLlmOutput {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("KeywordSetJudge: LLM output is not an object")
  }
  const o = raw as Record<string, unknown>
  if (!Array.isArray(o.perKeyword)) {
    throw new Error("KeywordSetJudge: LLM output missing perKeyword[]")
  }
  const knownKeywords = new Set(keywords.map((k) => k.keyword.toLowerCase()))
  const perKeyword: KeywordSetLlmOutput["perKeyword"] = []
  for (const rawCell of o.perKeyword) {
    if (typeof rawCell !== "object" || rawCell === null) continue
    const c = rawCell as Record<string, unknown>
    if (typeof c.keyword !== "string") continue
    if (!knownKeywords.has(c.keyword.toLowerCase())) continue
    if (typeof c.match !== "number" || !Number.isFinite(c.match)) continue
    if (typeof c.confidence !== "number" || !Number.isFinite(c.confidence)) continue
    perKeyword.push({
      keyword: c.keyword,
      match: Math.max(0, Math.min(1, c.match)),
      confidence: Math.max(0, Math.min(1, c.confidence)),
      evidence: typeof c.evidence === "string" ? c.evidence.slice(0, 60) : "",
      reasoning: typeof c.reasoning === "string" ? c.reasoning.slice(0, 80) : "",
    })
  }
  const out: KeywordSetLlmOutput = { perKeyword }
  if (typeof o.summary === "string") out.summary = o.summary.slice(0, 120)
  if (typeof o.answered === "boolean") out.answered = o.answered
  if (
    typeof o.abortHint === "object" &&
    o.abortHint !== null &&
    typeof (o.abortHint as Record<string, unknown>).kind === "string" &&
    ABORT_KINDS.has((o.abortHint as Record<string, string>).kind)
  ) {
    const a = o.abortHint as Record<string, string>
    out.abortHint = {
      kind: a.kind as KeywordSetLlmOutput["abortHint"] extends infer T ? T extends { kind: infer K } ? K : never : never,
      reason: typeof a.reason === "string" ? a.reason : "",
    }
  }
  return out
}

/**
 * Compute aggregate `s_i`, `c_i` per the v1.8 spec:
 *
 *   W_{Q_i}    = Σ_j w_ij
 *   s_i        = ( Σ_j w_ij · m_ij ) / W_{Q_i}        ∈ [0,1]
 *   c_i        = ( Σ_j w_ij · ĉ_ij ) / W_{Q_i}        ∈ [0,1]
 *
 * When the LLM omits a keyword from perKeyword[], it counts as
 * (match=0, confidence=1) — high-confidence zero, signaling "we asked and
 * the candidate didn't address it". This biases Type Gate toward
 * hard-stop for MUST_HAVE keywords on incomplete answers.
 */
export function computeAggregate(
  perKeyword: KeywordSetLlmOutput["perKeyword"],
  keywords: KeywordSpec[]
): { s: number; c: number } {
  let totalWeight = 0
  let weightedMatch = 0
  let weightedConfidence = 0
  const cellByKeyword = new Map(
    perKeyword.map((p) => [p.keyword.toLowerCase(), p])
  )
  for (const spec of keywords) {
    const w = spec.weight ?? 1.0
    totalWeight += w
    const cell = cellByKeyword.get(spec.keyword.toLowerCase())
    if (cell) {
      weightedMatch += w * cell.match
      weightedConfidence += w * cell.confidence
    } else {
      // missing → match=0, confidence=1 (we asked, no signal returned)
      weightedConfidence += w * 1.0
    }
  }
  if (totalWeight === 0) return { s: 0, c: 0 }
  return {
    s: weightedMatch / totalWeight,
    c: weightedConfidence / totalWeight,
  }
}

/**
 * Build a one-sentence summary when the LLM omits one. Uses top-weighted
 * matched keywords.
 */
export function computeSummary(
  perKeyword: KeywordSetLlmOutput["perKeyword"],
  keywords: KeywordSpec[]
): string {
  if (perKeyword.length === 0) return "no keywords matched in reply"
  const ranked = [...perKeyword]
    .map((c) => {
      const spec = keywords.find((k) => k.keyword.toLowerCase() === c.keyword.toLowerCase())
      return { ...c, weight: spec?.weight ?? 1 }
    })
    .sort((a, b) => b.weight * b.match - a.weight * a.match)
  const top = ranked.slice(0, 2).map((c) => `${c.keyword} (${c.match.toFixed(1)})`)
  return `top keywords: ${top.join(", ")}`.slice(0, 120)
}

// ────────────────────────────────────────────────────────────────────────────
// Default abortHint inference
// ────────────────────────────────────────────────────────────────────────────

const LOW_CONFIDENCE_THRESHOLD = 0.5

/**
 * Derive an abortHint when the LLM didn't supply one. Pipeline uses this to
 * route off-topic / decline cleanly without requiring the LLM prompt to
 * always classify.
 */
export function inferAbortHint(
  llmOutput: KeywordSetLlmOutput,
  aggregate: { s: number; c: number }
): ScoredJudgeResult["abortHint"] | undefined {
  if (llmOutput.abortHint) return llmOutput.abortHint
  if (aggregate.c < LOW_CONFIDENCE_THRESHOLD) {
    return { kind: "low_confidence", reason: `aggregate c=${aggregate.c.toFixed(2)} below ${LOW_CONFIDENCE_THRESHOLD}` }
  }
  if (llmOutput.perKeyword.length === 0) {
    return { kind: "off_topic", reason: "no keyword cells emitted" }
  }
  return undefined
}

// ────────────────────────────────────────────────────────────────────────────
// Judge implementation
// ────────────────────────────────────────────────────────────────────────────

/**
 * KeywordSetJudge implements `Judge<{ answered: boolean }>` but returns the
 * RICHER `ScoredJudgeResult` shape (kind: "scored"). Pipelines that
 * understand pre-screening branch via `isScoredJudgeResult`. The legacy
 * binary path is implemented as a transparent fallback so this judge can
 * also be dropped into the existing OnboardingPipeline for migration
 * scenarios (Phase 81).
 */
export class KeywordSetJudge implements Judge<{ answered: boolean }> {
  readonly kind = "keyword-set"

  constructor(private readonly spec: KeywordSetJudgeSpec) {
    if (spec.keywords.length === 0) {
      throw new Error("KeywordSetJudge: keywords[] must be non-empty")
    }
  }

  /**
   * Public method that the pre-screening pipeline calls. Returns the rich
   * scored result. Cannot be statically declared on the Judge interface
   * without breaking existing binary judges, so it's exposed as a separate
   * method.
   */
  async judgeScored(
    reply: string,
    lang: Lang,
    ctx: JudgeCtx
  ): Promise<ScoredJudgeResult<{ answered: boolean }>> {
    const log = ctx.log ?? (() => {})
    let raw: unknown
    try {
      raw = await this.spec.llmCaller.score({
        reply,
        lang,
        keywords: this.spec.keywords,
        questionPrompt: this.spec.questionPrompt,
        candidateContext: this.spec.candidateContext,
      })
    } catch (err) {
      log("keyword-set.llm_error", {
        questionId: this.spec.questionId,
        error: err instanceof Error ? err.message : String(err),
      })
      // LLM failure → emit a scored result with abortHint so the pipeline
      // can route cleanly without inventing a fake match score.
      return {
        kind: "scored",
        answered: false,
        perKeyword: [],
        aggregate: { s: 0, c: 0, summary: "LLM call failed" },
        abortHint: {
          kind: "ambiguous",
          reason: err instanceof Error ? err.message : "llm error",
        },
      }
    }

    let validated: KeywordSetLlmOutput
    try {
      validated = validateLlmOutput(raw, this.spec.keywords)
    } catch (err) {
      log("keyword-set.llm_invalid", {
        questionId: this.spec.questionId,
        error: err instanceof Error ? err.message : String(err),
      })
      return {
        kind: "scored",
        answered: false,
        perKeyword: [],
        aggregate: { s: 0, c: 0, summary: "LLM output malformed" },
        abortHint: { kind: "ambiguous", reason: "invalid LLM output" },
      }
    }

    const aggregate = computeAggregate(validated.perKeyword, this.spec.keywords)
    const summary = validated.summary ?? computeSummary(validated.perKeyword, this.spec.keywords)
    const abortHint = inferAbortHint(validated, aggregate)

    return {
      kind: "scored",
      answered: validated.answered ?? aggregate.s > 0,
      value: { answered: validated.answered ?? aggregate.s > 0 },
      perKeyword: validated.perKeyword,
      aggregate: { ...aggregate, summary },
      abortHint,
    }
  }

  /**
   * Binary-Judge compatibility shim. Maps the scored result onto the legacy
   * `JudgeResult` shape so this judge can be slotted into the existing
   * OnboardingPipeline during migration. Pipelines that understand scored
   * results should call `judgeScored` directly.
   *
   * Map: aggregate.s >= 0.6 → accept; abortHint.kind === "decline" →
   * reason: declined; otherwise reason: irrelevant.
   */
  async judge(
    reply: string,
    lang: Lang,
    ctx: JudgeCtx
  ): Promise<JudgeResult<{ answered: boolean }>> {
    const scored = await this.judgeScored(reply, lang, ctx)
    if (scored.aggregate.s >= 0.6) {
      return {
        accept: true,
        value: { answered: scored.answered },
        confidence: scored.aggregate.c,
      }
    }
    if (scored.abortHint?.kind === "decline") {
      return {
        accept: false,
        reason: "declined",
        clarifyingQuestion: scored.aggregate.summary,
        confidence: scored.aggregate.c,
      }
    }
    return {
      accept: false,
      reason: scored.abortHint?.kind === "low_confidence" ? "unclear" : "irrelevant",
      clarifyingQuestion: scored.aggregate.summary,
      confidence: scored.aggregate.c,
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Prompt template (for production LLM caller; tests don't use this)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build the JSON-mode prompt for gpt-5.4-nano. Phase 78/80 production wiring
 * uses this. Kept here (not inside the caller) so the prompt is testable
 * and version-controlled separately from provider-specific code.
 */
export function buildKeywordSetPrompt(args: {
  reply: string
  lang: Lang
  keywords: KeywordSpec[]
  questionPrompt?: string
  candidateContext?: string
}): { system: string; user: string } {
  const keywordList = args.keywords
    .map((k, i) => {
      const w = k.weight ?? 1.0
      const hint = k.hint ? ` (hint: ${k.hint})` : ""
      return `${i + 1}. "${k.keyword}" — weight ${w.toFixed(2)}${hint}`
    })
    .join("\n")

  const system = [
    "You are a top-5% hiring-calibration evaluator for prescreen evidence.",
    "Your job is to prevent weak, adjacent, vague, resume-only, or team-only answers from looking like approval-grade hiring signals.",
    "For EACH keyword in the configured set, emit one cell with:",
    "  - keyword: the keyword string verbatim",
    "  - match: 0..1 — how well the reply demonstrates the keyword",
    "  - confidence: 0..1 — how sure you are about the match score",
    "  - evidence: ≤60 char excerpt from the reply that supports the score",
    "  - reasoning: ≤80 char explanation",
    "",
    "Also emit:",
    "  - summary: ≤120 char overall assessment",
    "  - answered: true|false — did the candidate substantively address the question?",
    "  - abortHint (optional): {kind: low_confidence|off_topic|decline|ambiguous, reason: string}",
    "    set this whenever there is clear evidence of one of these modes — in particular set kind:decline whenever the candidate cannot or will not produce the requested artifact/proof.",
    "",
    "CALIBRATION ANCHORS:",
    "- 0.95-1.00: top-5% evidence only: exact required skill/scope, direct ownership, concrete shipped outcome, and clear metrics/systems/constraints.",
    "- 0.85-0.90: strong but not approval-grade; use when one concrete required detail is missing.",
    "- 0.70-0.80: partial or adjacent evidence; plausible but not enough to approve.",
    "- 0.45-0.65: vague, team-only, assisted, classroom, exploratory, or loosely related evidence.",
    "- 0.00-0.35: no substantive evidence, dodge, generic interest, or unrelated answer.",
    "",
    "STRICT CAPS:",
    "- cap at 0.70 when the candidate does not show direct ownership.",
    "- cap at 0.65 when the evidence is adjacent rather than the exact requested scope.",
    "- cap team-only evidence at 0.55 unless the candidate clearly states their own owned work.",
    "- cap at 0.70 when a growth/marketing/business-impact answer has no measurable result.",
    "- cap at 0.60 for tool or keyword name-dropping without a concrete shipped example.",
    "- cap at 0.50 for resume-style claims with no reply-specific evidence.",
    "",
    "RULES:",
    "- Be conservative. A high score is reserved for evidence the WeKruit team would likely approve as top-5% for this role.",
    "- Output STRICT JSON matching this schema. No prose.",
    "- Do NOT invent keywords not in the configured set.",
    "- Do NOT echo the reply text — only the short evidence excerpt.",
    "- Temperature is fixed at 0; be deterministic.",
    "- If the candidate clearly signals they CANNOT or WILL NOT produce the requested artifact/proof (e.g. 'I don't have that', 'I can't share', 'I'm having difficulty', 'that's the smallest/only thing I have', 'I already told you', repeated inability), set abortHint:{kind:\"decline\",reason:...}. Do not keep scoring as if more probing will help.",
    "- A candidate-context block may be provided (résumé / profile). CREDIT evidence already present there — do NOT penalize the reply for not re-stating what the profile already proves. Score the keyword as matched if the candidate context substantiates it.",
  ].join("\n")

  const user = [
    args.questionPrompt ? `Question asked (${args.lang}): ${args.questionPrompt}` : "",
    "",
    `Candidate reply (${args.lang}):`,
    `"""${args.reply}"""`,
    "",
    args.candidateContext
      ? `Candidate context (résumé/profile — credit evidence already shown here):\n${args.candidateContext}`
      : "",
    "Keyword set:",
    keywordList,
    "",
    'Output JSON: { "perKeyword": [...], "summary": "...", "answered": bool, "abortHint": {...}? }',
  ]
    .filter((s) => s !== null && s !== "")
    .join("\n")

  return { system, user }
}
