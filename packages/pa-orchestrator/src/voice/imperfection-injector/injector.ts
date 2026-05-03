/**
 * Phase 36 — ImperfectionInjector orchestrator.
 *
 * Pipeline (per-turn):
 *   1. Resolve arm (sticky from userId or explicit `ctx.arm` override)
 *   2. Probability draw vs `firingRateForArm(arm)` — if miss, return original
 *   3. Auto-detect lang if not provided (CJK char ratio)
 *   4. Walk POLICIES_{ZH|EN} in TYPE-PRIORITY order; first whose
 *      probability draw passes AND position-constraint succeeds wins
 *   5. Apply `injectAtTurnOnset` with anti-stutter check against
 *      ALL policy markers (intra-bank stutter prevention)
 *   6. Return `InjectorResult` with full telemetry
 *
 * Hard constraints (CONTEXT §5):
 *   - 0 net new LLM calls (pure text)
 *   - Position constrained: turn-onset ONLY (D3)
 *   - Bilingual (D9)
 *   - Type priority: self_correct > hesitate > clarify > uncertainty (D3)
 *   - DO NOT inject FILLER_BLACKLIST_* phrases (enforced at policy-bank
 *     level by anti-blacklist unit tests; runtime defense via re-check
 *     in smoke tests)
 *   - Latency: < 5ms per call
 */
import {
  firingRateForArm,
  resolveArm,
} from "./arm-router.js"
import { POLICIES_EN } from "./policies-en.js"
import { POLICIES_ZH } from "./policies-zh.js"
import {
  injectAtTurnOnset,
  startsWithAnyMarker,
} from "./position-constraint.js"
import type {
  InjectorArm,
  InjectorContext,
  InjectorResult,
  Policy,
  RngFn,
} from "./types.js"

/**
 * Auto-detect lang via CJK char ratio (matches Phase 33 / Phase 35
 * `detectLang`). Tie / empty → "en".
 */
export function detectLang(text: string): "zh" | "en" {
  if (typeof text !== "string" || text.length === 0) return "en"
  let cjk = 0
  let ascii = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3000 && code <= 0x303f)
    ) {
      cjk += 1
    } else if (code < 128 && /[A-Za-z]/.test(ch)) {
      ascii += 1
    }
  }
  return cjk > ascii ? "zh" : "en"
}

/**
 * Phase 53 — Bug 2 fix: zh-biased detection for USER INPUT.
 *
 * `detectLang` uses cjk-vs-ascii majority; this misclassifies bilingual user
 * inputs like "swe的" (1 cjk + 3 ascii) or "yoe1年的" (3 ascii + 2 cjk) as
 * "en". When a user mixes English tokens (acronyms, role names like SWE/PM,
 * tech terms like react/python) with Chinese, they are still WRITING IN
 * CHINESE — the English bits are loanword-shaped fragments inside a
 * Chinese-frame utterance. Replying in English is wrong.
 *
 * Heuristic: ANY presence of CJK characters → "zh" (the user is writing
 * Chinese-frame; English fragments are loanwords). Pure-ASCII → "en".
 *
 * USE THIS for USER-INPUT lang detection (langLock decisions). For REPLY
 * lang detection (post-gen translate decision), keep using `detectLang`
 * because that is a faithful "what did the model actually emit" check.
 *
 * Adam iMessage 2026-05-03 00:34 repro:
 *   "我想找工作"   → detectLang=zh (current OK)
 *   "swe的"        → detectLang=en (WRONG; detectUserLang=zh ✓)
 *   "yoe1年的"     → detectLang=en (WRONG; detectUserLang=zh ✓)
 *   "I want a job" → detectLang=en (correct; detectUserLang=en ✓)
 *   "我是 senior on OPT" → detectLang=en (debatable; detectUserLang=zh ✓)
 */
export function detectUserLang(text: string): "zh" | "en" {
  if (typeof text !== "string" || text.length === 0) return "en"
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3000 && code <= 0x303f)
    ) {
      return "zh"
    }
  }
  return "en"
}

/**
 * Pick a policy from a same-type sub-bank using weighted random draw.
 * Returns the chosen policy index in `policies` (NOT the sub-bank index).
 *
 * If only one policy of the type exists, returns its index. Always
 * returns a valid index (never -1) when `subBank.length > 0`.
 */
function pickWeighted(
  policies: Policy[],
  subBank: number[],
  rng: RngFn
): number {
  if (subBank.length === 0) return -1
  if (subBank.length === 1) return subBank[0]
  let totalWeight = 0
  for (const i of subBank) totalWeight += policies[i].weight ?? 1
  const target = rng() * totalWeight
  let acc = 0
  for (const i of subBank) {
    acc += policies[i].weight ?? 1
    if (target < acc) return i
  }
  return subBank[subBank.length - 1]
}

/**
 * Build all-marker set for anti-stutter.
 *
 * We pass BOTH the active-lang policy markers AND the prev-reply's
 * apparent leading marker (if any) to `injectAtTurnOnset`. This catches
 * the case where prev turn was a different lang/marker but still opened
 * with hesitation.
 */
function allMarkers(policies: Policy[]): string[] {
  return policies.map((p) => p.marker)
}

/**
 * Choose the FIRST eligible policy in type-priority order. Returns the
 * chosen policy + its position-constraint result.
 *
 * Policy = ordered bank entry. We group by type, then within each type
 * pick by weighted draw. We commit to the first type that has any
 * eligible policy (where "eligible" = passes position-constraint anti-
 * stutter). If no type yields an eligible policy, returns null.
 */
function chooseAndInject(
  text: string,
  policies: Policy[],
  rng: RngFn,
  prevAssistantReply: string | undefined
): { policy: Policy; injected: string } | null {
  // Anti-stutter (cross-turn): if prev turn STARTS with any of our policy
  // markers (either lang bank), refuse injection this turn to avoid
  // `嗯… 嗯…` / `hmm, hmm,` cadence compounding into a tic.
  if (prevAssistantReply) {
    const allBoth = [...allMarkers(POLICIES_ZH), ...allMarkers(POLICIES_EN)]
    if (startsWithAnyMarker(prevAssistantReply, allBoth)) {
      return null
    }
  }

  // Walk types in priority order. policies array is already sorted by
  // type priority (T1/T2 invariant). Group consecutive same-type entries.
  let i = 0
  while (i < policies.length) {
    const type = policies[i].type
    const subBank: number[] = []
    let j = i
    while (j < policies.length && policies[j].type === type) {
      subBank.push(j)
      j += 1
    }
    // Try a weighted draw within this type. If position-constraint fails
    // for the chosen policy, we DON'T fall back to another in the same
    // type bucket — we move to the next type. (Prevents type-bucket
    // exhaustion gaming; still respects priority.)
    const chosenIdx = pickWeighted(policies, subBank, rng)
    if (chosenIdx >= 0) {
      const policy = policies[chosenIdx]
      // injectAtTurnOnset handles intra-turn anti-stutter (current text
      // already starts with marker). Cross-turn anti-stutter handled
      // above (prev reply check).
      const result = injectAtTurnOnset(text, policy.marker, policy.separator)
      if (result.ok) {
        return { policy, injected: result.injected }
      }
      // result.ok=false → fall through to next type bucket.
    }
    i = j
  }
  return null
}

/**
 * Main entry point. Pure function (modulo the Math.random fallback).
 * Latency < 5ms. Returns full telemetry.
 *
 * @param ctx  Input context (text + lang + prevReply + userId/arm)
 * @returns    InjectorResult with `applied`, `injected`, `arm`, type info
 */
export function injectImperfection(ctx: InjectorContext): InjectorResult {
  const start = performance.now()
  const original = typeof ctx.text === "string" ? ctx.text : ""
  const rng = ctx.rng ?? Math.random

  // 1. Resolve arm.
  let arm: InjectorArm
  if (ctx.arm) {
    arm = ctx.arm
  } else if (ctx.userId) {
    arm = resolveArm(ctx.userId)
  } else {
    arm = "off"
  }

  // 2. Empty text → never inject.
  if (original.length === 0) {
    return {
      arm,
      original,
      injected: original,
      applied: false,
      injection_type: null,
      position: "none",
      reason: "empty_text",
      latencyMs: performance.now() - start,
    }
  }

  // 3. Off arm or kill switch → bypass.
  const rate = firingRateForArm(arm)
  if (rate === 0) {
    return {
      arm,
      original,
      injected: original,
      applied: false,
      injection_type: null,
      position: "none",
      reason: "arm_off",
      latencyMs: performance.now() - start,
    }
  }

  // 4. Probability draw.
  const draw = rng()
  if (draw >= rate) {
    return {
      arm,
      original,
      injected: original,
      applied: false,
      injection_type: null,
      position: "none",
      reason: `prob_miss_${draw.toFixed(3)}_>=_${rate.toFixed(2)}`,
      latencyMs: performance.now() - start,
    }
  }

  // 5. Lang detection + policy bank selection.
  const lang = ctx.lang ?? detectLang(original)
  const policies = lang === "zh" ? POLICIES_ZH : POLICIES_EN

  // 6. Walk type-priority order, attempt injection.
  const chosen = chooseAndInject(original, policies, rng, ctx.prevAssistantReply)
  if (!chosen) {
    return {
      arm,
      original,
      injected: original,
      applied: false,
      injection_type: null,
      position: "none",
      reason: "no_eligible_policy_position_or_stutter",
      latencyMs: performance.now() - start,
    }
  }

  return {
    arm,
    original,
    injected: chosen.injected,
    applied: true,
    injection_type: chosen.policy.type,
    position: "turn_onset",
    reason: `injected_${chosen.policy.type}_${lang}_marker=${chosen.policy.marker}`,
    latencyMs: performance.now() - start,
  }
}
