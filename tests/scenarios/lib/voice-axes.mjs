/**
 * Phase 18 — voice eval rubric helpers (harness-only).
 *
 * Phase 33 (v1.4 humanize-runtime) extends this module with 4 new axes
 * (drift_resistance, length_compliance, advice_novelty, strategy_fit) +
 * deterministic helpers used by Phase 35 detectors. The legacy 4-axis
 * `VOICE_AXES` export is kept untouched for back-compat (judge.mjs reads
 * it). New work consumes `VOICE_AXES_V2` (8 entries: 4 legacy + 4 new).
 */

import { countSentences, withinSentenceCap } from "./sentence-split.mjs"
import { maxSimilarityVsHistory } from "./embed-sim.mjs"

export const passThreshold = 2.4

export const FILLER_BLACKLIST_ZH = [
  "好的，我记住了",
  "好的, 我记住了",
  "收到",
  "没问题，我会记得",
  "下次我会注意",
  "已记录",
  "让我帮你梳理一下",
  "需要注意的是",
  "需要提醒的是",
  "这点很重要",
  "让我们一起",
  "我帮你梳理一下",
  "还有什么可以帮你",
  "作为 AI",
  "我是 AI",
  "我是您的 AI",
  // Phase 21 — pop-therapy + invented-category leakage from prod screenshot
  // 2026-04-27. nano keeps emitting "接住你 / 硬撑着 / 喘不过气那种" etc.
  // despite Bible v5; auto-fail in eval so regressions are caught.
  "接住你",
  "找个人接住",
  "硬撑着",
  "硬扛",
  "喘不过气那种",
  "那种吧",
  "这条路我懂",
  "这种路我懂",
  "续命型",
  "腻型",
  "扛着型",
]

export const FILLER_BLACKLIST_EN = [
  "It's important to",
  "It's crucial to",
  "It's essential to",
  "It's worth noting",
  "Remember,",
  "Keep in mind",
  "That's a tough one",
  "That's a tough spot",
  "Sounds like a tricky situation",
  "I'll remember that",
  "Got it",
  "Of course",
  "I'd be happy to help",
  "Is there anything else",
  "As an AI",
  "I'm an AI",
  // Phase 21 — en-side pop-therapy register
  "I see you",
  "you got this fr",
  "hold space",
  "make space for",
]

export const VOICE_AXES = [
  {
    id: "warmth_no_sycophancy",
    name: "Warmth without sycophancy",
    scale: [0, 3],
    rubric: {
      0: "Sycophantic (e.g. great question!)",
      1: "Warm but slightly performative",
      2: "Warm + grounded",
      3: "Warm, grounded, willing to disagree",
    },
  },
  {
    id: "in_character_voice",
    name: "Claire / 小柯 register",
    scale: [0, 3],
    rubric: {
      0: "Generic assistant",
      1: "Partial Claire",
      2: "Claire register, minor slip",
      3: "Full Claire (Bible tics + code-switch + sparse signature emoji)",
    },
  },
  {
    id: "no_robot_filler",
    name: "No robot filler",
    scale: [0, 3],
    rubric: {
      0: "Blacklist phrase or auto-fail",
      1: "Scaffold but no exact match",
      2: "Mostly clean",
      3: "Zero filler, flows",
    },
  },
  {
    id: "length_appropriateness",
    name: "Length appropriateness",
    scale: [0, 3],
    rubric: {
      0: ">3 sentences chit-chat OR too terse for tech-deep",
      1: "~1.5x ideal",
      2: "Within ~1.2x ideal",
      3: "Exact for situation",
    },
  },
]

/**
 * Phase 21 — clinical "X 还是 Y" multiple-choice detector.
 *
 * Real friends ask one open question. nano keeps defaulting to A/B framework
 * questions ("躺一会儿还是接着扛？", "工作这边还是生活那边?") despite Bible
 * v5. Catch the structural pattern, not just the phrase.
 *
 * Heuristic: a line ending in `?` or `？` that contains `还是` (zh) or
 * ` or ` (en) close to the question mark, AND is at least 4 chars before
 * the connector. We scope to question-bearing lines so we don't false-fire
 * on declarative "A 还是 B 都行".
 */
const AB_FRAMEWORK_RE_ZH = /[^?？\n]{2,}还是[^?？\n]{1,}[?？]/
const AB_FRAMEWORK_RE_EN = /\b\w+[\w ]{1,}\bor\b[\w ]{1,}\?/i
export function checkABFramework(text) {
  if (AB_FRAMEWORK_RE_ZH.test(text)) {
    return { hit: true, pattern: "zh_X_还是_Y_question" }
  }
  if (AB_FRAMEWORK_RE_EN.test(text)) {
    return { hit: true, pattern: "en_X_or_Y_question" }
  }
  return { hit: false }
}

/**
 * @returns {{ hit: boolean, phrase?: string, lang?: 'zh'|'en'|'structural' }}
 */
export function checkFillerBlacklist(text) {
  const lower = text.toLowerCase()
  for (const phrase of FILLER_BLACKLIST_ZH) {
    if (text.includes(phrase)) return { hit: true, phrase, lang: "zh" }
  }
  for (const phrase of FILLER_BLACKLIST_EN) {
    if (lower.includes(phrase.toLowerCase())) return { hit: true, phrase, lang: "en" }
  }
  const ab = checkABFramework(text)
  if (ab.hit) return { hit: true, phrase: ab.pattern, lang: "structural" }
  return { hit: false }
}

/** Markdown / list markers that should not reach iMessage (Phase 20). */
export function checkIMessageRenderUnsafe(text) {
  if (/\*\*.+?\*\*/.test(text)) return { hit: true, reason: "markdown_bold" }
  if (/\[.+?\]\(.+?\)/.test(text)) return { hit: true, reason: "markdown_link" }
  if (/`/.test(text)) return { hit: true, reason: "backtick" }
  if (/^[\-\*][ \t]/m.test(text)) return { hit: true, reason: "markdown_list" }
  return { hit: false }
}

// ---------------------------------------------------------------------------
// Phase 33 — VOICE_AXES_V2 (8 axes total: 4 legacy + 4 new humanize-runtime)
//
// New axes target the 4 production failure modes the v1.4 milestone is
// attacking. LLM-judge integer 0-3 with explicit rubric for each score,
// matching the legacy 4-axis pattern so judge.mjs can score all 8 in a
// single tool-call.
//
// Helpers are deterministic floats with their own native ranges; the
// LLM-judge axis is the canonical numeric for `voice_axes_full` scenarios,
// while the deterministic helpers feed Phase 35 detectors and the runner's
// `voiceAxesAggregate` block.
// ---------------------------------------------------------------------------

export const VOICE_AXES_V2 = [
  ...VOICE_AXES,
  {
    id: "drift_resistance",
    name: "Drift resistance (F1 mirror + F4 repeat)",
    scale: [0, 3],
    rubric: {
      0: "Mirrors user's verbs verbatim AND/OR repeats prior advice ≥3 times in window",
      1: "Visible mirror or visible repeat at least once",
      2: "Mostly fresh phrasing, mild echo",
      3: "No verb-mirror, no advice-repeat across window",
    },
  },
  {
    id: "length_compliance",
    name: "Length compliance (≤3-sentence cap)",
    scale: [0, 3],
    rubric: {
      0: "≥50% of turns exceed the 3-sentence cap",
      1: "20-50% of turns exceed cap",
      2: "≤20% of turns exceed cap",
      3: "Zero turns exceed the cap",
    },
  },
  {
    id: "advice_novelty",
    name: "Advice novelty (BGE-M3 cos-sim < 0.85 vs last 3 Claire turns)",
    scale: [0, 3],
    rubric: {
      0: "Repeats prior advice almost verbatim (cos-sim ≥ 0.85)",
      1: "Heavy paraphrase of prior advice (0.70-0.85)",
      2: "Mild echo of prior framing (0.50-0.70)",
      3: "Genuinely new advice or new angle (cos-sim < 0.50)",
    },
  },
  {
    id: "strategy_fit",
    name: "Strategy fit (ESConv 8-strategy ∈ allowed-set per stage)",
    scale: [0, 3],
    rubric: {
      0: "Chosen strategy outside allowed set for the current ESConv stage",
      1: "On-set but mistimed (e.g. Suggestion in Exploration)",
      2: "On-set and stage-appropriate",
      3: "Optimal TransESC continuity (smooth from prev strategy)",
    },
  },
]

// ---------------------------------------------------------------------------
// Length compliance — deterministic helper (HARNESS-04 + Phase 35 F2 preview).
// ---------------------------------------------------------------------------

/**
 * Compute % of Claire turns within the sentence cap.
 *
 * @param {Array<{ assistant?: string, reply?: string }>} turns
 * @param {{ cap?: number }} [opts]
 * @returns {{ compliance: number, withinCap: number, total: number, overCapTurns: number[] }}
 */
export function computeLengthCompliance(turns, opts = {}) {
  const cap = opts.cap ?? 3
  if (!Array.isArray(turns) || turns.length === 0) {
    return { compliance: 1, withinCap: 0, total: 0, overCapTurns: [] }
  }
  const overCapTurns = []
  let withinCap = 0
  for (let i = 0; i < turns.length; i++) {
    const text = turns[i]?.assistant ?? turns[i]?.reply ?? ""
    if (typeof text !== "string" || text.length === 0) continue
    if (withinSentenceCap(text, cap)) withinCap += 1
    else overCapTurns.push(i)
  }
  const total = turns.length
  return {
    compliance: total === 0 ? 1 : withinCap / total,
    withinCap,
    total,
    overCapTurns,
  }
}

// ---------------------------------------------------------------------------
// Drift resistance — deterministic helper (F1 mirror n-gram + F4 repeat preview).
// Pure-text mirror score (no embed) so it can run without an API key.
// `repeatRatio` requires embed-sim; if unavailable, returns null for the
// repeat half and computes drift from mirror only.
// ---------------------------------------------------------------------------

function isCjkChar(ch) {
  const code = ch.codePointAt(0)
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x3000 && code <= 0x303f)
  )
}

function detectLang(text) {
  if (typeof text !== "string" || text.length === 0) return "en"
  let cjk = 0, ascii = 0
  for (const ch of text) {
    if (isCjkChar(ch)) cjk += 1
    else if (ch.charCodeAt(0) < 128) ascii += 1
  }
  return cjk > ascii ? "zh" : "en"
}

function charNgrams(text, n) {
  if (typeof text !== "string") return new Set()
  const out = new Set()
  for (let i = 0; i + n <= text.length; i++) {
    out.add(text.slice(i, i + n))
  }
  return out
}

function wordBigrams(text) {
  if (typeof text !== "string") return new Set()
  const words = text.toLowerCase().split(/[^\p{L}\p{N}']+/u).filter(Boolean)
  const out = new Set()
  for (let i = 0; i + 2 <= words.length; i++) {
    out.add(`${words[i]} ${words[i + 1]}`)
  }
  return out
}

/**
 * Jaccard overlap between two ngram sets, ignoring empty sets.
 */
function jaccardOverlap(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter += 1
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

/**
 * Mirror ratio between Claire's reply and the user's preceding turn.
 * zh: char 3-gram. en: word bigram. Mixed text: detect majority lang.
 *
 * @param {string} userText
 * @param {string} claireText
 * @returns {number}  0..1
 */
export function computeMirrorRatio(userText, claireText) {
  if (!userText || !claireText) return 0
  const lang = detectLang(claireText)
  if (lang === "zh") {
    return jaccardOverlap(charNgrams(userText, 3), charNgrams(claireText, 3))
  }
  return jaccardOverlap(wordBigrams(userText), wordBigrams(claireText))
}

/**
 * Drift score over a transcript window.
 *
 * @param {Array<{ user?: string, assistant?: string, reply?: string }>} turns
 *   Ordered ASC. Each turn = one Claire reply (with its preceding user msg).
 * @param {{ window?: number }} [opts]
 * @returns {Promise<{
 *   driftScore: number,
 *   mirrorMax: number,
 *   mirrorAvg: number,
 *   repeatMax: number | null,
 *   samples: number,
 * }>}
 */
export async function computeDriftScore(turns, opts = {}) {
  const window = opts.window ?? 5
  if (!Array.isArray(turns) || turns.length < 2) {
    return { driftScore: 0, mirrorMax: 0, mirrorAvg: 0, repeatMax: null, samples: 0 }
  }
  const recent = turns.slice(-window)
  const claireTexts = recent.map((t) => t.assistant ?? t.reply ?? "").filter(Boolean)

  // Mirror half — pure text, no network
  const mirrorRatios = []
  for (const t of recent) {
    const u = t.user ?? ""
    const c = t.assistant ?? t.reply ?? ""
    if (u && c) mirrorRatios.push(computeMirrorRatio(u, c))
  }
  const mirrorMax = mirrorRatios.length ? Math.max(...mirrorRatios) : 0
  const mirrorAvg = mirrorRatios.length
    ? mirrorRatios.reduce((s, v) => s + v, 0) / mirrorRatios.length
    : 0

  // Repeat half — needs embed-sim; tolerate null env gracefully
  let repeatMax = null
  if (claireTexts.length >= 2) {
    try {
      const last = claireTexts[claireTexts.length - 1]
      const prior = claireTexts.slice(0, -1)
      const r = await maxSimilarityVsHistory(last, prior)
      repeatMax = r ? r.maxSim : null
    } catch {
      repeatMax = null
    }
  }

  // 0.5 * mirrorAvg + 0.5 * repeatMax (when repeat available); else mirrorAvg
  const driftScore =
    repeatMax === null
      ? Math.min(1, mirrorAvg)
      : Math.min(1, 0.5 * mirrorAvg + 0.5 * repeatMax)

  return {
    driftScore,
    mirrorMax,
    mirrorAvg,
    repeatMax,
    samples: claireTexts.length,
  }
}

// ---------------------------------------------------------------------------
// Advice novelty — deterministic helper (BGE-M3 cos-sim, async).
// ---------------------------------------------------------------------------

/**
 * Score how novel `currentReply` is vs `lastClaireTurns` (oldest first).
 * Returns `null` when env missing (caller records "skipped").
 *
 * @param {string} currentReply
 * @param {string[]} lastClaireTurns
 * @returns {Promise<{ noveltyScore: number, maxSim: number, mostSimilarIdx: number, sims: number[] }|null>}
 */
export async function computeAdviceNovelty(currentReply, lastClaireTurns) {
  if (typeof currentReply !== "string" || currentReply.length === 0) return null
  const history = Array.isArray(lastClaireTurns) ? lastClaireTurns.filter((t) => typeof t === "string" && t.length > 0) : []
  if (history.length === 0) {
    return { noveltyScore: 1, maxSim: 0, mostSimilarIdx: -1, sims: [] }
  }
  const r = await maxSimilarityVsHistory(currentReply, history)
  if (!r) return null
  return {
    noveltyScore: Math.max(0, 1 - r.maxSim),
    maxSim: r.maxSim,
    mostSimilarIdx: r.mostSimilarIdx,
    sims: r.sims,
  }
}

// ---------------------------------------------------------------------------
// Strategy fit — ESConv 8 strategies + 3-stage allowed-sets.
// Keyword-priority classifier; LLM-judge axis is the canonical 0-3.
// ---------------------------------------------------------------------------

export const ESCONV_STRATEGIES = [
  "Question",
  "Restatement",
  "Reflection",
  "SelfDisclosure",
  "Affirmation",
  "Suggestion",
  "Information",
  "Other",
]

export const STRATEGY_KEYWORDS_ZH = {
  Question: ["？", "怎么", "什么", "为什么", "吗", "呢"],
  Restatement: ["你是说", "你的意思", "所以你"],
  Reflection: ["听起来", "感觉", "肯定", "一定", "看上去"],
  SelfDisclosure: ["我以前", "我也", "我之前", "我当年", "我也是"],
  Affirmation: ["这是合理的", "没事的", "这很正常", "你已经", "已经做得"],
  Suggestion: ["可以试", "不妨", "要不", "建议", "试试"],
  Information: [],
  Other: [],
}

export const STRATEGY_KEYWORDS_EN = {
  Question: ["?", "how ", "what ", "why ", "where ", "when "],
  Restatement: ["so you", "you said", "you mean", "you're saying"],
  Reflection: ["sounds like", "feels like", "must be", "that's hard"],
  SelfDisclosure: ["i once", "i had", "when i", "i remember", "i've been"],
  Affirmation: ["you got", "that's valid", "makes sense", "totally fair"],
  Suggestion: ["try ", "could ", "maybe try", "what if you"],
  Information: [],
  Other: [],
}

/**
 * ESConv 3-stage allowed strategy sets (from thu-coai paper §3.2).
 * Stage indices: 0=Exploration, 1=Comforting, 2=Action.
 */
export const ESCONV_STAGE_ALLOWED = [
  new Set(["Question", "Restatement", "Reflection"]),
  new Set(["Reflection", "Affirmation", "SelfDisclosure"]),
  new Set(["Suggestion", "Information", "Affirmation"]),
]

/**
 * Map a 1-indexed turn number to ESConv stage index per the paper:
 *   turns 1-3  → Exploration (0)
 *   turns 4-7  → Comforting  (1)
 *   turns 8+   → Action      (2)
 */
export function stageForTurn(turnNumber) {
  if (turnNumber <= 3) return 0
  if (turnNumber <= 7) return 1
  return 2
}

/**
 * Keyword-priority classifier. Walks zh keyword bank first, then en. The
 * first hit wins. If nothing matches → Information (factual default) for
 * non-question text, Other for very short.
 *
 * @param {string} reply
 * @returns {{ strategy: string, confidence: number, matchedKeyword: string|null }}
 */
export function inferStrategy(reply) {
  if (typeof reply !== "string" || reply.trim().length === 0) {
    return { strategy: "Other", confidence: 0, matchedKeyword: null }
  }
  const text = reply.trim()
  const lower = text.toLowerCase()
  // zh first
  for (const strat of ESCONV_STRATEGIES) {
    const kws = STRATEGY_KEYWORDS_ZH[strat] ?? []
    for (const kw of kws) {
      if (text.includes(kw)) {
        return { strategy: strat, confidence: 0.7, matchedKeyword: kw }
      }
    }
  }
  // en
  for (const strat of ESCONV_STRATEGIES) {
    const kws = STRATEGY_KEYWORDS_EN[strat] ?? []
    for (const kw of kws) {
      if (lower.includes(kw)) {
        return { strategy: strat, confidence: 0.6, matchedKeyword: kw }
      }
    }
  }
  // Fallback: short = Other; longer = Information
  if (text.length < 8) return { strategy: "Other", confidence: 0.3, matchedKeyword: null }
  return { strategy: "Information", confidence: 0.4, matchedKeyword: null }
}

/**
 * @param {string} strategy
 * @param {number} stageIdx  - 0..2
 * @returns {boolean}
 */
export function isAllowedStrategy(strategy, stageIdx) {
  const set = ESCONV_STAGE_ALLOWED[Math.max(0, Math.min(2, stageIdx))]
  return set.has(strategy)
}
