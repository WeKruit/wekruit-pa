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
 */
export function cacheDocId(userId: string, jobId: string, language: "zh" | "en"): string {
  if (!userId || !jobId) throw new Error("match-explainer: userId+jobId required")
  if (userId.includes("/") || jobId.includes("/")) {
    throw new Error("match-explainer: userId/jobId must not contain '/'")
  }
  return `${userId}__${jobId}__${language}`
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
 * Build the bilingual system+user prompt. ONE sentence, friend tone,
 * grounded in BOTH a CV fact and a JD fact.
 *
 * Pure / exposed for tests + sample dumps.
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

/**
 * Trim, single-line, length-cap, drop-leading-dash. Returns "" when output
 * is too short to be useful (LLM noise / refusal-like).
 */
export function sanitizeReason(raw: string): string {
  if (typeof raw !== "string") return ""
  let s = raw.replace(/\s+/g, " ").trim()
  // Drop wrapping quotes.
  s = s.replace(/^["「『'`]+|["」』'`]+$/g, "")
  // Drop leading dash / bullet prefix (Bible v7.5.2 — the formatter adds
  // its own " — " separator; LLM-leading dashes confuse the line).
  s = s.replace(/^[-—–•*]\s*/, "")
  if (s.length > REASON_MAX_CHARS) {
    // Truncate on a CJK-aware char boundary; Array.from handles surrogate pairs.
    const chars = Array.from(s)
    s = chars.slice(0, REASON_MAX_CHARS - 1).join("") + "…"
  }
  if (s.length < REASON_MIN_CHARS) return ""
  return s
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
      .doc(cacheDocId(input.userId, input.job.id, input.language))
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
