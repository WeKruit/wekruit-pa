/**
 * Phase 26 T3 — structured cost logger (P9-Prod-Ops).
 *
 * Emits a Cloud-Logging-friendly JSON record on every LLM/embedding/memory
 * call so the Cloud Monitoring user-defined log-based metric `pa.spend.daily`
 * can aggregate it. The metric is configured in
 * `infra/cloud-logging/alert-policies.yaml` and triggers a $10/day alert.
 *
 * Cost model (cents per 1M tokens, 2026-Q1 SiliconFlow + OpenAI list):
 *   - gpt-4o-mini      input=$0.15  output=$0.60
 *   - gpt-4o           input=$2.50  output=$10.00
 *   - DeepSeek-V2.5    input=$0.14  output=$0.28
 *   - Qwen2-Nano       input=$0.05  output=$0.10
 * Unknown models price at gpt-4o-mini to keep the alert conservative-ish.
 *
 * Embedding model prices (per 1M tokens, OpenAI 2026-Q1):
 *   - text-embedding-3-small  $0.02
 *   - text-embedding-3-large  $0.13
 *
 * Mem0 OSS internal extractor: charged per `count` only — mem0ai/oss does
 * not surface token usage to the client. Cost stays at 0 USD; downstream
 * dashboards aggregate `count` to spot anomalies.
 *
 * The log is emitted via the firebase-functions logger so it inherits the
 * function execution metadata (resource.type, labels.execution_id).
 *
 * Single source of truth — call sites:
 *   - apps/functions/src/job-rec-daily.ts (embedding, openai)
 *   - apps/functions/src/paReverseMatch.ts (embedding, openai)
 *   - packages/memory/src/mem0.ts (mem0 add/search — count only)
 * The pa-orchestrator chat-turn emit in packages/pa-orchestrator/src/index.ts
 * intentionally remains inline (hot path, avoids cross-package import) but
 * MUST keep the same telemetry shape — the helper documents the schema.
 */

import { logger } from "firebase-functions/v2"

/**
 * Discriminator across LLM-flavored cost events. Defaults to `chat` for
 * backward-compat with Phase 26 callers that omit `kind`.
 */
export type CostKind = "chat" | "embedding" | "mem0"

export interface CostLogInput {
  /** Default "chat". Tag embedding / mem0 calls explicitly. */
  kind?: CostKind
  model: string
  /** Provider tag — e.g. "openai", "siliconflow", "mem0". Optional. */
  service?: string
  inputTokens?: number
  outputTokens?: number
  /**
   * Call count (mem0 / embedding). For chat turns this is implicit (1) and
   * left unset; embedding emits the embedding token count under
   * `inputTokens` AND `count=1` for clarity.
   */
  count?: number
  /**
   * Pre-computed USD when the caller already knows the figure (e.g. mem0
   * free tier → 0). When unset, the helper estimates from token counts +
   * the model-price table.
   */
  costUsd?: number
  /** Free-form labels (turnId, userId, etc.) passed through to the log. */
  labels?: Record<string, string | number | undefined>
}

interface PriceEntry {
  inPerM: number
  outPerM: number
}

const CHAT_PRICES: Record<string, PriceEntry> = {
  "gpt-4o-mini": { inPerM: 0.15, outPerM: 0.6 },
  "gpt-4o": { inPerM: 2.5, outPerM: 10 },
  "deepseek-v2.5": { inPerM: 0.14, outPerM: 0.28 },
  "qwen2-nano": { inPerM: 0.05, outPerM: 0.1 },
}

/** Embedding $ per 1M tokens. inPerM only — embeddings have no output side. */
const EMBEDDING_PRICES: Record<string, number> = {
  "text-embedding-3-small": 0.02,
  "text-embedding-3-large": 0.13,
  "baai/bge-m3": 0, // SiliconFlow free tier
}

const DEFAULT_CHAT_PRICE: PriceEntry = CHAT_PRICES["gpt-4o-mini"]!
const DEFAULT_EMBEDDING_PRICE = EMBEDDING_PRICES["text-embedding-3-small"]!

export function estimateUsdCost(input: CostLogInput): number {
  if (typeof input.costUsd === "number" && Number.isFinite(input.costUsd)) {
    return Math.max(0, input.costUsd)
  }
  const kind = input.kind ?? "chat"
  const inT = Number(input.inputTokens ?? 0)
  const outT = Number(input.outputTokens ?? 0)
  if (kind === "mem0") {
    // Mem0 OSS internal extractor — no client-visible token counts.
    return 0
  }
  if (kind === "embedding") {
    const key = input.model.toLowerCase()
    const perM = EMBEDDING_PRICES[key] ?? DEFAULT_EMBEDDING_PRICE
    return (inT / 1_000_000) * perM
  }
  // chat (default)
  const key = input.model.toLowerCase()
  const price = CHAT_PRICES[key] ?? DEFAULT_CHAT_PRICE
  return (inT / 1_000_000) * price.inPerM + (outT / 1_000_000) * price.outPerM
}

/**
 * Structured Cloud Logging emitter.
 *
 * The label `pa.spend.daily` is consumed by a Google Cloud Monitoring
 * log-based metric. Operators must run the gcloud commands in
 * `infra/cloud-logging/README.md` once after merge to materialize the
 * metric + alert policy.
 *
 * Fail-open: any synchronous error inside `logger.info` is swallowed so
 * cost-logging never breaks the production path. (firebase-functions logger
 * is sync today but we double-wrap in case underlying transport changes.)
 */
export function logTokenSpend(input: CostLogInput): void {
  try {
    const usd = estimateUsdCost(input)
    // Round to 6 decimal places for log payload sanity.
    const usdRounded = Math.round(usd * 1_000_000) / 1_000_000
    const kind = input.kind ?? "chat"
    logger.info("pa.spend.daily", {
      "pa.metric": "pa.spend.daily",
      kind,
      service: input.service,
      model: input.model,
      inputTokens: Number(input.inputTokens ?? 0),
      outputTokens: Number(input.outputTokens ?? 0),
      count: Number(input.count ?? (kind === "chat" ? 1 : input.count ?? 1)),
      usd: usdRounded,
      ...(input.labels ?? {}),
    })
  } catch (err) {
    // Never let telemetry break business logic.
    try {
      logger.warn("pa.spend.daily.emit_failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    } catch {
      /* logger broke too — give up silently */
    }
  }
}
