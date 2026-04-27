import type { MemoryFact } from "@pa/core-types"

/**
 * Memory-opt P0-2 — importance-weighted ranker for persona-card eviction.
 *
 * Pure function. Zero I/O. Deterministic for the same `(facts, now)` pair.
 *
 * Replaces the previous oldest-first FIFO once total fact count exceeds
 * `MAX_FACTS` (20). The score for each fact is:
 *
 *     score = 0.5 * recency_weight
 *           + 0.3 * access_freq_weight
 *           + 0.2 * salience_weight
 *
 * Component definitions:
 *  - recency_weight: linear decay over `RECENCY_WINDOW_DAYS` (90).
 *      age_days = max(0, (now - createdAt) / 1d)
 *      weight   = max(0, 1 - age_days / 90)
 *      Newer facts win; anything older than 90d → 0.
 *  - access_freq_weight: `min(1, accessCount / ACCESS_SATURATION)`. Defaults
 *      to 0 for legacy facts without the field. Saturates at 5 hits so a
 *      fact referenced many times doesn't entirely starve recency.
 *  - salience_weight: per-fact override. The persisted `salience` field
 *      wins when set; otherwise the regex auto-bump fires (1 for identity
 *      bearing or long-term-goal content; 0 otherwise).
 *
 * Returns the input array sorted by descending score; ties broken by
 * `createdAt` desc, then `id` asc — fully deterministic. Does NOT mutate
 * the input.
 */
const RECENCY_WINDOW_DAYS = 90
const ACCESS_SATURATION = 5

const DAY_MS = 86_400_000

/**
 * Identity / long-term goal markers. Conservative — must match the WHOLE
 * concept, not stray characters. Tested against the trimmed lowercased
 * content so authors don't have to think about case.
 *
 * The English token list is whole-word; the Chinese list is substring-only
 * because Chinese has no word boundaries. Adam-domain (offer/sponsorship/
 * salary/deadline/interview) is included per spec.
 */
const SALIENT_PATTERNS: RegExp[] = [
  // identity
  /\b(my name is|i am called|call me|i'm)\b/i,
  /\b(email|e-mail|phone|mobile|whatsapp|wechat)\b/i,
  /\b@[a-z0-9._-]+\.[a-z]{2,}\b/i, // raw email
  /\+?\d[\d\s().-]{6,}\d/, // phone-like
  // long-term goals — Adam domain
  /\b(offer|sponsorship|sponsor|salary|comp|compensation|deadline|interview|onsite|recruiter|h1b|visa)\b/i,
  // zh equivalents
  /(我叫|我的名字|我的邮箱|我的电话|我的手机)/,
  /(offer|签证|工资|薪资|年薪|面试|截止)/,
]

function autoSalience(content: string): number {
  const trimmed = content.trim()
  if (!trimmed) return 0
  for (const re of SALIENT_PATTERNS) {
    if (re.test(trimmed)) return 1
  }
  return 0
}

function recencyWeight(createdAtIso: string, nowMs: number): number {
  const t = Date.parse(createdAtIso)
  if (!Number.isFinite(t)) return 0
  const ageDays = Math.max(0, (nowMs - t) / DAY_MS)
  if (ageDays >= RECENCY_WINDOW_DAYS) return 0
  return 1 - ageDays / RECENCY_WINDOW_DAYS
}

function accessFreqWeight(accessCount: number | undefined): number {
  if (typeof accessCount !== "number" || !Number.isFinite(accessCount) || accessCount <= 0) return 0
  return Math.min(1, accessCount / ACCESS_SATURATION)
}

function salienceWeight(fact: MemoryFact): number {
  const explicit = fact.salience
  if (typeof explicit === "number" && Number.isFinite(explicit)) {
    if (explicit < 0) return 0
    if (explicit > 1) return 1
    return explicit
  }
  return autoSalience(fact.content)
}

export type RankedFact = {
  fact: MemoryFact
  score: number
  components: {
    recency: number
    access: number
    salience: number
  }
}

export function scoreFact(fact: MemoryFact, nowMs: number): RankedFact {
  const recency = recencyWeight(fact.createdAt, nowMs)
  const access = accessFreqWeight(fact.accessCount)
  const salience = salienceWeight(fact)
  const score = 0.5 * recency + 0.3 * access + 0.2 * salience
  return { fact, score, components: { recency, access, salience } }
}

/**
 * Rank `facts` by importance score, descending. Stable tiebreak:
 * higher `createdAt` first (newer wins on tie); then lexicographic `id`.
 * Returns a new array — does NOT mutate input.
 */
export function rankFactsByImportance(facts: MemoryFact[], nowMs: number): RankedFact[] {
  const ranked = facts.map((f) => scoreFact(f, nowMs))
  ranked.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    const ca = a.fact.createdAt ?? ""
    const cb = b.fact.createdAt ?? ""
    if (ca !== cb) return ca < cb ? 1 : -1 // newer first
    const ia = a.fact.id ?? ""
    const ib = b.fact.id ?? ""
    if (ia !== ib) return ia < ib ? -1 : 1
    return 0
  })
  return ranked
}
