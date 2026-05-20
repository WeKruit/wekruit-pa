/**
 * iter30 WS4-A — SkillToolGate (contract-only stub for WS6 enforcement).
 *
 * iter30 deliverable: export the contract + a no-op default impl.
 *   The 6 existing skills all set allowedTools=[], so the gate is trivially
 *   satisfied. Concrete enforcement wired in WS6 OutputGuardrail; this
 *   module supplies the data.
 *
 * Read-side: WS6 OutputGuardrail reads `ctx.activeSkillsAllowedTools`
 *   (populated by SkillRouter at turn entry — coordinated with WS3).
 * Write-side: this module exposes ctx mutator + audit helper.
 *
 * Usage (post-iter30, when WS6 wires it in):
 *   const result = checkToolAgainstSkills({ toolName: "saveJobProfile", ctx })
 *   if (!result.allowed) {
 *     // GuardrailTripwireTriggered with metadata = { toolName, reason, ... }
 *   }
 */
import type { SkillKey } from "@pa/agent-registry"
import type { ClaireContext } from "./run-context.js"

export type SkillToolGateInput = {
  /** Proposed tool call. */
  toolName: string
  ctx: ClaireContext
}

export type SkillToolGateResult = {
  allowed: boolean
  /**
   * Human-readable reason — emitted to guardrail audit metadata.
   *
   * Possible values:
   *   - "no-active-skill"            (no skill active → fall through to base agent)
   *   - "skill-stack-allows"         (tool in active union)
   *   - "no-skill-allow-for:<tool>"  (active skills declared no allowedTools or
   *                                    don't include this tool)
   */
  reason: string
  activeSkills: SkillKey[]
  allowedToolsUnion: string[]
}

/**
 * Pure function — checks whether a tool call is allowed by the active skill
 * stack. iter30 fail-safe semantic: when at least one skill is active and
 * none declares the tool, we DENY. "No silent escalation" (Adam-lock).
 *
 * When NO skill is active (regex+LLM both empty), we ALLOW the tool — that's
 * the existing production behavior for non-skilled turns.
 *
 * Compatibility shim: reads from `ctx.activeSkillsAllowedTools` if present
 * (set by SkillRouter post-WS3 ctx field add). Falls back to scanning
 * `ctx.activeSkills` against an empty union (= deny when active).
 */
export function checkToolAgainstSkills(
  input: SkillToolGateInput
): SkillToolGateResult {
  const { toolName, ctx } = input
  // Cast through unknown — `activeSkillsAllowedTools` is a NEW iter30 field
  // that WS3 will land in run-context.ts before this gate fires in WS6.
  const ctxExt = ctx as unknown as { activeSkillsAllowedTools?: string[] }
  const union: string[] = Array.isArray(ctxExt.activeSkillsAllowedTools)
    ? ctxExt.activeSkillsAllowedTools
    : []
  const active = (ctx.activeSkills ?? []) as SkillKey[]

  if (active.length === 0) {
    return {
      allowed: true,
      reason: "no-active-skill",
      activeSkills: [],
      allowedToolsUnion: [],
    }
  }
  if (union.length === 0) {
    // Active skill(s) but none declares tools → deny ("no silent escalation").
    return {
      allowed: false,
      reason: `no-skill-allow-for:${toolName}`,
      activeSkills: active,
      allowedToolsUnion: union,
    }
  }
  return {
    allowed: union.includes(toolName),
    reason: union.includes(toolName)
      ? "skill-stack-allows"
      : `no-skill-allow-for:${toolName}`,
    activeSkills: active,
    allowedToolsUnion: union,
  }
}

/**
 * Helper for SkillRouter to push the union into ctx after stacking. Not used
 * by the gate itself; provided for symmetry so callers don't need to know
 * the exact ctx field name.
 */
export function setActiveSkillsAllowedTools(
  ctx: ClaireContext,
  toolUnion: string[]
): void {
  // Cast — field is a NEW iter30 mutable bucket. See ws-3-6-detail.md §7.3
  // for the WS3 coord (one-line PR, default empty).
  ;(ctx as unknown as { activeSkillsAllowedTools: string[] }).activeSkillsAllowedTools =
    Array.from(new Set(toolUnion))
}

/** Alias used by playbook-routing when Skill Router v2 is active. */
export function applySkillToolAllowlist(ctx: ClaireContext, toolUnion: string[]): void {
  setActiveSkillsAllowedTools(ctx, toolUnion)
}
