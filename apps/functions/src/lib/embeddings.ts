/**
 * iter34 sprint B.9 — shared CV embedding helper.
 *
 * Single source of truth for CV → 1536-d OpenAI text-embedding-3-small vector
 * compute. Two callers:
 *
 *   1. apps/functions/src/cv-ingest/cv-ingest.ts — synchronously at parse
 *      time, so a brand-new user has a semantic signal the same day they
 *      onboard. Daily-batch is no longer the bottleneck for first-day
 *      matching quality.
 *
 *   2. apps/functions/src/job-rec-daily.ts (defaultUserEmbedComputer) —
 *      lazy fallback for any parsedCandidateResumes doc that still lacks
 *      embedding (legacy rows, sync-compute failures, future migrations).
 *
 * Always fail-open: every error path returns null + logs a warn. Caller
 * NEVER blocks the parsedCandidateResumes write on embedding compute.
 *
 * Cost: ~$0.0001 per CV (1k tokens × $0.02/1M). Cheap enough to pay every
 * ingest; the savings from removing the daily-batch retry path roughly
 * offsets the few % of users who would have already had cached embeddings.
 */

import { logger } from "firebase-functions/v2"

import { logTokenSpend } from "../instrumentation/cost-logger.js"

/** Subset of StructuredCv fields needed to synthesize the embed input text. */
export type EmbeddingResumeInput = {
  candidateProfile: {
    name: string | null
    location?: string
    skills?: string[]
  }
  experiences?: Array<{
    title?: string
    company?: string
    description?: string | null
  }>
  topSkills?: string[]
  education?: Array<{
    degree?: string
    school?: string
    field?: string | null
  }>
  industryTags?: readonly string[]
}

export type ComputeCvEmbeddingResult = {
  vector: number[]
  model: "text-embedding-3-small"
  dim: number
  computedAt: string
}

/** Hard cap for the embedding input — OpenAI 8k token limit ≈ 32k chars. */
const MAX_EMBED_INPUT_CHARS = 8000

/**
 * Build a compact bilingual-friendly text suitable for OpenAI
 * text-embedding-3-small. Mirrors the projection used by the daily-batch
 * (`@pa/job-rec/loadResumeTextForEmbed`) so a same-day sync-compute and a
 * next-day daily-batch lazy-compute produce semantically-equivalent vectors.
 *
 * Returns null when the input has no usable signal (no name, no skills, no
 * experience). Caller should treat null as "skip embedding for this CV".
 */
export function synthesizeCvSummaryText(input: EmbeddingResumeInput): string | null {
  const cp = input.candidateProfile ?? { name: null }
  const name = typeof cp.name === "string" ? cp.name.trim() : ""
  const location = typeof cp.location === "string" ? cp.location.trim() : ""

  const skills = Array.isArray(cp.skills)
    ? cp.skills.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    : []
  const topSkills = Array.isArray(input.topSkills)
    ? input.topSkills.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    : []
  const exps = Array.isArray(input.experiences) ? input.experiences : []
  const eds = Array.isArray(input.education) ? input.education : []
  const tags = Array.isArray(input.industryTags)
    ? input.industryTags.filter((t): t is string => typeof t === "string" && t.length > 0)
    : []

  // Merge skill sources — topSkills first (frequency-ranked from
  // computeTopSkills), then candidateProfile.skills (raw LLM-extracted) for
  // any missing tail items. Cap at 25 so the embed input stays compact.
  const seen = new Set<string>()
  const mergedSkills: string[] = []
  for (const s of [...topSkills, ...skills]) {
    const key = s.trim().toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    mergedSkills.push(s.trim())
    if (mergedSkills.length >= 25) break
  }

  const lines: string[] = []
  if (name) lines.push(name)
  // Up to top 3 experiences. Format mirrors loadResumeTextForEmbed enough
  // that cross-source vectors stay close in cosine space.
  const expLines: string[] = []
  for (const e of exps.slice(0, 3)) {
    const title = typeof e?.title === "string" ? e.title.trim() : ""
    const company = typeof e?.company === "string" ? e.company.trim() : ""
    const desc = typeof e?.description === "string" ? e.description.trim() : ""
    const head = title && company ? `${title} @ ${company}` : title || company
    if (!head && !desc) continue
    expLines.push(desc ? `${head}\n${desc}` : head)
  }
  if (expLines.length > 0) lines.push(expLines.join("\n\n"))
  if (mergedSkills.length > 0) lines.push(mergedSkills.join(", "))
  if (eds.length > 0) {
    const eduLine = eds
      .slice(0, 3)
      .map((e) => {
        const degree = typeof e?.degree === "string" ? e.degree.trim() : ""
        const school = typeof e?.school === "string" ? e.school.trim() : ""
        if (!degree && !school) return ""
        return degree && school ? `${degree} @ ${school}` : degree || school
      })
      .filter((s) => s.length > 0)
      .join("\n")
    if (eduLine) lines.push(eduLine)
  }
  if (location) lines.push(location)
  if (tags.length > 0) lines.push(tags.join(", "))

  const text = lines.join("\n").trim()
  if (text.length < 20) return null
  return text.slice(0, MAX_EMBED_INPUT_CHARS)
}

/**
 * Inject for tests; default reads OPENAI_API_KEY / PA_OPENAI_AGENT_API_KEY.
 * The shape matches the `openai` SDK's `embeddings.create` so the production
 * default can pass straight through without an adapter layer.
 */
export type EmbeddingClient = {
  embeddings: {
    create: (req: {
      model: string
      input: string
    }) => Promise<{
      data: Array<{ embedding: number[] }>
      usage?: { prompt_tokens?: number; total_tokens?: number }
    }>
  }
}

export type ComputeCvEmbeddingDeps = {
  /** Inject for tests. Default: real OpenAI client built from env at call time. */
  client?: EmbeddingClient
  /** Inject for tests; defaults to () => new Date().toISOString(). */
  nowIso?: () => string
  /** Free-form labels passed to the cost logger (caller / userId / resumeId). */
  costLabels?: Record<string, string | number | undefined>
}

/**
 * Resolve an OpenAI client from process env. Returns null when no key is set
 * — caller treats null as "skip embedding, log warn, continue".
 */
async function defaultEmbeddingClient(): Promise<EmbeddingClient | null> {
  // 2026-05-07 Adam directive — embedding is real OpenAI
  // (text-embedding-3-small). MUST use PA_OPENAI_AGENT_API_KEY +
  // explicit https://api.openai.com/v1. NEVER fall through to
  // process.env.OPENAI_API_KEY (poisoned with SiliconFlow key) or read
  // process.env.OPENAI_BASE_URL (poisoned with siliconflow.cn).
  const { getOpenAIConfig } = await import("./llm-providers.js")
  const cfg = getOpenAIConfig()
  if (!cfg.apiKey) return null
  const { default: OpenAI } = (await import("openai")) as unknown as {
    default: new (init: { apiKey: string; baseURL?: string }) => EmbeddingClient
  }
  return new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL })
}

/**
 * Compute a CV embedding via OpenAI text-embedding-3-small (1536-d).
 *
 * Returns null on any failure (missing key, network error, malformed
 * response, empty input). NEVER throws — the caller's parsedCandidateResumes
 * write must not be blocked on embedding compute.
 *
 * Side effect: emits a `pa.spend.daily` cost-ledger record on success so the
 * Cloud Monitoring metric reflects ingest-time embedding spend.
 */
export async function computeCvEmbedding(
  input: EmbeddingResumeInput,
  deps?: ComputeCvEmbeddingDeps
): Promise<ComputeCvEmbeddingResult | null> {
  const summaryText = synthesizeCvSummaryText(input)
  if (!summaryText) {
    // No usable signal — caller already has the parsed CV doc, so we
    // simply skip embedding; daily-batch will not retry an empty doc.
    return null
  }
  const nowIso = deps?.nowIso ?? (() => new Date().toISOString())
  let client: EmbeddingClient | null
  try {
    client = deps?.client ?? (await defaultEmbeddingClient())
  } catch (err) {
    logger.warn("[cv-embedding] client_init_failed", {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
  if (!client) {
    logger.warn("[cv-embedding] no_api_key")
    return null
  }
  let resp: Awaited<ReturnType<EmbeddingClient["embeddings"]["create"]>>
  try {
    resp = await client.embeddings.create({
      model: "text-embedding-3-small",
      input: summaryText,
    })
  } catch (err) {
    logger.warn("[cv-embedding] api_call_failed", {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
  const vector = resp.data?.[0]?.embedding
  if (!Array.isArray(vector) || vector.length === 0) {
    logger.warn("[cv-embedding] empty_response", {
      vectorLength: Array.isArray(vector) ? vector.length : -1,
    })
    return null
  }
  // Cost-ledger emit (best effort — never block return on logger error).
  try {
    const usage = resp.usage
    const tokens =
      usage?.prompt_tokens ?? usage?.total_tokens ?? Math.ceil(summaryText.length / 4)
    logTokenSpend({
      kind: "embedding",
      service: "openai",
      model: "text-embedding-3-small",
      inputTokens: tokens,
      count: 1,
      labels: deps?.costLabels,
    })
  } catch {
    /* fail-open: cost-ledger never blocks production path */
  }
  return {
    vector,
    model: "text-embedding-3-small",
    dim: vector.length,
    computedAt: nowIso(),
  }
}
