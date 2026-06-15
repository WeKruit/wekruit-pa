/**
 * prescreen-engagement.ts — an ADVISORY "effort / engagement" pillar for a prescreen
 * session.
 *
 * Some candidates pour real detail into their answers; others reply with one word or
 * one short sentence. All else equal we PREFER the candidate who engaged more — typed
 * more, shared more specifics across more answers. This turns that preference into one
 * transparent, deterministic signal the review surface can show next to the checklist
 * eval and the score.
 *
 * Hard rule (Adam 2026-06-15): this is JUST ANOTHER FLAG. It NEVER gates a session, is
 * never a reject reason on its own, and never changes the prescreen terminal/status. It
 * only helps rank/triage between candidates and informs the operator. A short, precise
 * answer can still be excellent — so a "low" engagement level is a nudge for a closer
 * look, not a verdict.
 *
 * Deterministic on purpose: counts the candidate's own words/answers (a metric, not a
 * text→tag classification — no enum guessing, no LLM cost), so it backfills cheaply over
 * every historical session and applies identically to every future one.
 */

export type EngagementLevel = "high" | "medium" | "low"

export type PrescreenEngagementSignal = {
  /** Bucketed effort level. ADVISORY — never a gate, never a reject reason. */
  level: EngagementLevel
  /** Short human label for the level (e.g. "Detailed / engaged"). */
  label: string
  /** Number of non-empty candidate replies. */
  answeredCount: number
  /** Total words the candidate typed across all replies. */
  totalWords: number
  /** Total characters (trimmed) the candidate typed across all replies. */
  totalChars: number
  /** Mean words per non-empty answer (0 when there are no answers). */
  avgWordsPerAnswer: number
  /** Words in the candidate's longest single answer. */
  maxWordsInAnswer: number
  /** Replies under SHORT_ANSWER_WORDS words. */
  shortAnswerCount: number
  /** shortAnswerCount / answeredCount (0 when no answers). */
  shortAnswerRatio: number
  /** Replies with at least DETAILED_ANSWER_WORDS words (genuine detail). */
  detailedAnswerCount: number
  /** One-line operator-facing explanation of the metrics behind the level. */
  evidence: string
  /** Schema/threshold version — bump when the bucketing changes. */
  version: string
  /** ISO timestamp the signal was computed (set by the caller). */
  computedAt?: string
}

export const ENGAGEMENT_SIGNAL_VERSION = "engagement-v1"

// --- Tunable, advisory thresholds (NOT gates) -------------------------------
/** An answer under this many words counts as "short / low-effort". */
export const SHORT_ANSWER_WORDS = 4
/** An answer with at least this many words counts as a genuinely detailed answer. */
export const DETAILED_ANSWER_WORDS = 25
/** Below this average words/answer the session leans low-effort. */
const LOW_AVG_WORDS = 6
/** Below this total words the session is barely engaged regardless of answer count. */
const LOW_TOTAL_WORDS = 20
/** At/above this fraction of short answers the session leans low-effort. */
const LOW_SHORT_RATIO = 0.7
/** High engagement needs this average words/answer ... */
const HIGH_AVG_WORDS = 18
/** ... AND at least this many answers ... */
const HIGH_MIN_ANSWERS = 3
/** ... AND at least one genuinely detailed answer. */
const HIGH_MIN_DETAILED = 1

const LEVEL_LABEL: Record<EngagementLevel, string> = {
  high: "Detailed / engaged",
  medium: "Moderate effort",
  low: "Low-effort / brief",
}

function wordCount(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  return trimmed.split(/\s+/).filter(Boolean).length
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Compute the engagement signal from the candidate's reply strings (one per prescreen
 * turn). Pure + deterministic. Pass ONLY the candidate's answers (not Claire's prompts).
 */
export function computePrescreenEngagement(replies: Array<string | null | undefined>): PrescreenEngagementSignal {
  const answers = replies
    .map((r) => (typeof r === "string" ? r.trim() : ""))
    .filter((r) => r.length > 0)

  const answeredCount = answers.length
  const wordCounts = answers.map(wordCount)
  const totalWords = wordCounts.reduce((a, b) => a + b, 0)
  const totalChars = answers.reduce((a, r) => a + r.length, 0)
  const avgWordsPerAnswer = answeredCount === 0 ? 0 : round2(totalWords / answeredCount)
  const maxWordsInAnswer = wordCounts.length === 0 ? 0 : Math.max(...wordCounts)
  const shortAnswerCount = wordCounts.filter((w) => w < SHORT_ANSWER_WORDS).length
  const shortAnswerRatio = answeredCount === 0 ? 0 : round2(shortAnswerCount / answeredCount)
  const detailedAnswerCount = wordCounts.filter((w) => w >= DETAILED_ANSWER_WORDS).length

  const level = bucket({
    answeredCount,
    totalWords,
    avgWordsPerAnswer,
    shortAnswerRatio,
    detailedAnswerCount,
  })

  const evidence =
    answeredCount === 0
      ? "no candidate replies recorded — cannot gauge effort"
      : `${answeredCount} answer${answeredCount === 1 ? "" : "s"} · ${totalWords} words total · avg ${avgWordsPerAnswer} w/answer · ${detailedAnswerCount} detailed · ${shortAnswerCount} very short — ${levelEvidenceTail(level)}`

  return {
    level,
    label: LEVEL_LABEL[level],
    answeredCount,
    totalWords,
    totalChars,
    avgWordsPerAnswer,
    maxWordsInAnswer,
    shortAnswerCount,
    shortAnswerRatio,
    detailedAnswerCount,
    evidence,
    version: ENGAGEMENT_SIGNAL_VERSION,
  }
}

function bucket(m: {
  answeredCount: number
  totalWords: number
  avgWordsPerAnswer: number
  shortAnswerRatio: number
  detailedAnswerCount: number
}): EngagementLevel {
  if (m.answeredCount === 0) return "low"
  if (
    m.avgWordsPerAnswer < LOW_AVG_WORDS ||
    m.totalWords < LOW_TOTAL_WORDS ||
    m.shortAnswerRatio >= LOW_SHORT_RATIO
  ) {
    return "low"
  }
  if (
    m.avgWordsPerAnswer >= HIGH_AVG_WORDS &&
    m.answeredCount >= HIGH_MIN_ANSWERS &&
    m.detailedAnswerCount >= HIGH_MIN_DETAILED
  ) {
    return "high"
  }
  return "medium"
}

function levelEvidenceTail(level: EngagementLevel): string {
  if (level === "high") return "shared detailed, specific answers"
  if (level === "low") return "minimal, low-effort replies"
  return "moderate detail"
}

/** UI tone for the level. low → a soft amber NUDGE (not a hard reject color). */
export function engagementTone(level: EngagementLevel | undefined): "ok" | "info" | "warn" | "muted" {
  if (level === "high") return "ok"
  if (level === "medium") return "info"
  if (level === "low") return "warn"
  return "muted"
}

/** One-line summary for operator notes / drafts. Always flags itself as advisory. */
export function summarizeEngagementSignal(signal: PrescreenEngagementSignal): string {
  return `Engagement (effort signal · advisory, never a reject reason): ${signal.level.toUpperCase()} — ${signal.evidence}.`
}
