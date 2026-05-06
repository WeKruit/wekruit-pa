/**
 * v1.7 Phase 64 — Visa-sponsorship inference helper.
 *
 * Two-tier inference for `matching-jobs.sponsorship` (boolean | null):
 *
 *   Tier 1 — Allowlist lookup (fast, 0 cost, deterministic).
 *     Read `pa-sponsorship-allowlist/{company-slug}` Firestore doc.
 *     Slug = `companyName.toLowerCase().trim()`. Hit → return immediately
 *     with `confidence: doc.confidence ?? 1.0`, `source: 'allowlist'`.
 *     Miss → fall through to LLM JD inference.
 *
 *   Tier 2 — LLM JD inference (Sonnet → gpt-5.4-nano → Qwen-7B fallback chain).
 *     Prompt is explicit: ONLY return `true` on explicit "H-1B"/"visa
 *     sponsorship"/"sponsors visas"/"will sponsor"; ONLY return `false` on
 *     explicit denial ("no visa sponsorship"/"unable to sponsor"/"not sponsoring");
 *     else `null`. We never fabricate from soft signals (e.g. "must be authorized
 *     to work in US" → null, not false).
 *
 *   Tier 3 — All providers fail / no keys → `{sponsorship: null, source:
 *     'all_failed', confidence: 0}`. Caller should keep null in Firestore so
 *     v1.6 graceful filter (`sponsor_needed × null = KEEP`) does the right
 *     thing — no underrecommendation from inference failure.
 *
 * Adam directive (CLAUDE.md v1.6 D4 + Phase 64 spec): never set `false`
 * unless the JD literally says it. Underrecommending sponsor_needed users by
 * blanket-falsing unknown jobs is worse than recommending a few non-sponsoring
 * jobs they'll filter out manually.
 *
 * Provider order rationale:
 *   1. claude-sonnet-4-6  — best at nuance; not all "sponsor" mentions are
 *      sponsorship offers (e.g. "we sponsor athletes" / "race sponsor").
 *      Sonnet handles negation + context cleanly.
 *   2. gpt-5.4-nano       — JSON-mode response_format, cheap fallback.
 *   3. Qwen2.5-7B         — SiliconFlow free tier last-resort.
 *
 * Cost / latency budget:
 *   - Allowlist hit: 1 Firestore read, ~20ms, $0.
 *   - LLM tier: ~$0.01-0.02/job (gpt-5.4-nano), 1-3s. Sonnet ~$0.05/job.
 *   - Backfill 1944 active jobs: ~$20-40 one-time (allowlist absorbs ~30%).
 *
 * NEVER throws. Every failure path returns a clean `SponsorshipOutput` so
 * the backfill loop never aborts on one bad call.
 *
 * @module sponsorship-inference
 */

import type { Firestore } from "firebase-admin/firestore"
import { logger } from "firebase-functions/v2"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SponsorshipInput {
  jobTitle: string
  companyName?: string | null
  jobDescription?: string | null
}

export type SponsorshipSource =
  | "allowlist"
  | "jd_inference"
  | "jd_inference_fallback"
  | "all_failed"
  | "no_input"

export interface SponsorshipOutput {
  /**
   * `true`  — explicit JD/allowlist evidence the company sponsors.
   * `false` — explicit denial in JD ("no visa sponsorship") OR explicit
   *           non-sponsor allowlist row (rare; defense contractors etc).
   * `null`  — unknown. Caller MUST persist null (don't fabricate). v1.6 V16
   *           filter then keeps the job for `sponsor_needed` users (graceful).
   */
  sponsorship: boolean | null
  source: SponsorshipSource
  /** 0..1. 1.0 for high-confidence allowlist; LLM-emitted for inference. */
  confidence: number
  /** ≤200 chars. Why this verdict — for audit trail. */
  reasoning: string
}

export interface SponsorshipConfig {
  db: Firestore
  openaiApiKey?: string
  anthropicApiKey?: string
  siliconflowApiKey?: string
  /** Test seam — inject a deterministic Anthropic client. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  anthropicClientFactory?: (init: { apiKey: string }) => any
  /** Test seam — inject a deterministic OpenAI / SiliconFlow client. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  openaiClientFactory?: (init: { apiKey: string; baseURL?: string }) => any
  /** Test seam — bypass Firestore allowlist read (return value or null). */
  allowlistOverride?: (slug: string) => Promise<AllowlistEntry | null>
}

/**
 * Shape stored at `pa-sponsorship-allowlist/{company-slug}`.
 * Mirror of `apps/functions/data/sponsorship-allowlist.json` rows.
 */
export interface AllowlistEntry {
  company: string
  sponsorship: boolean
  source: string
  confidence: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALLOWLIST_COLLECTION = "pa-sponsorship-allowlist"
/** Cap JD prompt length to stay under token budgets across providers. */
const JD_PROMPT_MAX = 2000
/** ≤ this length on the audit-trail reasoning string. */
const REASONING_MAX_LEN = 200

const SYSTEM_PROMPT = [
  "You are a recruiting compliance assistant. Read a job posting and decide ONE thing:",
  "does the JD EXPLICITLY state the employer offers (or refuses) visa sponsorship?",
  "",
  "Output STRICT JSON, schema:",
  '{"sponsorship": true | false | null, "confidence": <float 0..1>, "reasoning": "<one short sentence>"}',
  "",
  "Rules — read carefully:",
  "1. true   ONLY when JD explicitly mentions sponsorship as offered: e.g. 'H-1B sponsorship available',",
  "          'we sponsor visas', 'visa sponsorship offered', 'will sponsor', 'open to sponsoring'.",
  "2. false  ONLY when JD explicitly denies sponsorship: e.g. 'no visa sponsorship',",
  "          'unable to sponsor', 'not sponsoring at this time', 'will not sponsor'.",
  "3. null   in EVERY OTHER CASE, including:",
  "          - JD silent on visa/sponsorship",
  "          - JD says 'must be authorized to work in US' (this is NOT a denial; many sponsors say this)",
  "          - JD mentions sponsorship in OTHER context (sponsor athletes, sponsor an event)",
  "          - ambiguous wording ('we may consider sponsorship for exceptional candidates')",
  "",
  "DO NOT infer from company name alone — only from EXPLICIT JD statements.",
  "DO NOT fabricate. When in doubt → null.",
  "",
  "confidence: 1.0 = JD verbatim states it; 0.7 = paraphrase but unambiguous; 0.3 = weak signal; 0 = pure guess.",
  "If sponsorship is null, confidence should be 0.0.",
  "",
  "reasoning: ≤200 chars, one sentence, quote JD phrasing if applicable.",
  "",
  "Output JSON only. No markdown. No prose.",
].join("\n")

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Slug a company name for allowlist lookup. Mirrors the seed-script writer:
 *   trim → lowercase → collapse multiple whitespace → preserve everything else.
 *
 * Examples:
 *   "Google"            → "google"
 *   "  J.P. Morgan  "  → "j.p. morgan"
 *   "TCS\t\n"          → "tcs"
 *
 * Don't aggressively strip punctuation — "j.p. morgan" and "jpmorgan" are
 * intentionally separate allowlist entries.
 */
export function companySlug(name: string | null | undefined): string {
  if (!name || typeof name !== "string") return ""
  return name.trim().toLowerCase().replace(/\s+/g, " ")
}

/**
 * Look up an allowlist entry by slug. Returns null on miss / read error.
 * Read errors are logged but never throw — caller falls through to LLM tier.
 */
async function lookupAllowlist(
  db: Firestore,
  slug: string,
  override?: SponsorshipConfig["allowlistOverride"]
): Promise<AllowlistEntry | null> {
  if (!slug) return null
  if (override) {
    try {
      return await override(slug)
    } catch (err) {
      logger.warn("[sponsorship] allowlist_override_failed", {
        error: err instanceof Error ? err.message : String(err),
      })
      return null
    }
  }
  try {
    const snap = await db.collection(ALLOWLIST_COLLECTION).doc(slug).get()
    if (!snap.exists) return null
    const data = snap.data() ?? {}
    if (typeof data.sponsorship !== "boolean") return null
    return {
      company: typeof data.company === "string" ? data.company : slug,
      sponsorship: data.sponsorship,
      source: typeof data.source === "string" ? data.source : "allowlist",
      confidence: typeof data.confidence === "number" ? data.confidence : 1.0,
    }
  } catch (err) {
    logger.warn("[sponsorship] allowlist_read_failed", {
      slug,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * Infer sponsorship for one job. Allowlist first, LLM JD inference second,
 * graceful null on total failure.
 */
export async function inferSponsorship(
  input: SponsorshipInput,
  config: SponsorshipConfig
): Promise<SponsorshipOutput> {
  // Empty input → graceful null. No-op.
  if (!input || typeof input !== "object" || !input.jobTitle || typeof input.jobTitle !== "string") {
    return {
      sponsorship: null,
      source: "no_input",
      confidence: 0,
      reasoning: "missing jobTitle",
    }
  }

  // ── Tier 1: Allowlist ─────────────────────────────────────────────────
  const slug = companySlug(input.companyName)
  if (slug) {
    const entry = await lookupAllowlist(config.db, slug, config.allowlistOverride)
    if (entry) {
      return {
        sponsorship: entry.sponsorship,
        source: "allowlist",
        confidence: clampUnit(entry.confidence ?? 1.0),
        reasoning: truncate(
          `allowlist match (${entry.source}): company '${entry.company}' → ${
            entry.sponsorship ? "known sponsor" : "known non-sponsor"
          }`
        ),
      }
    }
  }

  // ── Tier 2: LLM JD inference (Sonnet → OpenAI → Qwen) ─────────────────
  const userPayload = JSON.stringify({
    jobTitle: input.jobTitle.slice(0, 200),
    companyName: typeof input.companyName === "string" ? input.companyName.slice(0, 200) : "",
    jobDescription: typeof input.jobDescription === "string" ? input.jobDescription.slice(0, JD_PROMPT_MAX) : "",
  })

  // Tier 2a: Anthropic Sonnet
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
        max_tokens: 500,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPayload }],
      })
      const text = extractAnthropicText(res)
      const parsed = parseSponsorshipJson(text)
      if (parsed.ok) {
        return finalize(parsed.value, "jd_inference")
      }
      logger.warn("[sponsorship] sonnet_unparseable", { preview: text.slice(0, 80) })
    } catch (err) {
      logger.warn("[sponsorship] sonnet_failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Tier 2b: OpenAI gpt-5.4-nano
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
      const parsed = parseSponsorshipJson(text)
      if (parsed.ok) {
        // Sonnet failed but openai worked → label as primary jd_inference still.
        return finalize(parsed.value, "jd_inference")
      }
      logger.warn("[sponsorship] openai_unparseable", { preview: text.slice(0, 80) })
    } catch (err) {
      logger.warn("[sponsorship] openai_failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Tier 2c: SiliconFlow Qwen-7B (last-resort, free tier)
  if (config.siliconflowApiKey && config.siliconflowApiKey.trim().length > 0) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let client: any
      if (config.openaiClientFactory) {
        // Tests reuse the OpenAI factory hook for Qwen (same SDK shape).
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
        temperature: 0.1,
        max_tokens: 500,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPayload },
        ],
      })
      const text = res?.choices?.[0]?.message?.content ?? "{}"
      const parsed = parseSponsorshipJson(text)
      if (parsed.ok) {
        return finalize(parsed.value, "jd_inference_fallback")
      }
      logger.warn("[sponsorship] qwen_unparseable", { preview: text.slice(0, 80) })
    } catch (err) {
      logger.warn("[sponsorship] qwen_failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // ── Tier 3: All failed ────────────────────────────────────────────────
  // Persist null + 0 confidence + 'all_failed' source so backfill audit can
  // count provider exhaustions distinctly from clean-null inferences.
  return {
    sponsorship: null,
    source: "all_failed",
    confidence: 0,
    reasoning: "all providers failed or no api keys configured",
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ParseOk {
  ok: true
  value: { sponsorship: boolean | null; confidence: number; reasoning: string }
}
interface ParseFail {
  ok: false
}

/**
 * Parse the LLM JSON. Strict-ish: only set sponsorship=true on literal
 * `true`; only false on literal `false`; everything else → null. This is
 * the second guardrail (the prompt is the first). Even if the LLM hallucinates
 * "yes"/"likely sponsor"/"true-ish", we only honor the boolean.
 */
function parseSponsorshipJson(raw: string): ParseOk | ParseFail {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false }
  let txt = raw.trim()
  // Strip ```json ... ``` fences defensively.
  if (txt.startsWith("```")) {
    txt = txt.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(txt)
  } catch {
    return { ok: false }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false }
  }
  const obj = parsed as Record<string, unknown>
  let sponsorship: boolean | null = null
  if (obj.sponsorship === true) sponsorship = true
  else if (obj.sponsorship === false) sponsorship = false
  // anything else (string "true", number 1, null, undefined, missing) → null

  let confidence = 0
  if (typeof obj.confidence === "number" && Number.isFinite(obj.confidence)) {
    confidence = clampUnit(obj.confidence)
  } else if (typeof obj.confidence === "string") {
    const n = Number(obj.confidence)
    if (Number.isFinite(n)) confidence = clampUnit(n)
  }
  // Enforce: null sponsorship → confidence 0 (avoids "I'm 0.8 sure it's null"
  // weirdness and matches our public contract).
  if (sponsorship === null) confidence = 0

  let reasoning = ""
  if (typeof obj.reasoning === "string") {
    reasoning = truncate(obj.reasoning)
  }
  return { ok: true, value: { sponsorship, confidence, reasoning } }
}

function finalize(
  v: { sponsorship: boolean | null; confidence: number; reasoning: string },
  source: SponsorshipSource
): SponsorshipOutput {
  return {
    sponsorship: v.sponsorship,
    source,
    confidence: clampUnit(v.confidence),
    reasoning: truncate(v.reasoning || (v.sponsorship === null ? "ambiguous JD" : "JD inference")),
  }
}

function extractAnthropicText(res: unknown): string {
  if (!res || typeof res !== "object") return ""
  const r = res as { content?: Array<{ type?: string; text?: string }> }
  if (!Array.isArray(r.content)) return ""
  for (const block of r.content) {
    if (block && block.type === "text" && typeof block.text === "string") {
      return block.text.trim()
    }
  }
  return ""
}

function clampUnit(n: number): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}

function truncate(s: string): string {
  if (typeof s !== "string") return ""
  return s.length > REASONING_MAX_LEN ? s.slice(0, REASONING_MAX_LEN) : s
}
