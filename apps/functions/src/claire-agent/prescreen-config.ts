/**
 * prescreen-config.ts — the config→thin-store seam (task #13, Adam 2026-05-30).
 *
 * THE GAP this closes: the thin prescreen reducer + tools (ask_next/score_prescreen) exist and are
 * correct, but nothing ever loaded a job's REAL questions into the thin `ProcessSessionStore.prescreen`
 * — `emptyProcessStore()` seeds `questions: []`, so even when reached the thin tool had nothing to ask.
 * This maps a `pa-jobs/{jobId}.prescreenConfig` (+ an in-progress `pa-prescreen-sessions` doc, so a
 * resumed session keeps its already-scored answers) into:
 *
 *   - `store.prescreen`  : PrescreenState (questions[] = qIds, threshold, prior scores, terminal)
 *   - `prompts`          : qId → the canonical question text — DIRECTION the agent grounds + probes on,
 *                          NOT a script to read verbatim (Adam: "questions are only for direction;
 *                          combine with their resume and ask probing questions").
 *   - `judgeContext`     : qId → what the answer is actually evaluated on (the config's keyword hints +
 *                          clarify prompt). The thin judge scores AGAINST this so a resume-grounded
 *                          probing exchange still maps to the job's real rubric — no regex, LLM-judged.
 *
 * Pure + defensive over the raw Firestore shape (the live config is the rich
 * `{ qId, weight, type, prompt:{zh,en}, clarifyPrompt:{zh,en}, keywords:[{hint,weight,keyword}],
 * matchThreshold }` shape — see PrescreenConfigSchema). Unknown/missing fields degrade, never throw.
 */
import {
  DEFAULT_PRESCREEN_THRESHOLD,
  type PrescreenScore,
  type PrescreenState,
} from "./reducers/prescreen-fsm.js"
import { AI_QUESTION_QID, aiQuestionPromptFor, aiQuestionRubric } from "./prescreen-ai-question.js"
import {
  AI_USAGE_SHARED_KEY,
  isRegisteredSharedKey,
  type PrescreenSharedAnswer,
  type PrescreenSharedAnswers,
} from "@pa/pa-orchestrator"

/** Lang-agnostic text pick from a bilingual `{zh,en}` (or a plain string). */
function pickText(v: unknown, lang: "en" | "zh" = "en"): string {
  if (typeof v === "string") return v.trim()
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>
    const primary = typeof o[lang] === "string" ? (o[lang] as string) : ""
    const other = typeof o.en === "string" ? (o.en as string) : typeof o.zh === "string" ? (o.zh as string) : ""
    return (primary || other).trim()
  }
  return ""
}

export interface ThinPrescreenSeed {
  /** qIds in order — the reducer's `questions`. */
  questionIds: string[]
  /** PrescreenState ready to drop into ProcessSessionStore.prescreen (prior scores preserved). */
  prescreen: PrescreenState
  /** qId → canonical question text (DIRECTION the agent grounds + probes on). */
  prompts: Record<string, string>
  /** qId → rubric the judge scores against (keyword hints + clarify cue). Keeps probing on-rubric. */
  judgeContext: Record<string, string>
  /**
   * SPEC §5a — qId → authored `sharedKey` for questions that carry one (job config + the appended AI
   * question). Threaded onto ctx.prescreenSharedKeys so the finalize seam persists the answer to the
   * GLOBAL cross-session store under its sharedKey. Empty when no question is shared (dormant).
   */
  sharedKeys: Record<string, string>
  /**
   * SPEC §7 — qIds PRE-ANSWERED at session start from the candidate's global shared-answer store. The
   * candidate is NOT asked these (their score is carried/re-judged into `prescreen.scores`). Claire
   * REFERENCES them naturally rather than silent-skipping (SPEC decision 3); `carriedReferences[qId]`
   * is a short natural-language reference hook the agent can weave in.
   */
  carriedQuestionIds: string[]
  /** qId → a short "last time you mentioned …" reference the agent uses instead of re-asking. */
  carriedReferences: Record<string, string>
}

/** Raw per-question config shape (defensive subset of PrescreenQuestionConfigSchema). */
interface RawQuestion {
  qId?: unknown
  prompt?: unknown
  clarifyPrompt?: unknown
  matchThreshold?: unknown
  keywords?: unknown
  sharedKey?: unknown
}

/** Build one question's judge rubric from its keyword hints + clarify cue. */
function judgeContextForQuestion(q: RawQuestion, lang: "en" | "zh"): string {
  const parts: string[] = []
  if (Array.isArray(q.keywords)) {
    for (const k of q.keywords as Array<Record<string, unknown>>) {
      const hint = typeof k?.hint === "string" ? k.hint.trim() : ""
      const kw = typeof k?.keyword === "string" ? k.keyword.trim() : ""
      if (hint) parts.push(hint)
      else if (kw) parts.push(kw)
    }
  }
  const clarify = pickText(q.clarifyPrompt, lang)
  if (clarify) parts.push(`Probe for: ${clarify}`)
  return parts.join(" • ")
}

/**
 * Options for the DEFAULT AI-acceleration question appended to every session (Adam directive).
 * Resolved by the caller (mode-selector) from the job's roleFunction + the cross-session skip
 * signal so this builder stays pure (no Firestore/LLM here).
 */
export interface AiQuestionOptions {
  /** Append the default AI-acceleration question? (false when the candidate already answered it.) */
  append: boolean
  /** The job's roleFunction tokens — selects the role-tailored prompt (generic fallback if empty). */
  roleFunction?: readonly string[] | null
}

/**
 * SPEC §7 — carry-over re-judge. For a shared question whose stored answer is being reused, optionally
 * RE-JUDGE the stored reply against THIS job's rubric so the carried score reflects THIS job (Adam:
 * re-judge, not blind-carry). When absent (or it returns null), carry the SOURCE job's `finalS` as-is
 * (the simpler fallback in SPEC §7 option b). The callback is given the stored reply + this question's
 * rubric/prompt; it returns a fresh 0..1 score. Informational questions (e.g. ai_usage) do not gate the
 * verdict, so re-judge is a no-op on PASS/FAIL there regardless.
 */
export type CarryOverReJudge = (input: {
  qId: string
  sharedKey: string
  reply: string
  rubric?: string
  prompt?: string
}) => Promise<number | null>

/** Build the short natural-language reference the agent uses instead of re-asking (SPEC decision 3). */
function carriedReferenceFor(answer: PrescreenSharedAnswer): string {
  const snippet = answer.reply.trim().replace(/\s+/g, " ").slice(0, 160)
  return `The candidate already answered this in a prior session — reference it naturally instead of re-asking (e.g. "last time you mentioned ${snippet}…"), then move on.`
}

/**
 * Map a job's prescreen config (+ optional in-progress session) → the thin prescreen seed.
 *
 * @param config  the `pa-jobs/{jobId}.prescreenConfig` object (raw Firestore data).
 * @param session optional `pa-prescreen-sessions/{id}` data so a RESUMED session keeps prior scores
 *                + terminal (the reducer rejects post-terminal re-score; resume must not re-ask).
 * @param lang    text language pick for bilingual prompts.
 * @param aiQuestion optional DEFAULT AI-acceleration question control — when `append:true` and the
 *                qId isn't already present/scored, a role-tailored, NON-GATING `q_ai_acceleration`
 *                question is appended as the LAST question. Skip-aware: a resumed session that
 *                already scored it (carried via `session.scored`) never re-appends.
 */
export function buildThinPrescreenSeed(
  config: Record<string, unknown> | null | undefined,
  session?: Record<string, unknown> | null,
  lang: "en" | "zh" = "en",
  aiQuestion?: AiQuestionOptions | null,
  carryOver?: {
    /** The candidate's global shared-answer store (pa-users.prescreenSharedAnswers). */
    sharedAnswers?: PrescreenSharedAnswers | null
    /**
     * SPEC §7 — qId → FRESH re-judged score (0..1) for a carried shared question, re-judged against
     * THIS job's rubric by the caller (mode-selector, which has the judge). When a carried qId is
     * absent here, fall back to the SOURCE job's stored finalS (carry-as-is, SPEC §7 option b).
     */
    reJudgedScores?: Record<string, number>
  } | null,
): ThinPrescreenSeed {
  const rawQs = Array.isArray(config?.questions) ? (config!.questions as RawQuestion[]) : []
  const questionIds: string[] = []
  const prompts: Record<string, string> = {}
  const judgeContext: Record<string, string> = {}
  const sharedKeys: Record<string, string> = {}
  for (const q of rawQs) {
    const qId = typeof q?.qId === "string" ? q.qId.trim() : ""
    if (!qId || questionIds.includes(qId)) continue
    questionIds.push(qId)
    const prompt = pickText(q.prompt, lang)
    if (prompt) prompts[qId] = prompt
    const jc = judgeContextForQuestion(q, lang)
    if (jc) judgeContext[qId] = jc
    // SPEC §5a — capture the authored sharedKey (only when registered, so an unknown authored key
    // never silently shares an answer cross-job).
    const sk = typeof q?.sharedKey === "string" ? q.sharedKey.trim() : ""
    if (sk && isRegisteredSharedKey(sk)) sharedKeys[qId] = sk
  }

  // DEFAULT AI-acceleration question (Adam directive): append a role-tailored, NON-GATING
  // `q_ai_acceleration` as the LAST question on EVERY session, unless the caller resolved the
  // cross-session skip (already answered) OR the config already declares the qId. Appended to
  // `questionIds` BEFORE the resume-score carry-over loop so a resumed session that already
  // scored it carries the score forward (and the FSM treats it as done — no re-ask).
  const informational: string[] = []
  if (aiQuestion?.append && !questionIds.includes(AI_QUESTION_QID)) {
    questionIds.push(AI_QUESTION_QID)
    prompts[AI_QUESTION_QID] = aiQuestionPromptFor(aiQuestion.roleFunction)
    judgeContext[AI_QUESTION_QID] = aiQuestionRubric()
    informational.push(AI_QUESTION_QID)
    // The appended AI question is a shared question keyed `ai_usage` (SPEC migration of the MVP).
    sharedKeys[AI_QUESTION_QID] = AI_USAGE_SHARED_KEY
  }

  // Threshold: config-level wins; else the thin default (avg >= 0.6).
  const cfgThreshold =
    typeof config?.threshold === "number" && Number.isFinite(config.threshold)
      ? (config.threshold as number)
      : DEFAULT_PRESCREEN_THRESHOLD

  // Resume: carry over already-scored answers + a committed terminal from the live session, so the
  // reducer keeps "what's next" correct and never re-asks a scored question.
  const scores: Record<string, PrescreenScore> = {}
  const rawScored = session?.scored ?? session?.scores
  if (rawScored && typeof rawScored === "object") {
    for (const [qId, v] of Object.entries(rawScored as Record<string, unknown>)) {
      if (!questionIds.includes(qId)) continue
      const sc =
        typeof v === "number"
          ? v
          : v && typeof v === "object" && typeof (v as Record<string, unknown>).score === "number"
            ? ((v as Record<string, unknown>).score as number)
            : null
      if (sc !== null && Number.isFinite(sc)) {
        const evidence =
          v && typeof v === "object" && typeof (v as Record<string, unknown>).evidence === "string"
            ? ((v as Record<string, unknown>).evidence as string)
            : undefined
        scores[qId] = evidence ? { score: sc, evidence } : { score: sc }
      }
    }
  }
  // CROSS-SESSION CARRY-OVER (SPEC §7): a question whose authored sharedKey is already in the
  // candidate's GLOBAL shared-answer store was answered in a PRIOR session → do NOT ask it. Seed its
  // score (re-judged against THIS job's rubric when the caller computed it, else carry the source
  // job's finalS) so the FSM auto-skips it (a scored question is never re-asked). Resume scores from
  // THIS session (above) win — they're a live answer to this job. Dormant when the store is empty or
  // no question is shared.
  const carriedQuestionIds: string[] = []
  const carriedReferences: Record<string, string> = {}
  const store = carryOver?.sharedAnswers ?? null
  if (store) {
    for (const [qId, sharedKey] of Object.entries(sharedKeys)) {
      if (qId in scores) continue // already answered live this session — don't override.
      const stored = store[sharedKey]
      if (!stored || typeof stored.reply !== "string" || !stored.reply.trim()) continue
      const reJudged = carryOver?.reJudgedScores?.[qId]
      const carriedScore =
        typeof reJudged === "number" && Number.isFinite(reJudged)
          ? Math.max(0, Math.min(1, reJudged))
          : typeof stored.finalS === "number" && Number.isFinite(stored.finalS)
            ? Math.max(0, Math.min(1, stored.finalS))
            : 1 // informational/no-score-on-record → neutral non-blocking carry.
      scores[qId] = { score: carriedScore, evidence: stored.summary ?? stored.reply.trim() }
      carriedQuestionIds.push(qId)
      carriedReferences[qId] = carriedReferenceFor(stored)
    }
  }

  const sessionTerminal = session?.terminal
  const terminal: "PASS" | "FAIL" | null =
    sessionTerminal === "PASS" || sessionTerminal === "FAIL" ? sessionTerminal : null

  const prescreen: PrescreenState = {
    questions: questionIds,
    scores,
    threshold: cfgThreshold,
    terminal,
    terminalCommits: terminal ? 1 : 0,
    ...(informational.length > 0 ? { informational } : {}),
  }

  return { questionIds, prescreen, prompts, judgeContext, sharedKeys, carriedQuestionIds, carriedReferences }
}
