/**
 * Phase 26 T3 — structured cost logger (P9-Prod-Ops).
 *
 * Emits a Cloud-Logging-friendly JSON record on every LLM call so the
 * Cloud Monitoring user-defined log-based metric `pa.spend.daily` can
 * aggregate it. The metric is configured in
 * `infra/cloud-logging/alert-policies.yaml` and triggers a $10/day alert.
 *
 * Cost model (cents per 1M tokens, 2026-Q1 SiliconFlow + OpenAI list):
 *   - gpt-4o-mini      input=$0.15  output=$0.60
 *   - gpt-4o           input=$2.50  output=$10.00
 *   - DeepSeek-V2.5    input=$0.14  output=$0.28
 *   - Qwen2-Nano       input=$0.05  output=$0.10
 * Unknown models price at gpt-4o-mini to keep the alert conservative-ish.
 *
 * The log is emitted via the firebase-functions logger so it inherits the
 * function execution metadata (resource.type, labels.execution_id).
 */

import { logger } from "firebase-functions/v2"

export interface CostLogInput {
  model: string
  inputTokens?: number
  outputTokens?: number
  /** Free-form labels (turnId, userId, etc.) passed through to the log. */
  labels?: Record<string, string | number | undefined>
}

interface PriceEntry {
  inPerM: number
  outPerM: number
}

const PRICES: Record<string, PriceEntry> = {
  "gpt-4o-mini": { inPerM: 0.15, outPerM: 0.6 },
  "gpt-4o": { inPerM: 2.5, outPerM: 10 },
  "deepseek-v2.5": { inPerM: 0.14, outPerM: 0.28 },
  "qwen2-nano": { inPerM: 0.05, outPerM: 0.1 },
}

const DEFAULT_PRICE: PriceEntry = PRICES["gpt-4o-mini"]!

export function estimateUsdCost(input: CostLogInput): number {
  const key = input.model.toLowerCase()
  const price = PRICES[key] ?? DEFAULT_PRICE
  const inT = Number(input.inputTokens ?? 0)
  const outT = Number(input.outputTokens ?? 0)
  return (inT / 1_000_000) * price.inPerM + (outT / 1_000_000) * price.outPerM
}

/**
 * Structured Cloud Logging emitter.
 *
 * The label `pa.spend.daily` is consumed by a Google Cloud Monitoring
 * log-based metric. Operators must run the gcloud commands in
 * `infra/cloud-logging/README.md` once after merge to materialize the
 * metric + alert policy.
 */
export function logTokenSpend(input: CostLogInput): void {
  const usd = estimateUsdCost(input)
  // Round to 6 decimal places for log payload sanity.
  const usdRounded = Math.round(usd * 1_000_000) / 1_000_000
  logger.info("pa.spend.daily", {
    "pa.metric": "pa.spend.daily",
    model: input.model,
    inputTokens: Number(input.inputTokens ?? 0),
    outputTokens: Number(input.outputTokens ?? 0),
    usd: usdRounded,
    ...(input.labels ?? {}),
  })
}
