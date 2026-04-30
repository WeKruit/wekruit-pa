/**
 * Phase 38 — Mem0 fact-extractor pinning audit (D5).
 *
 * D5: "Mem0 keep, pin extractor to Qwen-7B+ tier."
 *
 * Reads `MEM0_LLM_MODEL` env (set in `apps/functions/src/index.ts:435` to
 * `Qwen/Qwen2.5-72B-Instruct` default). Rejects models below Qwen-7B class:
 * any model name containing `1.5B`, `0.5B`, `0.6B` (case-insensitive),
 * `mini`, `tiny`, `small`.
 *
 * Default behavior: SOFT-WARN (log + continue). v1.4 ship-gate is informational.
 *
 * Hard-fail mode: set `PA_MEMORY_EXTRACTOR_HARDFAIL=true` →
 * `assertExtractorPinnedOrThrow()` throws on rejection. Useful for
 * stricter prod environments.
 *
 * Default fallback when env unset: `Qwen/Qwen2.5-72B-Instruct` (matches
 * `packages/memory/src/mem0.ts:40` `DEFAULT_LLM_MODEL`).
 *
 * The audit is read-only — does NOT modify Mem0 stack config. The
 * `verifyExtractorPinned()` call surfaces what's CURRENTLY active so
 * the orchestrator can log + alert at boot.
 */

const DEFAULT_MODEL = "Qwen/Qwen2.5-72B-Instruct"

/** Substrings that disqualify a model from "pinned" status (case-insensitive). */
const REJECTED_SUBSTRINGS = ["1.5b", "0.5b", "0.6b", "mini", "tiny", "small"]

/**
 * Read the currently configured Mem0 fact-extractor model id.
 * Trims whitespace; returns the default `Qwen/Qwen2.5-72B-Instruct` when
 * `MEM0_LLM_MODEL` is empty / unset.
 */
export function pinnedExtractorModel(): string {
  const raw = process.env.MEM0_LLM_MODEL?.trim()
  if (!raw || raw.length === 0) return DEFAULT_MODEL
  return raw
}

export interface ExtractorPinResult {
  pinned: boolean
  model: string
  warning: string | null
}

/**
 * Verify the active extractor is in the Qwen-7B+ tier (or equivalent).
 *
 * Returns `{ pinned: boolean, model, warning }`. Caller decides whether
 * to log / alert / hard-fail based on `pinned` value.
 */
export function verifyExtractorPinned(): ExtractorPinResult {
  const model = pinnedExtractorModel()
  const lc = model.toLowerCase()
  const matched = REJECTED_SUBSTRINGS.find((s) => lc.includes(s))
  if (matched) {
    const warning =
      `Mem0 extractor model "${model}" contains disqualifying token "${matched}" — ` +
      `Phase 38 D5 requires Qwen-7B+ tier (e.g. Qwen/Qwen2.5-7B-Instruct, ` +
      `Qwen/Qwen2.5-72B-Instruct). Chinese affect quality may degrade with ` +
      `smaller extractors.`
    return { pinned: false, model, warning }
  }
  return { pinned: true, model, warning: null }
}

/**
 * Hard-fail when `PA_MEMORY_EXTRACTOR_HARDFAIL=true` AND extractor is
 * not pinned. Otherwise logs the warning + returns silently.
 *
 * Designed to be called once at orchestrator boot (or first memory-policy
 * invocation) — NOT per turn (the extractor model is process-static).
 */
export function assertExtractorPinnedOrThrow(): ExtractorPinResult {
  const result = verifyExtractorPinned()
  if (result.pinned) return result
  const hardFail = process.env.PA_MEMORY_EXTRACTOR_HARDFAIL?.trim().toLowerCase() === "true"
  if (hardFail) {
    throw new Error(`[memory-policy/extractor] HARD-FAIL: ${result.warning}`)
  }
  // eslint-disable-next-line no-console
  console.log("[memory-policy/extractor] WARN — extractor not pinned to Qwen-7B+ tier", {
    model: result.model,
    warning: result.warning,
  })
  return result
}

/** Exposed for tests. */
export const MEMORY_POLICY_DEFAULT_EXTRACTOR = DEFAULT_MODEL
export const MEMORY_POLICY_REJECTED_SUBSTRINGS = REJECTED_SUBSTRINGS
