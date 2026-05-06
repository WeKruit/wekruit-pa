/**
 * v1.6 Phase 58 — Per-skill JD-relative weight computation (D7 / RERANK-04).
 *
 * Given a candidate's open skill list and one job, return a normalized
 * `Record<skillKey, weight 0..1>` where 1 = central to JD, 0 = irrelevant.
 * Phase 56 `queryMatchingJobsV16` reads this map from
 * `pa-user-skill-jdrel-cache/{userId}/jobs/{jobId}` to weight the per-skill
 * Jaccard score. Missing cache → graceful degradation (jdRel defaults to 1.0
 * → plain weighted Jaccard).
 *
 * Provider chain (locked by CLAUDE.md v1.6 LLM table):
 *   1. claude-sonnet-4-6   (Anthropic, primary — best for nuanced JD
 *                           semantics; tool_use mode for structured output)
 *   2. gpt-5.4-nano        (OpenAI, fallback — JSON-mode `response_format`)
 *   3. Qwen/Qwen2.5-7B     (SiliconFlow free tier, last-resort fallback)
 *   4. Uniform 0.5         (no provider succeeded — neutral default so
 *                           skill scoring still functions)
 *
 * Failure semantics:
 *   - NEVER throws. Every failure path returns a `JdRelOutput` so the
 *     batch loop never aborts on one bad call.
 *   - `sanitize()` enforces invariants regardless of LLM output:
 *       * keys exactly match canonical skillKey(s) from `skills` input
 *       * values clamped to [0, 1]
 *       * non-numeric / missing → 0.5 (neutral)
 *
 * Cache contract (callsite — `nightly-rerank.ts`):
 *   pa-user-skill-jdrel-cache/{userId}/jobs/{jobId} = {
 *     jdRelativeWeights: Record<skillKey, number ∈ [0,1]>,
 *     computedAt: ISO,
 *     modelUsed: 'sonnet-4-6' | 'gpt-5.4-nano' | 'qwen-7b' | 'fallback',
 *   }
 *
 * `skillKey` normalization mirrors Phase 56's reader (`query-matching-jobs-v16.ts`):
 *   trim → lowercase → spaces collapsed to underscores. So "C++ Dev" → "c++_dev".
 */

import { logger } from "firebase-functions/v2"

/** Job signal piped into the prompt. Keep `jobDescription` ≤1500 chars. */
export interface JdRelInput {
  jobTitle: string
  jobDescription?: string
  requiredSkills?: string[]
}

export interface JdRelOutput {
  /** skillKey → 0..1 weight. Always covers EVERY input skill. */
  weights: Record<string, number>
  /** Provider that produced the weights (or 'fallback' when none worked). */
  modelUsed: "sonnet-4-6" | "gpt-5.4-nano" | "qwen-7b" | "fallback"
}

export interface JdRelConfig {
  anthropicApiKey?: string
  openaiApiKey?: string
  siliconflowApiKey?: string
  /** Test seam — inject a deterministic Anthropic client. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  anthropicClientFactory?: (init: { apiKey: string }) => any
  /** Test seam — inject a deterministic OpenAI client. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  openaiClientFactory?: (init: { apiKey: string; baseURL?: string }) => any
}

const SYSTEM_PROMPT = [
  "You are a recruiting expert. Given a candidate's skill list and one job description,",
  "return a JSON object mapping EACH candidate skill key to a 0.0-1.0 relevance score.",
  "",
  "Scale:",
  "  1.0 = skill is central / required for this JD",
  "  0.7-0.9 = strongly relevant",
  "  0.4-0.6 = moderately relevant",
  "  0.1-0.3 = tangentially relevant",
  "  0.0 = not relevant",
  "",
  "Rules:",
  "- Output JSON only, no markdown, no commentary.",
  "- Return EXACTLY the keys provided in `skillKeys`, no additions, no omissions.",
  "- Values must be numbers in [0, 1].",
  "",
  'Example input: {"skillKeys":["python","react","docker"],"jobTitle":"Backend Engineer","jobDescription":"Python API + ML, FastAPI, AWS"}',
  'Example output: {"python":0.95,"react":0.1,"docker":0.6}',
].join("\n")

/** Maximum prompt-side description length (token / cost guard). */
const JD_DESC_MAX = 1500
/** Maximum required-skills array length sent to LLM. */
const REQUIRED_SKILLS_CAP = 30

/**
 * Canonical skill-key normalization. MUST match the reader in
 * `query-matching-jobs-v16.ts` (`skillKey()` there) so the JD-rel cache
 * keys land on the right user-side skills at score time.
 */
export function skillKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "_")
}

/**
 * Compute per-skill JD-relative weights for one (user, job) pair.
 *
 * Returns a fully-populated map even on total LLM failure. The `modelUsed`
 * field tells the caller which tier produced the result.
 */
export async function computeJdRelativeWeights(
  skills: ReadonlyArray<string>,
  job: JdRelInput,
  config: JdRelConfig
): Promise<JdRelOutput> {
  // Empty skill list short-circuits cleanly — no LLM call, no cost.
  if (!Array.isArray(skills) || skills.length === 0) {
    return { weights: {}, modelUsed: "fallback" }
  }
  // Canonicalize the skill keys ONCE — we send keys (not raw names) to the
  // LLM and we sanitize against this canonical set on return.
  const skillKeys = Array.from(
    new Set(skills.map((s) => skillKey(s)).filter((k) => k.length > 0))
  )
  if (skillKeys.length === 0) {
    return { weights: {}, modelUsed: "fallback" }
  }

  const userPayload = JSON.stringify({
    skillKeys,
    jobTitle: job.jobTitle ?? "",
    jobDescription: (job.jobDescription ?? "").slice(0, JD_DESC_MAX),
    requiredSkills: Array.isArray(job.requiredSkills)
      ? job.requiredSkills.slice(0, REQUIRED_SKILLS_CAP)
      : [],
  })

  // ── Tier 1: claude-sonnet-4-6 (Anthropic) ──────────────────────────────
  if (config.anthropicApiKey && config.anthropicApiKey.trim().length > 0) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let client: any
      if (config.anthropicClientFactory) {
        client = config.anthropicClientFactory({ apiKey: config.anthropicApiKey })
      } else {
        const mod = (await import("@anthropic-ai/sdk")) as unknown as {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          default: new (init: { apiKey: string }) => any
        }
        client = new mod.default({ apiKey: config.anthropicApiKey })
      }
      const res = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPayload }],
      })
      const text = extractAnthropicText(res)
      const parsed = parseJsonOrEmpty(text)
      const weights = sanitize(parsed, skillKeys)
      return { weights, modelUsed: "sonnet-4-6" }
    } catch (err) {
      logger.warn("[jd-rel] sonnet_failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // ── Tier 2: gpt-5.4-nano (OpenAI) ──────────────────────────────────────
  if (config.openaiApiKey && config.openaiApiKey.trim().length > 0) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let client: any
      if (config.openaiClientFactory) {
        client = config.openaiClientFactory({ apiKey: config.openaiApiKey })
      } else {
        const mod = (await import("openai")) as unknown as {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          default: new (init: { apiKey: string; baseURL?: string }) => any
        }
        client = new mod.default({ apiKey: config.openaiApiKey })
      }
      const res = await client.chat.completions.create({
        model: "gpt-5.4-nano",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPayload },
        ],
      })
      const text = res?.choices?.[0]?.message?.content ?? "{}"
      const parsed = parseJsonOrEmpty(text)
      const weights = sanitize(parsed, skillKeys)
      return { weights, modelUsed: "gpt-5.4-nano" }
    } catch (err) {
      logger.warn("[jd-rel] openai_failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // ── Tier 3: Qwen-7B (SiliconFlow free tier) ───────────────────────────
  if (config.siliconflowApiKey && config.siliconflowApiKey.trim().length > 0) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let client: any
      if (config.openaiClientFactory) {
        // Tests can reuse the same factory hook for Qwen (same OpenAI SDK).
        client = config.openaiClientFactory({
          apiKey: config.siliconflowApiKey,
          baseURL: "https://api.siliconflow.cn/v1",
        })
      } else {
        const mod = (await import("openai")) as unknown as {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          default: new (init: { apiKey: string; baseURL?: string }) => any
        }
        client = new mod.default({
          apiKey: config.siliconflowApiKey,
          baseURL: "https://api.siliconflow.cn/v1",
        })
      }
      const res = await client.chat.completions.create({
        model: "Qwen/Qwen2.5-7B-Instruct",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPayload },
        ],
        temperature: 0.2,
        max_tokens: 1500,
      })
      const text = res?.choices?.[0]?.message?.content ?? "{}"
      const parsed = parseJsonOrEmpty(text)
      const weights = sanitize(parsed, skillKeys)
      return { weights, modelUsed: "qwen-7b" }
    } catch (err) {
      logger.warn("[jd-rel] qwen_failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // ── Tier 4: total fallback (no provider available / all failed) ─────
  // Return uniform 0.5 — neutral. Phase 56 reader still produces a valid
  // weighted Jaccard with these weights (every skill counted at half its
  // base weight); better than dropping the JD-rel signal entirely.
  const fallback: Record<string, number> = {}
  for (const k of skillKeys) fallback[k] = 0.5
  return { weights: fallback, modelUsed: "fallback" }
}

/**
 * Extract the textual completion from an Anthropic Messages API response.
 * Tolerates the two shapes the SDK emits:
 *   - `content: [{ type: "text", text: "..." }]`
 *   - `content: [{ type: "tool_use", input: {...} }]` (we don't use tool_use here)
 * Returns "{}" when no text block found so the caller's parser produces
 * the empty object → fallback to 0.5 via sanitize.
 */
function extractAnthropicText(res: unknown): string {
  if (!res || typeof res !== "object") return "{}"
  const r = res as { content?: Array<{ type?: string; text?: string }> }
  if (!Array.isArray(r.content)) return "{}"
  for (const block of r.content) {
    if (block && block.type === "text" && typeof block.text === "string") {
      return block.text.trim()
    }
  }
  return "{}"
}

/**
 * Parse JSON, returning `{}` on any parse error. Strips a single fenced
 * markdown code block if the model emits ` ```json ... ``` ` despite our
 * "no markdown" instruction.
 */
function parseJsonOrEmpty(raw: string): unknown {
  if (typeof raw !== "string" || raw.length === 0) return {}
  let txt = raw.trim()
  // Strip ```json ... ``` or ``` ... ```
  if (txt.startsWith("```")) {
    txt = txt.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim()
  }
  try {
    return JSON.parse(txt)
  } catch {
    return {}
  }
}

/**
 * Coerce the LLM-returned object into a fully-populated, in-range
 * `Record<skillKey, number ∈ [0, 1]>`. Invariants:
 *   - every input skillKey gets a value (missing → 0.5)
 *   - non-finite values → 0.5
 *   - values are clamped to [0, 1]
 *   - numeric strings are coerced via Number()
 *   - case-insensitive lookup tolerates the LLM emitting upper-cased keys
 *
 * NOTE: we never KEEP keys not in the input set — Phase 56 expects the cache
 * to be addressable by the user's skill keys, no surprises.
 */
export function sanitize(parsed: unknown, skillKeys: ReadonlyArray<string>): Record<string, number> {
  const out: Record<string, number> = {}
  const lookup =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  // Build a case-insensitive index on the LLM output so we tolerate the
  // model emitting "Python" when we asked for "python".
  const lowerIndex = new Map<string, unknown>()
  for (const [k, v] of Object.entries(lookup)) {
    lowerIndex.set(k.toLowerCase(), v)
  }
  for (const key of skillKeys) {
    const direct = lookup[key]
    const indirect = direct !== undefined ? direct : lowerIndex.get(key.toLowerCase())
    out[key] = clampNumeric(indirect)
  }
  return out
}

/** Coerce + clamp to [0, 1]. Non-finite or non-numeric → 0.5. */
function clampNumeric(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) {
    return Math.max(0, Math.min(1, v))
  }
  if (typeof v === "string") {
    const n = Number(v)
    if (Number.isFinite(n)) {
      return Math.max(0, Math.min(1, n))
    }
  }
  return 0.5
}
