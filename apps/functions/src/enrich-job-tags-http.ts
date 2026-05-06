/**
 * v1.8 ENRICHER-04 — `paEnrichJobTags` HTTP CF.
 *
 * Public job-tag enrichment endpoint that wraps the unified
 * `@pa/job-tag-enricher` service. Symmetric to cv-ingest (which wraps
 * `@pa/pa-resume-parser`).
 *
 * Auth: caller must provide an `X-API-Key` header matching the Firebase
 * secret `PA_MATCHING_ENRICHER_API_KEY`. Used by:
 *   - macmini Stage 2 (run_jd_enrichment.py) — replaces regex-based tag
 *     derivation in `wekruit-core-service-cloud-function/lib/services/
 *     matching/application/jobSync.js#buildMatchingJobRecord` (the bug:
 *     ZERO roleFunction/industrySector/relevantTags derivation, every
 *     non-SimplifyJobs source got "other" silently → P73 jobs surfaced
 *     as random sales/SWE soup).
 *   - Future: pa-job-tag-backfill batch CF for the existing 6700+ jobs.
 *
 * Schema matches `@pa/job-tag-enricher` `EnrichJobTagsResult`. Validation
 * is enforced via the package's Zod layer; we only handle transport here.
 *
 * Cost: gpt-5.4-nano @ ~250 input + ~180 output tokens = ~$0.0005 per call
 * (primary tier). Fallback chain rarely triggered. Latency ~2-4s.
 */

import { onRequest } from "firebase-functions/v2/https"
import { defineSecret } from "firebase-functions/params"
import { logger } from "firebase-functions/v2"
import { z } from "zod"
import { enrichJobTags } from "@pa/job-tag-enricher"
import { ANTHROPIC_API_KEY } from "./orchestrator-deps.js"

// Per-CF secrets. PA_OPENAI_AGENT_API_KEY shared with cv-ingest path. The
// MATCHING_ENRICHER_API_KEY is a NEW shared secret between this CF and the
// macmini caller (rotate together).
const PA_OPENAI_AGENT_API_KEY = defineSecret("PA_OPENAI_AGENT_API_KEY")
const MATCHING_ENRICHER_API_KEY = defineSecret("MATCHING_ENRICHER_API_KEY")

const RequestSchema = z.object({
  title: z.string().min(1),
  companyName: z.string().nullable().optional(),
  jobDescription: z.string().nullable().optional(),
  locationRaw: z.string().nullable().optional(),
  sourceRepo: z.string().nullable().optional(),
})

export const paEnrichJobTags = onRequest(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 60,
    secrets: [PA_OPENAI_AGENT_API_KEY, ANTHROPIC_API_KEY, MATCHING_ENRICHER_API_KEY],
    cors: false,
  },
  async (req, res) => {
    if (req.method === "OPTIONS") {
      res.status(204).send("")
      return
    }
    if (req.method !== "POST") {
      res.status(405).json({ error: "POST only" })
      return
    }

    // 1. Auth — shared X-API-Key. Server-side timing-safe-ish compare via
    // `=== ` is fine here since the secret is high-entropy random.
    const provided = req.header("x-api-key") ?? req.header("X-API-Key")
    const expected = MATCHING_ENRICHER_API_KEY.value()
    if (!expected || expected.length === 0) {
      logger.error("pa.enrich_job_tags.secret_unconfigured")
      res.status(500).json({ error: "server misconfigured: MATCHING_ENRICHER_API_KEY not set" })
      return
    }
    if (provided !== expected) {
      res.status(401).json({ error: "unauthorized" })
      return
    }

    // 2. Validate input.
    const parsed = RequestSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "bad_request", issues: parsed.error.issues })
      return
    }

    const startedAt = Date.now()
    try {
      // 3. Run the enricher. Anthropic key is optional (graceful fallthrough
      // inside the router when secret is unset).
      const anthropicKey = (() => {
        try {
          return ANTHROPIC_API_KEY.value()
        } catch {
          return undefined
        }
      })()
      const result = await enrichJobTags(parsed.data, {
        openaiApiKey: PA_OPENAI_AGENT_API_KEY.value(),
        anthropicApiKey: anthropicKey,
        log: (event, payload) => logger.info(event, payload ?? {}),
      })
      const latencyMs = Date.now() - startedAt
      logger.info("pa.enrich_job_tags.ok", {
        title: parsed.data.title,
        modelUsed: result.modelUsed,
        usedTier: result.usedTier,
        latencyMs,
        inputTokens: result.usage?.input_tokens,
        outputTokens: result.usage?.output_tokens,
        fallbackChainLen: result.fallbackChain.length,
      })
      res.status(200).json({
        tags: result.tags,
        modelUsed: result.modelUsed,
        usedTier: result.usedTier,
        fallbackChain: result.fallbackChain,
        usage: result.usage,
        latencyMs,
      })
    } catch (err) {
      const latencyMs = Date.now() - startedAt
      const message = err instanceof Error ? err.message : String(err)
      logger.error("pa.enrich_job_tags.failed", { title: parsed.data.title, latencyMs, error: message })
      // Zod validation failures from the LLM output → 502 (upstream
      // dependency failed to produce conformant output). Other errors
      // bubble up as 500.
      const status = /Invalid enum value|Required|llm_json_parse_failed|invalid_/i.test(message)
        ? 502
        : 500
      res.status(status).json({ error: "enrichment_failed", message, latencyMs })
    }
  },
)
