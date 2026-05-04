/**
 * iter30 WS4-A — SkillIntentClassifier (Qwen-7B free-tier).
 *
 * LLM-driven multi-skill intent classifier for Claire. Top-K=3 skills
 * returned per call, confidence ≥0.6 cutoff, JSON-mode contract.
 *
 * Adam-locked constraints (discussion.md L1-58):
 *   - Free Qwen-7B (NOT V4-Flash) for intent
 *   - Regex floor only for crisis + obvious safety patterns
 *   - LLM holistic intent leads
 *   - Free-tier rate-limit handling: silent degradation, NO auto-failover
 *     to paid tier
 *
 * Hot-path budget:
 *   - Latency p99: ≤500ms
 *   - Hard timeout: 800ms → fail-open empty array
 *   - Cache: 5-min TTL on sha256(<lower-cased msg>::<userId>) hash
 *   - Fail-open path: empty array → router falls back to regex floor only
 *
 * Module surface (per ws-4a-detail.md §5.4):
 *   classifySkills({messageBody, ctx}, deps) → ClassifyResult
 *
 * Flag-gated by ctx.featureFlags.paSkillsLlmFallbackEnabled (default OFF
 * for iter30 ramp).
 */
import { createHash } from "node:crypto"
import OpenAI from "openai"
import { SKILL_KEYS, type SkillKey } from "@pa/agent-registry"
import type { ClaireContext } from "./run-context.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ClassifyInput = {
  messageBody: string
  ctx: ClaireContext
  /**
   * Optional skill catalog override — when supplied, the classifier uses
   * these `intentDescription` strings rather than the hard-coded fallback
   * for the existing 6 + WS4-B's 13. Allows hot-swapping descriptions via
   * Firestore without redeploying.
   */
  skillCatalog?: Array<{ key: SkillKey; intentDescription: string; llmInvokable: boolean }>
}

export type ClassifySkill = {
  key: SkillKey
  confidence: number
}

export type ClassifyResult = {
  skills: ClassifySkill[]
  rateLimited: boolean
  cacheHit: boolean
  latencyMs: number
  /** Reason / debug field; "ambiguous" when classifier returns empty. */
  reason: string
}

export type ClassifyDeps = {
  /** Returns model JSON output as a STRING (parser handles the rest). */
  llmCall?: (prompt: ClassifyPrompt, signal: AbortSignal) => Promise<string>
  cache?: ClassifierCache
  now?: () => number
  timeoutMs?: number
}

export type ClassifyPrompt = {
  systemPrompt: string
  userMessage: string
}

// ---------------------------------------------------------------------------
// Cache — in-memory LRU(2000 keys, 5-min TTL)
// ---------------------------------------------------------------------------

export interface ClassifierCache {
  get(key: string): ClassifyResult | undefined
  set(key: string, value: ClassifyResult): void
  size(): number
  clear(): void
}

const DEFAULT_TTL_MS = 5 * 60 * 1000
const DEFAULT_CAPACITY = 2000

class LRUCache implements ClassifierCache {
  private store = new Map<string, { value: ClassifyResult; expiresAt: number }>()
  constructor(
    private capacity = DEFAULT_CAPACITY,
    private ttlMs = DEFAULT_TTL_MS,
    private now: () => number = () => Date.now()
  ) {}
  get(key: string): ClassifyResult | undefined {
    const entry = this.store.get(key)
    if (!entry) return undefined
    if (entry.expiresAt < this.now()) {
      this.store.delete(key)
      return undefined
    }
    // LRU bump
    this.store.delete(key)
    this.store.set(key, entry)
    return entry.value
  }
  set(key: string, value: ClassifyResult): void {
    if (this.store.size >= this.capacity) {
      // Evict oldest
      const oldest = this.store.keys().next().value
      if (oldest !== undefined) this.store.delete(oldest)
    }
    this.store.set(key, { value, expiresAt: this.now() + this.ttlMs })
  }
  size(): number {
    return this.store.size
  }
  clear(): void {
    this.store.clear()
  }
}

let defaultCache: ClassifierCache | null = null
export function getDefaultClassifierCache(): ClassifierCache {
  if (!defaultCache) defaultCache = new LRUCache()
  return defaultCache
}

/** Test-only — drop the default cache. */
export function _clearClassifierCache(): void {
  defaultCache?.clear()
  defaultCache = null
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/**
 * Default skill catalog — fallback when no Firestore-loaded one is supplied.
 * Authoritative copy lives in EXISTING_6_METADATA + WS4-B's skill bodies.
 */
export const DEFAULT_SKILL_CATALOG: Array<{
  key: SkillKey
  intentDescription: string
  llmInvokable: boolean
}> = [
  {
    key: "headhunter",
    intentDescription:
      "Activate when user signals job search / role change / 在看工作 / on the market. NOT for emotional distress.",
    llmInvokable: true,
  },
  {
    key: "vent_support",
    intentDescription:
      "Activate when user expresses emotional distress, burnout, breakdown, anxiety. Do NOT activate when user is asking factual question or in upbeat mood.",
    llmInvokable: true,
  },
  {
    key: "motivation_nudge",
    intentDescription:
      "Activate when user signals procrastination, can't start, stuck, no motivation. Action-paralysis, NOT emotional overload.",
    llmInvokable: true,
  },
  {
    key: "jd_roast",
    intentDescription:
      "Activate when user shares a job description / asks for thoughts on a role / 帮我看 this JD. NOT general career chat.",
    llmInvokable: true,
  },
  {
    key: "interview_prep",
    intentDescription:
      "Activate when user mentions an upcoming interview, prep, nervousness about a specific round.",
    llmInvokable: true,
  },
  {
    key: "negotiation",
    intentDescription:
      "Activate when user is comparing offers, asking how much to ask, counter-offer, 谈薪.",
    llmInvokable: true,
  },
]

const RULES_SUFFIX = `Rules:
- Return EXACTLY this JSON shape: {"skills":[{"key":"<skillKey>","confidence":0.0-1.0}, ...], "reason":"<≤30 words>"}
- Max 3 skills. Confidence below 0.6 → exclude.
- If message is ambiguous / casual / out-of-scope → return {"skills":[],"reason":"ambiguous"}.
- NEVER invent skill keys. Use only the listed above.
- Bilingual zh+en — respect both.
- Crisis signals (suicide / self-harm) → DO NOT route here; regex floor handles those upstream.`

export function buildSystemPrompt(
  catalog: Array<{ key: SkillKey; intentDescription: string; llmInvokable: boolean }>
): string {
  const filtered = catalog.filter((c) => c.llmInvokable)
  const lines = [
    "You are a skill-intent classifier for Claire, a bilingual zh+en companion agent.",
    "Given a user message, return a JSON object listing the top-K=3 skills (by relevance)",
    "the message should activate, with confidence 0.0-1.0 each.",
    "",
    `Skills available (${filtered.length} total):`,
    "",
  ]
  filtered.forEach((c, i) => {
    lines.push(`${i + 1}. ${c.key} — ${c.intentDescription}`)
  })
  lines.push("")
  lines.push(RULES_SUFFIX)
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Default LLM call — Qwen-7B on SiliconFlow free tier
// ---------------------------------------------------------------------------

const DEFAULT_QWEN_MODEL = "Qwen/Qwen2.5-7B-Instruct"
let cachedClient: OpenAI | null = null
function getDefaultClient(): OpenAI {
  if (cachedClient) return cachedClient
  const apiKey =
    process.env.PA_SKILL_CLASSIFIER_API_KEY?.trim() ||
    process.env.SILICONFLOW_API_KEY?.trim() ||
    process.env.PA_LLM_REWRITE_API_KEY?.trim() ||
    ""
  const baseURL =
    process.env.PA_SKILL_CLASSIFIER_BASE_URL?.trim() ||
    "https://api.siliconflow.cn/v1"
  cachedClient = new OpenAI({ apiKey, baseURL })
  return cachedClient
}

async function defaultLlmCall(prompt: ClassifyPrompt, signal: AbortSignal): Promise<string> {
  const client = getDefaultClient()
  const model = process.env.PA_SKILL_CLASSIFIER_MODEL?.trim() || DEFAULT_QWEN_MODEL
  const resp = (await client.chat.completions.create(
    {
      model,
      temperature: 0.1, // determinism for classification
      max_tokens: 200, // ≤100 token output budget (json shape)
      messages: [
        { role: "system", content: prompt.systemPrompt },
        { role: "user", content: prompt.userMessage },
      ],
      response_format: { type: "json_object" },
    },
    { signal: signal as unknown as undefined } // OpenAI SDK accepts AbortSignal
  )) as { choices?: Array<{ message?: { content?: string | null } }> }
  return resp.choices?.[0]?.message?.content ?? ""
}

// ---------------------------------------------------------------------------
// Result parser — defensive against malformed JSON
// ---------------------------------------------------------------------------

const SKILL_KEY_SET = new Set<string>(SKILL_KEYS)

export function parseClassifierJson(raw: string): {
  skills: ClassifySkill[]
  reason: string
} {
  if (!raw || typeof raw !== "string") return { skills: [], reason: "empty-output" }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { skills: [], reason: "json-parse-error" }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { skills: [], reason: "json-shape-error" }
  }
  const obj = parsed as { skills?: unknown; reason?: unknown }
  const reason = typeof obj.reason === "string" ? obj.reason : ""
  if (!Array.isArray(obj.skills)) return { skills: [], reason: reason || "no-skills" }

  const skills: ClassifySkill[] = []
  for (const entry of obj.skills as unknown[]) {
    if (!entry || typeof entry !== "object") continue
    const e = entry as { key?: unknown; confidence?: unknown }
    const key = typeof e.key === "string" ? e.key : null
    const conf = typeof e.confidence === "number" ? e.confidence : -1
    if (!key || !SKILL_KEY_SET.has(key)) continue
    if (conf < 0.6 || conf > 1) continue
    skills.push({ key: key as SkillKey, confidence: conf })
    if (skills.length >= 3) break
  }
  return { skills, reason }
}

// ---------------------------------------------------------------------------
// Cache key builder
// ---------------------------------------------------------------------------

export function buildCacheKey(messageBody: string, userId: string): string {
  const norm = (messageBody ?? "").trim().toLowerCase()
  return createHash("sha256").update(`${userId}::${norm}`).digest("hex")
}

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

export async function classifySkills(
  input: ClassifyInput,
  deps: ClassifyDeps = {}
): Promise<ClassifyResult> {
  const now = deps.now ?? (() => Date.now())
  const t0 = now()
  const cache = deps.cache ?? getDefaultClassifierCache()
  const timeoutMs = deps.timeoutMs ?? 800
  const llmCall = deps.llmCall ?? defaultLlmCall

  const messageBody = (input.messageBody ?? "").trim()
  if (!messageBody) {
    return {
      skills: [],
      rateLimited: false,
      cacheHit: false,
      latencyMs: 0,
      reason: "empty-message",
    }
  }

  const cacheKey = buildCacheKey(messageBody, input.ctx.userId)
  const cached = cache.get(cacheKey)
  if (cached) {
    return { ...cached, cacheHit: true, latencyMs: now() - t0 }
  }

  const catalog = input.skillCatalog ?? DEFAULT_SKILL_CATALOG
  const systemPrompt = buildSystemPrompt(catalog)
  const userMessage = messageBody

  const controller = new AbortController()
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs)

  let raw = ""
  let rateLimited = false
  let reason = "ok"
  try {
    raw = await llmCall({ systemPrompt, userMessage }, controller.signal)
  } catch (err: unknown) {
    const message =
      err && typeof err === "object" && "message" in err
        ? String((err as { message: unknown }).message)
        : String(err)
    // Classify error — 429 / quota / rate-limited → set flag, fail-open empty array
    if (
      controller.signal.aborted ||
      /timeout|abort/i.test(message)
    ) {
      reason = "timeout"
    } else if (/429|rate.?limit|too many/i.test(message)) {
      rateLimited = true
      reason = "rate-limited"
    } else {
      reason = "llm-error"
    }
  } finally {
    clearTimeout(timeoutHandle)
  }

  const parsed = parseClassifierJson(raw)
  const result: ClassifyResult = {
    skills: parsed.skills,
    rateLimited,
    cacheHit: false,
    latencyMs: now() - t0,
    reason: reason === "ok" ? parsed.reason || "ok" : reason,
  }

  // Cache only successful (non-rate-limited, non-timeout) results — we want
  // retry-after-recovery behavior, not wedged-empty cache. Empty-skills
  // results from the model (genuine ambiguous) are fine to cache.
  if (!rateLimited && reason !== "timeout" && reason !== "llm-error") {
    cache.set(cacheKey, { ...result, cacheHit: false, latencyMs: 0 })
  }

  return result
}
