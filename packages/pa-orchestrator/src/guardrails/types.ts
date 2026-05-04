/**
 * iter30 WS6 — guardrail contract layered above `@openai/agents` SDK.
 *
 * Why we layer instead of consuming the SDK shape directly: the SDK's
 * `tripwireTriggered=true` HALTS the agent (run.d.ts:209-211). For soft
 * transforms (AB strip, slang, length cap, normalizer) we need a shape
 * that can mutate the reply WITHOUT halting. We model this with an
 * extra `transformedOutput` channel surfaced via `outputInfo`. The
 * orchestrator chain runner (`run-input-chain.ts` / `run-output-chain.ts`)
 * applies the transform between guardrails so chain ordering stays
 * deterministic. Hard blocks (PII, prompt-injection, crisis canned
 * fallback) keep the SDK semantics — `tripwireTriggered=true`.
 *
 * Detail-plan: `.planning/iter30/ws-3-6-detail.md` §5 (catalog) + §6
 * (chain ordering).
 */
import type { ClaireContext } from "../run-context.js"

// ---------------------------------------------------------------------------
// Common SDK-shaped types (sub-set we actually use).
// ---------------------------------------------------------------------------

export interface GuardrailFunctionOutput {
  /** True → HALTS agent + replaces reply with `cannedReply`. */
  tripwireTriggered: boolean
  outputInfo: GuardrailOutputInfo
}

export interface GuardrailOutputInfo {
  /**
   * Soft-transform channel. When set + tripwireTriggered=false, the
   * chain runner replaces the in-flight text with this value.
   */
  transformedOutput?: string
  /**
   * Hard-block fallback. When set + tripwireTriggered=true, the chain
   * runner replaces the reply with this canned text and stops.
   */
  cannedReply?: string
  /**
   * Soft-action hint used by orchestrator to decide whether to
   * resample (e.g. F1/F4 detectors). Chain runner does NOT act on
   * this in V1 — it's surfaced for telemetry parity with today's
   * `runAllDetectors` log-only behaviour.
   */
  suggestedAction?: "reject_resample" | "strip" | "warn"
  /** Free-form metadata — flushed to `ctx.guardrailHits[i].metadata`. */
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Input guardrails — args mirror SDK `InputGuardrailFunctionArgs` but with
// `ClaireContext` baked in (we never run guardrails outside a Claire turn).
// ---------------------------------------------------------------------------

export interface InputGuardrailArgs {
  input: string
  ctx: ClaireContext
}

export type InputGuardrailFn = (
  args: InputGuardrailArgs
) => Promise<GuardrailFunctionOutput> | GuardrailFunctionOutput

export interface InputGuardrail {
  name: string
  /** When true the guardrail does not block the LLM call (SDK parity). */
  runInParallel?: boolean
  execute: InputGuardrailFn
}

// ---------------------------------------------------------------------------
// Output guardrails — args mirror SDK `OutputGuardrailFunctionArgs`.
// ---------------------------------------------------------------------------

export interface OutputGuardrailArgs {
  /** The latest in-flight reply text (post any prior guardrail transform). */
  agentOutput: string
  ctx: ClaireContext
  /** Echo of the original raw user input — needed by F1 mirror score. */
  userInput: string
}

export type OutputGuardrailFn = (
  args: OutputGuardrailArgs
) => Promise<GuardrailFunctionOutput> | GuardrailFunctionOutput

export interface OutputGuardrail {
  name: string
  execute: OutputGuardrailFn
}

// ---------------------------------------------------------------------------
// Helper used across modules — emit a guardrail audit entry on the ctx.
// Centralised so the audit shape stays uniform and downstream dashboards
// (WS8 boost-explainer) can rely on a stable payload schema.
// ---------------------------------------------------------------------------

export function recordGuardrailHit(
  ctx: ClaireContext,
  hit: {
    name: string
    type: "input" | "output"
    tripped: boolean
    metadata?: Record<string, unknown>
    latencyMs: number
  }
): void {
  ctx.guardrailHits.push({
    name: hit.name,
    type: hit.type,
    tripped: hit.tripped,
    metadata: hit.metadata,
    latencyMs: hit.latencyMs,
  })
}
