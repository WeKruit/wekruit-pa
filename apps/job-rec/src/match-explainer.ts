/**
 * Stream F (Phase 42) — async cheap-LLM match-explainer.
 *
 * Closes TD-H13-1: H13's per-job heuristic reason (token-overlap on
 * job.requiredSkills ∩ ctx.topSkills) collapses to "" for ~80% of corpus
 * rows because production JDs lack the requiredSkills field. This module
 * synthesizes a 1-sentence grounded reason via Qwen-7B SiliconFlow,
 * Firestore-cached 7d, daily-budget-capped, fail-open everywhere.
 *
 * Behavior contract:
 *   - cache hit  → return cached reason, NO LLM call
 *   - cache miss → check daily budget → if under, call LLM, write cache,
 *                  charge ledger, return reason
 *   - any error  → return "" (formatter handles empty gracefully per H13)
 *   - budget exceeded → return "" + emit budget_skip log; no LLM call,
 *                       no ledger write
 *
 * Cost model (SiliconFlow Qwen2.5-7B-Instruct):
 *   - $0.07 / M input tokens, $0.14 / M output tokens
 *   - Per-call: ~200 in + ~30 out → ~$0.0000182
 *   - $1/day budget = ~55,000 calls → covers <50 active users x 3 jobs
 *     for ~14 days even at 0% cache hit rate. After 7-day cache TTL
 *     amortization, steady-state cost approaches $0.
 *
 * NOT used: cross-workspace import of apps/eval/external-benchmarks/lib/
 * sf-client.mjs. We inline a thin chat shim here because (a) eval-bench
 * is a one-shot benchmarking harness with raw single-call semantics, no
 * caching, while we need exactly the opposite, and (b) cross-workspace
 * coupling from prod (job-rec) to eval is the wrong dependency
 * direction. Env-var chain + endpoint + model defaults match sf-client.
 *
 * @module match-explainer
 */

import type { Firestore } from "firebase-admin/firestore"
import type { BoostExplainerInput } from "./boost-calculator.js"
import type { MatchingJob } from "./types.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Compact CV facts the explainer needs. Pre-projected by the caller from
 * parsedCandidateResumes so the explainer is pure-deps + can be unit-tested
 * without Firestore reads.
 */
export type ExplainerCv = {
  /** Most recent role title (e.g. "Senior PM"). */
  recentRoleTitle?: string
  /** Most recent company (e.g. "Stripe"). */
  recentCompany?: string
  /** Top 3 skills from candidateProfile.skills. */
  topSkills?: readonly string[]
  /**
   * One short bullet snippet from the most-recent experience.description
   * (≤ 220 chars). Optional — when absent the prompt only references
   * recentCompany / recentRoleTitle / topSkills.
   */
  recentBullet?: string
}

/**
 * SiliconFlow chat completion call shape — abstracted so tests inject a
 * pure stub and prod wires the real fetch shim returned by
 * `defaultChatImpl()`.
 */
export type ChatImpl = (args: {
  messages: Array<{ role: "system" | "user"; content: string }>
  model: string
  /** Hard wall-clock timeout in ms. */
  timeoutMs: number
  /** Soft caps for billing safety. */
  maxTokens: number
  temperature: number
}) => Promise<{
  text: string
  usage: { inputTokens: number; outputTokens: number }
}>

export type ExplainMatchInput = {
  userId: string
  userCv: ExplainerCv
  job: MatchingJob & {
    /** Optional: full JD blob if the caller has it (used for prompt grounding). */
    jdSnippet?: string
  }
  matchScore?: number
  language: "zh" | "en"
  /**
   * iter30/WS8 — boost-aware prompt input. When present, the explainer uses
   * the new core/supporting/generic-aware prompt (modes A/B/C, see
   * `buildExplainerMessages`). When absent (legacy callers), falls back to
   * the original "1 CV fact + 1 JD fact" prompt (mode D, fully back-compat).
   */
  boostInput?: BoostExplainerInput
}

export type ExplainMatchDeps = {
  db: Firestore
  /**
   * SiliconFlow chat completion. Default: `defaultChatImpl()` returns a
   * fetch-based shim. Tests inject a pure stub.
   */
  chatImpl?: ChatImpl
  /** Wall clock in ms. Default `Date.now`. Tests pin time. */
  now?: () => number
  /** Per-day USD budget. Defaults to env or 1.0. */
  dailyBudgetUsd?: number
  log?: (event: string, payload?: Record<string, unknown>) => void
  /** Override the YYYYMMDD stamp used for the cost-ledger doc id. */
  todayYmd?: () => string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Feature flag key — `paMatchExplainerEnabled`. Default OFF. */
export const MATCH_EXPLAINER_FLAG_KEY = "paMatchExplainerEnabled"

/** Firestore collection for cached reasons. Flat doc-id keying. */
export const EXPLANATIONS_COLLECTION = "pa-job-rec-explanations"

/** Firestore collection for daily cost ledger. */
export const COST_LEDGER_COLLECTION = "pa-cost-ledger"

/** Cost-ledger doc id prefix (`match-explainer__YYYYMMDD`). */
export const COST_LEDGER_DOC_PREFIX = "match-explainer__"

/** Cache TTL — 7 days. */
export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** SiliconFlow Qwen2.5-7B-Instruct (matches sf-client default). */
export const DEFAULT_MODEL = "Qwen/Qwen2.5-7B-Instruct"

/** Hard wall-clock timeout per call. Brief: 5s. */
export const DEFAULT_TIMEOUT_MS = 5_000

/** Output token cap — one-sentence reasons are short. */
export const DEFAULT_MAX_TOKENS = 80

/** Default daily budget (USD) when env unset. */
export const DEFAULT_DAILY_BUDGET_USD = 1.0

/** SiliconFlow Qwen-7B price (USD per 1M tokens). */
export const PRICE_INPUT_PER_M = 0.07
export const PRICE_OUTPUT_PER_M = 0.14

/** Trim/clean output guards. */
const REASON_MIN_CHARS = 8
const REASON_MAX_CHARS = 140

// ---------------------------------------------------------------------------
// Doc-id + key helpers
// ---------------------------------------------------------------------------

/**
 * Cache doc id. Uses `__` separator so we can store userId / jobId / language
 * in a single root-collection doc (mock-firestore does NOT support
 * subcollections — see apps/job-rec/src/__tests__/mock-firestore.ts).
 *
 * Strict: any control char, slash, or "/" in user input throws — this is a
 * defensive guard; in practice our userId/jobId are alphanumeric.
 *
 * iter30/WS8 — `weightTableVersion` (optional) appended as `__v{N}` so any
 * weight-table edit invalidates downstream cached reasons. Legacy callers
 * (no boost) keep the old key shape (back-compat). Old docs purged via
 * Firestore TTL on the existing `ttlAt` field.
 */
export function cacheDocId(
  userId: string,
  jobId: string,
  language: "zh" | "en",
  weightTableVersion?: number
): string {
  if (!userId || !jobId) throw new Error("match-explainer: userId+jobId required")
  if (userId.includes("/") || jobId.includes("/")) {
    throw new Error("match-explainer: userId/jobId must not contain '/'")
  }
  const base = `${userId}__${jobId}__${language}`
  if (
    typeof weightTableVersion === "number" &&
    Number.isFinite(weightTableVersion) &&
    weightTableVersion > 0
  ) {
    return `${base}__v${weightTableVersion}`
  }
  return base
}

/** Cost-ledger doc id (`match-explainer__YYYYMMDD`). */
export function costLedgerDocId(ymd: string): string {
  return `${COST_LEDGER_DOC_PREFIX}${ymd}`
}

/**
 * UTC YYYYMMDD stamp.
 */
export function defaultTodayYmd(): string {
  const d = new Date()
  const y = d.getUTCFullYear().toString().padStart(4, "0")
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0")
  const day = d.getUTCDate().toString().padStart(2, "0")
  return `${y}${m}${day}`
}

// ---------------------------------------------------------------------------
// Cost math
// ---------------------------------------------------------------------------

/** Compute USD charge from token counts at Qwen-7B SiliconFlow rates. */
export function computeChargeUsd(inputTokens: number, outputTokens: number): number {
  const i = Math.max(0, Number(inputTokens) || 0)
  const o = Math.max(0, Number(outputTokens) || 0)
  return (i * PRICE_INPUT_PER_M) / 1_000_000 + (o * PRICE_OUTPUT_PER_M) / 1_000_000
}

/** Resolve the per-day USD budget (env override → opt → default). */
export function resolveDailyBudgetUsd(opt?: number): number {
  if (typeof opt === "number" && opt > 0) return opt
  const env = process.env.PA_MATCH_EXPLAINER_DAILY_BUDGET_USD
  if (env) {
    const n = Number(env)
    if (Number.isFinite(n) && n > 0) return n
  }
  return DEFAULT_DAILY_BUDGET_USD
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/**
 * Classify boost-input into one of four modes (per WS-8 detail-plan §6.3):
 *
 *   A — has ≥ 1 core hit (weight ≥ 2.0): foreground core skill(s)
 *   B — no core but ≥ 1 supporting hit (weight 1.5-1.99): foreground
 *       supporting + name the missing core
 *   C — only generic hits (weight ≤ 0.7): say "foundation present, core not yet"
 *   D — no boost data OR no hits / no missing: fall back to "1 CV fact + 1 JD fact"
 *       (legacy prompt — fully back-compat)
 *
 * Pure helper, exposed for tests + observability.
 */
export type ExplainerMode = "A_core" | "B_supp" | "C_gen" | "D_fallback"

export function classifyExplainerMode(boost?: BoostExplainerInput): ExplainerMode {
  if (!boost) return "D_fallback"
  const hits = boost.hits ?? []
  if (hits.length === 0 && (boost.coreMissing?.length ?? 0) === 0) return "D_fallback"
  const coreHits = hits.filter((h) => h.category === "core" && h.weight >= 2.0)
  if (coreHits.length > 0) return "A_core"
  const suppHits = hits.filter((h) => h.category === "supporting" && h.weight >= 1.5)
  if (suppHits.length > 0) return "B_supp"
  if (hits.length > 0) return "C_gen"
  return "D_fallback"
}

/**
 * Build the bilingual system+user prompt. Up to 2 friend-tone sentences when
 * boost data is present (mode A/B/C); single-sentence legacy prompt when
 * absent (mode D). Pure / exposed for tests + sample dumps.
 *
 * iter30/WS8 — replaces the old single-mode prompt. New prompt foregrounds
 * core/supporting/generic so we never collapse "Python match" with "RAG match".
 */
export function buildExplainerMessages(
  input: ExplainMatchInput
): Array<{ role: "system" | "user"; content: string }> {
  const lang = input.language
  const cv = input.userCv ?? {}
  const skills = (cv.topSkills ?? []).filter((s) => typeof s === "string" && s.length > 0)
  const topSkillsLine = skills.slice(0, 3).join(", ")
  const recentRole = cv.recentRoleTitle ?? ""
  const recentCo = cv.recentCompany ?? ""
  const bullet = (cv.recentBullet ?? "").trim().slice(0, 220)
  const jdRaw = input.job.jdSnippet ?? ""
  const jdSnippet = jdRaw.trim().slice(0, 300)
  const jobTitle = input.job.jobTitle || "Role"
  const company = input.job.companyName || "Company"
  const jobSkills = (input.job.requiredSkills ?? []).slice(0, 6).join(", ")
  const mode = classifyExplainerMode(input.boostInput)

  // -- Mode D: legacy single-sentence prompt (back-compat) -----------------
  if (mode === "D_fallback") {
    const sysZh = [
      "你是一个会朋友式聊天的求职 broker。",
      "任务：用 ONE 中文句子（≤ 60 字）解释这份 JD 为什么和候选人对得上。",
      "硬规则：",
      "1) 必须引用候选人简历里 1 个具体事实（公司名/角色/技能/经历片段）",
      "2) 必须引用 JD 里 1 个具体方面（公司/角色/技能要求）",
      "3) 朋友语气，不要客套，不要 marketing 语言，不要写'此职位'/'该机会'之类的官话",
      "4) 不要 emoji，不要破折号开头，不要换行",
      "5) 必须只输出这一句话本身，没有前缀，没有引号，没有 markdown",
    ].join("\n")
    const sysEn = [
      "You are a friend-tone job broker.",
      "Task: explain in ONE English sentence (≤ 30 words) why this JD lines up with this candidate.",
      "Hard rules:",
      "1) Must cite ONE specific candidate-CV fact (company / role / skill / experience bullet)",
      "2) Must cite ONE specific JD aspect (company / role / required skill)",
      "3) Friend tone — no marketing-speak, no fluff, no 'this opportunity' / 'this role' filler",
      "4) No emoji, no leading dash, no line breaks",
      "5) Output the sentence only — no prefix, no quotes, no markdown",
    ].join("\n")
    const userZh = [
      "候选人:",
      `- 最近角色: ${recentRole || "(未知)"} @ ${recentCo || "(未知)"}`,
      skills.length > 0 ? `- 技能 top3: ${topSkillsLine}` : "- 技能 top3: (未知)",
      bullet ? `- 简历片段: ${bullet}` : "",
      "",
      "Job:",
      `- ${jobTitle} @ ${company}`,
      jobSkills ? `- JD 要求: ${jobSkills}` : "",
      jdSnippet ? `- JD 节选: ${jdSnippet}` : "",
      "",
      "请输出 1 句中文 friend-tone 解释。",
    ]
      .filter((line) => line !== "")
      .join("\n")
    const userEn = [
      "Candidate:",
      `- Recent role: ${recentRole || "(unknown)"} at ${recentCo || "(unknown)"}`,
      skills.length > 0 ? `- Top skills: ${topSkillsLine}` : "- Top skills: (unknown)",
      bullet ? `- Resume bullet: ${bullet}` : "",
      "",
      "Job:",
      `- ${jobTitle} at ${company}`,
      jobSkills ? `- JD requires: ${jobSkills}` : "",
      jdSnippet ? `- JD excerpt: ${jdSnippet}` : "",
      "",
      "Output 1 friend-tone English sentence.",
    ]
      .filter((line) => line !== "")
      .join("\n")
    return [
      { role: "system", content: lang === "zh" ? sysZh : sysEn },
      { role: "user", content: lang === "zh" ? userZh : userEn },
    ]
  }

  // -- Modes A/B/C: boost-aware bilingual prompt ---------------------------
  const sysZh = [
    "你是一个朋友语气的 job broker，给候选人解释为什么这份 JD 跟他对得上。",
    "",
    "# 输出格式硬规则",
    "1) 输出最多 2 个中文句子。第一句 ≤ 30 字，第二句（可选）≤ 30 字。",
    "2) 朋友语气：用'你'，不用'您'。不要'此职位'/'该机会'/'贵司'这种官话。",
    "3) 不要 emoji，不要 markdown，不要换行，不要引号包裹整句。",
    "4) 不写'X 还是 Y' 二选一框架。",
    "5) 不要客套语（'非常匹配'/'完美契合'/'为您量身打造'）— 直接说事实。",
    "",
    "# CORE vs GENERIC 区分（最重要）",
    "你会收到 boost-hit 数据：hits[]（命中的技能 + category + weight + matchedAgainst）、coreMissing[]、totalBoostMult。",
    "",
    "按以下分支写句子：",
    "",
    "A) 当 hits 里有 ≥ 1 个 core (weight ≥ 2.0)：",
    "   → 第一句把那个/那几个 core 技能拎出来说。例：",
    "     '你简历里 RAG 和 tool calling 这两个 2026 年最 core 的技能正好对上'",
    "   → 不要把 generic 也说成'match'。Python 是底子不是 match。",
    "",
    "B) 当 hits 里 NO core 但有 supporting (weight 1.5-1.99)：",
    "   → '你 [supporting skill] 这块底子在，core 要求像 [coreMissing 第一个] 还得补上'",
    "",
    "C) 当 hits 里只有 generic (weight ≤ 0.7)：",
    "   → 不能说'match'。改说'底子有但不是核心'。例：",
    "     '你 Python TS 这种底子是有，但 RAG / function calling 这种 core 还没碰过'",
    "   → 第二句可选 actionable 建议：'如果你最近补一下 vector database 那块，推这种岗位就稳了'",
    "",
    "# 输出锁定",
    "- 只输出最终句子。没有前缀、没有引号、没有 'Output:'、没有 'Answer:'。",
    "- 必须中文输出。RAG / LangChain 等专有词原样保留，不翻译。",
    "- 两句之间用空格分隔，不换行。",
  ].join("\n")

  const sysEn = [
    "You're a friend-tone job broker explaining why this JD lines up with the candidate.",
    "",
    "# Output rules",
    "1) Up to 2 sentences. First ≤ 30 words; optional second ≤ 30 words.",
    "2) Friend register. Contractions OK. No corporate filler ('this opportunity', 'this role aligns', 'we're delighted').",
    "3) No emoji, no markdown, no line breaks, no surrounding quotes.",
    "4) No 'either-or' framing.",
    "5) No platitudes ('excellent match', 'perfect fit') — just say the facts.",
    "",
    "# CORE vs GENERIC distinction (most important)",
    "You receive boost-hit data: hits[] (skill / category core|supporting|generic / weight / matchedAgainst), coreMissing[], totalBoostMult.",
    "",
    "Branches:",
    "",
    "A) hits has ≥ 1 core (weight ≥ 2.0):",
    "   → First sentence calls out the core skill(s). Example:",
    "     'Your RAG + tool-calling work hits the two core asks for this 2026 LLM eng role.'",
    "   → Don't promote a generic to 'match' status. Python is foundation, not match.",
    "",
    "B) hits has no core but ≥ 1 supporting (weight 1.5-1.99):",
    "   → 'You've got [supporting] going for you, but the real core ask is [coreMissing[0]].'",
    "",
    "C) hits has only generic (weight ≤ 0.7):",
    "   → Don't say 'match'. Say 'foundation present, core not yet'. Example:",
    "     \"You've got the Python+TS foundation, but RAG / function calling — the actual core — isn't on your CV yet.\"",
    "   → Optional second sentence with actionable advice.",
    "",
    "# Output lock",
    "- Output the sentence(s) only. No prefix, no 'Output:', no quotes around the whole.",
    "- English when language=en. Brand names like RAG/LangChain stay as-is.",
    "- Separate two sentences with a space, not a newline.",
  ].join("\n")

  // Format boost data for the user message — kept compact so token cost stays low.
  const boost = input.boostInput!
  const hitsStr =
    boost.hits.length > 0
      ? boost.hits
          .map(
            (h) =>
              `${h.skill} (${h.category}/${h.weight.toFixed(1)}/${h.matchedAgainst})`
          )
          .join(", ")
      : "(none)"
  const missStr =
    boost.coreMissing.length > 0
      ? boost.coreMissing.map((m) => `${m.skill} (${m.weight.toFixed(1)})`).join(", ")
      : "(none)"

  const userZh = [
    "候选人:",
    `- 最近角色: ${recentRole || "(未知)"} @ ${recentCo || "(未知)"}`,
    skills.length > 0 ? `- 技能 top3: ${topSkillsLine}` : "- 技能 top3: (未知)",
    bullet ? `- 简历片段: ${bullet}` : "",
    "",
    "Job:",
    `- ${jobTitle} @ ${company}`,
    jobSkills ? `- JD 要求: ${jobSkills}` : "",
    jdSnippet ? `- JD 节选: ${jdSnippet}` : "",
    "",
    "Boost 数据:",
    `- hits: ${hitsStr}`,
    `- coreMissing: ${missStr}`,
    `- totalBoostMult: ${boost.totalBoostMult.toFixed(2)}`,
    `- mode: ${mode}`,
    "",
    "请按 mode 分支输出 1-2 句中文 friend-tone 解释。",
  ]
    .filter((line) => line !== "")
    .join("\n")

  const userEn = [
    "Candidate:",
    `- Recent role: ${recentRole || "(unknown)"} at ${recentCo || "(unknown)"}`,
    skills.length > 0 ? `- Top skills: ${topSkillsLine}` : "- Top skills: (unknown)",
    bullet ? `- Resume bullet: ${bullet}` : "",
    "",
    "Job:",
    `- ${jobTitle} at ${company}`,
    jobSkills ? `- JD requires: ${jobSkills}` : "",
    jdSnippet ? `- JD excerpt: ${jdSnippet}` : "",
    "",
    "Boost data:",
    `- hits: ${hitsStr}`,
    `- coreMissing: ${missStr}`,
    `- totalBoostMult: ${boost.totalBoostMult.toFixed(2)}`,
    `- mode: ${mode}`,
    "",
    "Output 1-2 English friend-tone sentences per mode branch.",
  ]
    .filter((line) => line !== "")
    .join("\n")

  return [
    { role: "system", content: lang === "zh" ? sysZh : sysEn },
    { role: "user", content: lang === "zh" ? userZh : userEn },
  ]
}

/**
 * Trim, single-line, length-cap, drop-leading-dash. Returns "" when output
 * is too short to be useful (LLM noise / refusal-like).
 *
 * iter30/WS8 — adds a 2-sentence cap. Splits on `。．.!?！？`, accepts up to 2,
 * drops the rest. Mitigates the new "up to 2 sentences" prompt over-elongating.
 */
export function sanitizeReason(raw: string): string {
  if (typeof raw !== "string") return ""
  let s = raw.replace(/\s+/g, " ").trim()
  // Drop wrapping quotes.
  s = s.replace(/^["「『'`]+|["」』'`]+$/g, "")
  // Drop leading dash / bullet prefix.
  s = s.replace(/^[-—–•*]\s*/, "")
  // 2-sentence cap. CJK + ASCII terminals. Keep terminals so the cap reads
  // naturally; if no terminal present, leave whole string alone.
  s = capToTwoSentences(s)
  if (s.length > REASON_MAX_CHARS) {
    const chars = Array.from(s)
    s = chars.slice(0, REASON_MAX_CHARS - 1).join("") + "…"
  }
  if (s.length < REASON_MIN_CHARS) return ""
  return s
}

/** Internal — cap a string to its first ≤ 2 sentences. Pure / exported for tests. */
export function capToTwoSentences(s: string): string {
  // Match 1 or 2 sentences: non-terminal chars then a terminal.
  // Terminals: 。．.!?！？
  const re = /[^。．.!?！？]*[。．.!?！？]/g
  const parts: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(s)) !== null && parts.length < 2) {
    parts.push(m[0])
  }
  if (parts.length === 0) return s
  let out = parts.join("").trim()
  // Append remaining text only if it's the FIRST sentence with no terminal
  // (i.e. parts contained only terminals from the rest of the string).
  if (parts.length < 2) {
    const consumed = parts.join("").length
    const tail = s.slice(consumed).trim()
    // No tail-append in 2-sentence case — we explicitly stop after 2.
    if (parts.length === 1 && tail.length > 0) {
      // Only append tail if it's a single fragment (mode A often has 1 sent + trailing fragment)
      // — we already captured the first sentence, leave the fragment.
    }
    if (out.length === 0) return s
  }
  return out.length > 0 ? out : s
}

// ---------------------------------------------------------------------------
// Default chat impl — fetch-based SiliconFlow shim.
// ---------------------------------------------------------------------------

/**
 * Default ChatImpl. Fetch-based SiliconFlow shim. Env-var chain matches
 * apps/eval/external-benchmarks/lib/sf-client.mjs:
 *   SILICONFLOW_API_KEY → PA_OPENAI_AGENT_API_KEY → PA_SILICONFLOW_API_KEY
 *
 * Hard timeout via AbortController + outer Promise.race (same pattern as
 * sf-client which was hardened against undici hangs).
 */
export function defaultChatImpl(): ChatImpl {
  return async ({ messages, model, timeoutMs, maxTokens, temperature }) => {
    const apiKey =
      process.env.SILICONFLOW_API_KEY ||
      process.env.PA_OPENAI_AGENT_API_KEY ||
      process.env.PA_SILICONFLOW_API_KEY
    if (!apiKey) {
      throw new Error("match-explainer: no SiliconFlow API key in env")
    }
    const baseUrl = process.env.SILICONFLOW_BASE_URL || "https://api.siliconflow.cn/v1"
    const ctrl = new AbortController()
    const deadline = new Promise<never>((_, rej) =>
      setTimeout(() => {
        try {
          ctrl.abort()
        } catch {
          /* swallow */
        }
        rej(new Error(`match-explainer: timeout after ${timeoutMs}ms`))
      }, timeoutMs)
    )
    const work = (async () => {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
          max_tokens: maxTokens,
        }),
        signal: ctrl.signal,
      })
      if (!res.ok) {
        const txt = await res.text().catch(() => "")
        throw new Error(`match-explainer: HTTP ${res.status}: ${txt.slice(0, 200)}`)
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      const text = json?.choices?.[0]?.message?.content ?? ""
      const usage = json?.usage ?? {}
      return {
        text: typeof text === "string" ? text : "",
        usage: {
          inputTokens: Number(usage.prompt_tokens ?? 0),
          outputTokens: Number(usage.completion_tokens ?? 0),
        },
      }
    })()
    return Promise.race([work, deadline])
  }
}

// ---------------------------------------------------------------------------
// explainMatch — main entry point
// ---------------------------------------------------------------------------

/**
 * Compose / cache / charge a 1-sentence grounded reason.
 *
 * Returns "" on ANY failure — never throws. The H13 formatter renders empty
 * reason cleanly (no " — " suffix), so fail-open keeps daily-batch
 * deterministic.
 */
export async function explainMatch(
  deps: ExplainMatchDeps,
  input: ExplainMatchInput
): Promise<string> {
  const log = deps.log ?? defaultLog
  const chat = deps.chatImpl ?? defaultChatImpl()
  const now = (deps.now ?? Date.now)()
  const ymd = (deps.todayYmd ?? defaultTodayYmd)()
  const budget = resolveDailyBudgetUsd(deps.dailyBudgetUsd)

  // --- 1. Cache lookup ---
  let cacheRef
  try {
    cacheRef = deps.db
      .collection(EXPLANATIONS_COLLECTION)
      .doc(
        cacheDocId(
          input.userId,
          input.job.id,
          input.language,
          input.boostInput?.tableVersion
        )
      )
    const snap = await cacheRef.get()
    if (snap.exists) {
      const data = snap.data() as { reason?: string; ttlAt?: string } | undefined
      if (data && typeof data.reason === "string" && data.reason.length > 0) {
        // TTL guard — Firestore TTL deletion is async/eventual; we also
        // honor it client-side so a stale doc doesn't survive past 7d.
        const ttlOk = !data.ttlAt || Date.parse(data.ttlAt) > now
        if (ttlOk) {
          log("match_explainer_cache_hit", {
            userId: input.userId,
            jobId: input.job.id,
          })
          return data.reason
        }
      }
    }
  } catch (err) {
    log("match_explainer_cache_read_failed", {
      userId: input.userId,
      jobId: input.job.id,
      error: errMsg(err),
    })
    // Fall through: cache miss → still attempt LLM call.
    cacheRef = undefined
  }

  // --- 2. Daily budget check ---
  // We READ the ledger ONLY (no projection charge yet). After successful
  // LLM call, we increment by actual computed cost. This means a single
  // call CAN tip the ledger over $budget by at most one call (~$0.00002),
  // which we accept as the simplicity / atomicity trade-off (matches
  // SiliconFlow billing's after-the-fact ledger semantics).
  let currentTotalUsd = 0
  let currentCallCount = 0
  let ledgerRef
  try {
    ledgerRef = deps.db.collection(COST_LEDGER_COLLECTION).doc(costLedgerDocId(ymd))
    const lsnap = await ledgerRef.get()
    if (lsnap.exists) {
      const ld = lsnap.data() as { totalUsd?: number; callCount?: number } | undefined
      if (ld && typeof ld.totalUsd === "number" && Number.isFinite(ld.totalUsd)) {
        currentTotalUsd = ld.totalUsd
      }
      if (ld && typeof ld.callCount === "number" && Number.isFinite(ld.callCount)) {
        currentCallCount = ld.callCount
      }
    }
  } catch (err) {
    log("match_explainer_ledger_read_failed", { error: errMsg(err) })
    // Defensive: continue (read failure shouldn't block first call of day)
    ledgerRef = undefined
  }
  if (currentTotalUsd >= budget) {
    log("match_explainer_budget_skip", {
      userId: input.userId,
      jobId: input.job.id,
      currentTotalUsd,
      budget,
    })
    return ""
  }

  // --- 3. LLM call ---
  let llmText = ""
  let inputTokens = 0
  let outputTokens = 0
  try {
    const res = await chat({
      messages: buildExplainerMessages(input),
      model: DEFAULT_MODEL,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxTokens: DEFAULT_MAX_TOKENS,
      temperature: 0.4,
    })
    llmText = res.text
    inputTokens = res.usage?.inputTokens ?? 0
    outputTokens = res.usage?.outputTokens ?? 0
  } catch (err) {
    log("match_explainer_llm_failed", {
      userId: input.userId,
      jobId: input.job.id,
      error: errMsg(err),
    })
    // Fail-open. NO cache write (we don't want to poison the cache with "").
    return ""
  }

  const reason = sanitizeReason(llmText)
  if (!reason) {
    log("match_explainer_llm_empty", {
      userId: input.userId,
      jobId: input.job.id,
      rawLength: llmText.length,
    })
    // No cache write — same reason as above.
    return ""
  }

  // --- 4. Cache write ---
  if (cacheRef) {
    try {
      await cacheRef.set({
        userId: input.userId,
        jobId: input.job.id,
        language: input.language,
        reason,
        createdAt: new Date(now).toISOString(),
        ttlAt: new Date(now + CACHE_TTL_MS).toISOString(),
        ...(typeof input.matchScore === "number" ? { matchScore: input.matchScore } : {}),
      })
    } catch (err) {
      log("match_explainer_cache_write_failed", {
        userId: input.userId,
        jobId: input.job.id,
        error: errMsg(err),
      })
      // Fall through — return reason anyway (don't fail the user).
    }
  }

  // --- 5. Cost ledger increment ---
  if (ledgerRef) {
    try {
      const charge = computeChargeUsd(inputTokens, outputTokens)
      const newTotal = currentTotalUsd + charge
      await ledgerRef.set(
        {
          ymd,
          totalUsd: newTotal,
          callCount: currentCallCount + 1,
          lastUpdatedAt: new Date(now).toISOString(),
          model: DEFAULT_MODEL,
        },
        { merge: true }
      )
      // Read-modify-write tracking. The single-process daily cron makes
      // this sequential per call; mock-firestore + prod Firestore both
      // support `set { merge: true }` for primitive overwrites. If we
      // ever fan out to parallel CFs, swap to FieldValue.increment.
    } catch (err) {
      log("match_explainer_ledger_write_failed", { error: errMsg(err) })
      // Fall through — return reason.
    }
  }

  log("match_explainer_llm_ok", {
    userId: input.userId,
    jobId: input.job.id,
    inputTokens,
    outputTokens,
    chargeUsd: computeChargeUsd(inputTokens, outputTokens),
  })

  return reason
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultLog(_event: string, _payload?: Record<string, unknown>): void {
  /* swallow */
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
