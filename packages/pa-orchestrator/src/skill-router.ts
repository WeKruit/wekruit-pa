/**
 * iter30 WS4-A — SkillRouter (regex floor + LLM intent merge).
 *
 * Per discussion.md L37-39 (Adam lock):
 *   - LLM holistic intent leads
 *   - Regex stays as basic floor for crisis + AB-NEVER + obvious patterns
 *   - Floor patterns ALWAYS active; LLM intent skills above 0.6 confidence stack
 *
 * Cutover: replaces `matchCachedPlaybooks` at the orchestrator entry. Behind
 * `paSkillRouterV2Enabled` flag (NEW) — default OFF for iter30 ramp.
 *
 * Pipeline:
 *   1. Regex floor (parallel to LLM intent) — sub-ms, always computed.
 *   2. LLM intent — flag-gated; fail-open empty array on disabled/rate-limited.
 *   3. Merge by playbookKey (dedupe; regex wins for safety patterns; LLM stacks).
 *   4. SkillStacker — composability + conflictsWith + ctx-gating + priority sort.
 *   5. Audit row to ctx.guardrailHits.
 */
import { matchPlaybooks, type SkillV2, type Playbook } from "@pa/agent-registry"
import type { Firestore } from "firebase-admin/firestore"
import { getCachedPlaybooks } from "./playbook-cache.js"
import { stack, type StackedResult } from "./skill-stacker.js"
import {
  classifySkills,
  type ClassifyDeps,
  type ClassifyResult,
} from "./skill-intent-classifier.js"
import type { ClaireContext } from "./run-context.js"

export type RouteResult = {
  activeSkills: SkillV2[]
  addendum: string
  allowedTools: string[]
  source: { regex: string[]; llm: string[] }
  classifierLatencyMs: number
  classifierRateLimited: boolean
  prunedReasons: { key: string; reason: string }[]
}

export type RouteDeps = {
  /** Firestore (only required when caller doesn't pre-pass `playbooks`). */
  db?: Firestore
  /** Pre-loaded playbook list — overrides Firestore read. */
  playbooks?: Playbook[]
  classifyDeps?: ClassifyDeps
  /** Override the Boolean flag check — useful for tests. */
  forceClassifierEnabled?: boolean
}

/**
 * Coerce a V1 Playbook (from listPlaybooks) to V2 shape with safe defaults.
 * The agent-registry has both V1 and V2 typings; getCachedPlaybooks
 * currently returns V1 typed but the underlying Firestore docs MAY contain
 * V2 fields (post-migration). We re-read by inspecting the unknown payload
 * via attached fields.
 */
function toV2(pb: Playbook): SkillV2 {
  // Cast through `unknown` so we can read V2 fields if present (post-migration).
  const raw = pb as unknown as Record<string, unknown>
  const SKILL_KEY_SET = new Set([
    "headhunter",
    "vent_support",
    "motivation_nudge",
    "jd_roast",
    "interview_prep",
    "negotiation",
    "rejection_processing",
    "post_offer_decision",
    "referral_request",
    "silence_anchor",
    "cv_followup",
    "layoff_processing",
    "company_research",
    "career_pivot",
    "return_to_work",
    "daily_batch_reply",
    "am_i_ai_check",
    "boundary_test",
    "mom_test",
  ])
  const filterSkill = (s: unknown): s is import("@pa/agent-registry").SkillKey =>
    typeof s === "string" && SKILL_KEY_SET.has(s)
  return {
    playbookKey: pb.playbookKey,
    name: pb.name,
    description: pb.description,
    regexTriggers: pb.regexTriggers,
    addendum: pb.addendum,
    enabled: pb.enabled,
    routingHint: pb.routingHint,
    version: pb.version,
    updatedAt: pb.updatedAt,
    updatedBy: pb.updatedBy,
    reason: pb.reason,
    intentDescription:
      typeof raw.intentDescription === "string" ? raw.intentDescription : "",
    provides: Array.isArray(raw.provides)
      ? (raw.provides as unknown[]).filter((s): s is string => typeof s === "string")
      : [],
    requires: Array.isArray(raw.requires)
      ? (raw.requires as unknown[]).filter((s): s is string => typeof s === "string")
      : [],
    composableWith: Array.isArray(raw.composableWith)
      ? (raw.composableWith as unknown[]).filter(filterSkill)
      : [],
    conflictsWith: Array.isArray(raw.conflictsWith)
      ? (raw.conflictsWith as unknown[]).filter(filterSkill)
      : [],
    priority: typeof raw.priority === "number" ? raw.priority : 50,
    allowedTools: Array.isArray(raw.allowedTools)
      ? (raw.allowedTools as unknown[]).filter((s): s is string => typeof s === "string")
      : [],
    llmInvokable: raw.llmInvokable === undefined ? true : Boolean(raw.llmInvokable),
    paths: Array.isArray(raw.paths)
      ? (raw.paths as unknown[]).filter((s): s is string => typeof s === "string")
      : [],
    requiresCtxState:
      raw.requiresCtxState && typeof raw.requiresCtxState === "object" && !Array.isArray(raw.requiresCtxState)
        ? (raw.requiresCtxState as Record<string, boolean>)
        : undefined,
  } as SkillV2
}

/**
 * Merge regex matches + LLM matches; dedupe by playbookKey. Order = regex
 * matches first (safety floor), then LLM-only additions.
 */
function mergeSkillSets(regex: SkillV2[], llm: SkillV2[]): SkillV2[] {
  const seen = new Set<string>()
  const merged: SkillV2[] = []
  for (const s of regex) {
    if (seen.has(s.playbookKey)) continue
    seen.add(s.playbookKey)
    merged.push(s)
  }
  for (const s of llm) {
    if (seen.has(s.playbookKey)) continue
    seen.add(s.playbookKey)
    merged.push(s)
  }
  return merged
}

/**
 * Main entry — pipeline orchestrator.
 */
export async function route(
  messageBody: string,
  ctx: ClaireContext,
  deps: RouteDeps = {}
): Promise<RouteResult> {
  // Load skill catalog
  let catalog: SkillV2[] = []
  if (deps.playbooks) {
    catalog = deps.playbooks.map(toV2)
  } else if (ctx.db ?? deps.db) {
    const db = (deps.db ?? ctx.db) as Firestore
    try {
      const list = await getCachedPlaybooks(db)
      catalog = list.map(toV2)
    } catch {
      catalog = []
    }
  }

  // STEP 1 — regex floor (always active, sub-ms)
  const regexMatched = matchPlaybooks(messageBody, catalog as unknown as Playbook[])
  const regexSkills = regexMatched.map(toV2 as (p: Playbook) => SkillV2)

  // STEP 2 — LLM intent (flag-gated, fail-open)
  const flagOn =
    deps.forceClassifierEnabled !== undefined
      ? deps.forceClassifierEnabled
      : Boolean(ctx.featureFlags?.paSkillsLlmFallbackEnabled)

  let classifierResult: ClassifyResult = {
    skills: [],
    rateLimited: false,
    cacheHit: false,
    latencyMs: 0,
    reason: "disabled",
  }
  if (flagOn) {
    try {
      classifierResult = await classifySkills(
        {
          messageBody,
          ctx,
          skillCatalog: catalog
            .filter((s) => s.llmInvokable)
            .map((s) => ({
              key: s.playbookKey as import("@pa/agent-registry").SkillKey,
              intentDescription: s.intentDescription || s.description,
              llmInvokable: s.llmInvokable,
            })),
        },
        deps.classifyDeps ?? {}
      )
    } catch {
      classifierResult = {
        skills: [],
        rateLimited: false,
        cacheHit: false,
        latencyMs: 0,
        reason: "error",
      }
    }
  }

  const llmSkills: SkillV2[] = classifierResult.skills
    .filter((s) => s.confidence >= 0.6)
    .map((s) => catalog.find((sk) => sk.playbookKey === s.key))
    .filter((sk): sk is SkillV2 => Boolean(sk) && sk!.llmInvokable)

  // STEP 3 — merge regex + LLM (regex first)
  const merged = mergeSkillSets(regexSkills, llmSkills)

  // STEP 4 — stacker (composability, conflicts, ctx-gating, priority sort)
  const stacked: StackedResult = stack(merged, ctx)

  // STEP 5 — audit
  ctx.guardrailHits.push({
    name: "skill-router",
    type: "input",
    tripped: false,
    metadata: {
      regex: regexSkills.map((s) => s.playbookKey),
      llm: llmSkills.map((s) => s.playbookKey),
      pruned: stacked.prunedReasons,
      classifierLatencyMs: classifierResult.latencyMs,
      rateLimited: classifierResult.rateLimited,
      classifierReason: classifierResult.reason,
    },
    latencyMs: classifierResult.latencyMs,
  })

  return {
    activeSkills: stacked.activeSkills,
    addendum: stacked.addendum,
    allowedTools: stacked.allowedTools,
    source: {
      regex: regexSkills.map((s) => s.playbookKey),
      llm: llmSkills.map((s) => s.playbookKey),
    },
    classifierLatencyMs: classifierResult.latencyMs,
    classifierRateLimited: classifierResult.rateLimited,
    prunedReasons: stacked.prunedReasons,
  }
}

/**
 * Module-namespace export to match detail-plan §6.1 reference style:
 *   `SkillRouter.route(messageBody, ctx)`
 */
export const SkillRouter = { route }
