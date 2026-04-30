/**
 * Phase 36 — ImperfectionInjector types.
 *
 * The injector is a pure post-processing module that runs AFTER the
 * Phase 35 detector pass and BEFORE the rewriter's final return. It
 * conditionally prepends a turn-onset filler / hesitation / self-correct
 * / uncertainty marker to Claire's reply to humanize the cadence.
 *
 * Hard constraints (per `.planning/phases/36-injector/CONTEXT.md`):
 * - 0 net new LLM calls (pure text)
 * - Position constrained: turn-onset ONLY (D3 + Pinguet 2023)
 * - Bilingual: zh + en + mixed (D9)
 * - 3-arm A/B: 0% / 15% / 30%
 * - Type priority: self_correct > hesitate > clarify > uncertainty (D3)
 * - DO NOT inject FILLER_BLACKLIST phrases (anti-blacklist unit guard)
 * - Latency: < 5ms per turn
 *
 * Reused from Phase 33 helper:
 * - `splitSentences` for turn-onset detection
 */

/** A/B arm. `off` = 0% firing rate (control). */
export type InjectorArm = "off" | "low" | "high"

/**
 * The 4 imperfection types, listed in PRIORITY order.
 *
 * When multiple policies could fire on a turn, `chooseInjectionType`
 * iterates the policy bank in order and applies the FIRST whose
 * conditions + probability draw + position constraint succeed. Per
 * Schroeder 2024: corrected typos are most humanizing.
 */
export type InjectionType =
  | "self_correct" // highest priority
  | "hesitate"
  | "clarify"
  | "uncertainty" // lowest priority

/** Where the marker landed. `none` = no injection applied this turn. */
export type InjectionPosition = "turn_onset" | "none"

/** Optional RNG hook for seedable test runs. Returns 0..1. */
export type RngFn = () => number

/**
 * Single policy entry in the ordered bank.
 *
 * `marker` is the literal string injected (e.g. "嗯…", "wait").
 * `separator` is what we put between marker and the original text.
 *   For en, typically " " (after a punctuation-ending marker like "wait,")
 *   or just nothing (when marker already carries punctuation like "oh —").
 *   For zh, typically "，" or just nothing (when marker carries `…`).
 * `weight` is relative selection weight WITHIN the same type bucket;
 *   higher weight = more likely picked when multiple markers of same
 *   type are eligible. Default 1.
 */
export interface Policy {
  type: InjectionType
  marker: string
  separator: string
  lang: "zh" | "en"
  weight?: number
}

/** Input to the injector entry point. */
export interface InjectorContext {
  /** Claire's draft reply (post-detector). */
  text: string
  /** Optional explicit lang. If absent, auto-detected via CJK ratio. */
  lang?: "zh" | "en"
  /** Optional prev-turn Claire reply for anti-stutter check. */
  prevAssistantReply?: string
  /** User id for sticky arm assignment. If absent, arm must be supplied. */
  userId?: string
  /** Explicit arm override (e.g. tests). Beats userId-derived assignment. */
  arm?: InjectorArm
  /** Optional RNG override (default `Math.random`). Useful in tests. */
  rng?: RngFn
}

/** Output from `injectImperfection`. */
export interface InjectorResult {
  /** Resolved arm for this turn. */
  arm: InjectorArm
  /** Original (pre-injection) text. */
  original: string
  /** Final text. Equals `original` when `applied: false`. */
  injected: string
  /** True iff a marker was actually prepended. */
  applied: boolean
  /** Which type of injection was applied (`null` when not applied). */
  injection_type: InjectionType | null
  /** Where the injection landed (`"none"` when not applied). */
  position: InjectionPosition
  /** Human-readable reason — for telemetry/debugging. */
  reason: string
  /** Wall-clock latency in ms. */
  latencyMs: number
}

/** Bucket ratios for `resolveArm`. Must sum to 100. Default {off:33,low:33,high:34}. */
export interface ArmBucketRatios {
  off: number
  low: number
  high: number
}

/** Options for `resolveArm`. */
export interface ResolveArmOpts {
  /** Override default 33/33/34 bucket distribution. */
  ratios?: ArmBucketRatios
  /**
   * Disable `process.env.PA_IMPERFECTION_ARM` env override (default false).
   * Tests use this to verify hash assignment without env interference.
   */
  ignoreEnv?: boolean
}
