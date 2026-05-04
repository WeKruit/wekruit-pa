/**
 * iter30 WS4-A — SkillStacker.
 *
 * Stacks matched skills (from regex floor + LLM intent) into an ordered active
 * set, applying composability + conflictsWith + ctx-state gating. Returns the
 * concatenated addendum (priority desc) + allowedTools union for WS6
 * OutputGuardrail enforcement.
 *
 * Steps (per ws-4a-detail.md §3.1):
 *   1. ctx-gating: drop skills whose `requires[]` predicates are unmet
 *      (free-form `ctx.<dot.path>` / `ctx.activeSkills:<key>` / `<tag>`).
 *      AND drop skills whose `requiresCtxState` (structured) doesn't match.
 *   2. composability check: skill A with `composableWith=[...]` non-empty AND
 *      skill B not in that list → conflict, resolve by priority desc.
 *   3. explicit conflictsWith: bidirectional, highest priority wins.
 *   4. sort by priority desc; tiebreak by lex (deterministic).
 *   5. concat addenda (priority desc), union allowedTools.
 *
 * SDK handoff caveat (run.d.ts:211): iter30 ships flat addendum-stack only.
 * NO sub-agent handoffs. If you add a handoff post-iter30, you MUST also wire
 * input-guardrail re-entry per ws-3-6-detail.md R-5. See the test gate in
 * skill-stacker.test.ts ("iter30 invariant: no sub-agent handoff").
 */
import type { SkillKey, SkillV2 } from "@pa/agent-registry"
import type { ClaireContext } from "./run-context.js"

export type StackedResult = {
  activeSkills: SkillV2[]
  addendum: string
  allowedTools: string[]
  prunedReasons: PruneRecord[]
}

export type PruneRecord = {
  key: string
  reason: string
}

/**
 * Read a dot-path off an object — used for `ctx.<dot.path>` predicates.
 * Returns `undefined` if any segment is missing/non-object.
 */
function dotGet(obj: unknown, path: string): unknown {
  const segments = path.split(".")
  let cur: unknown = obj
  for (const seg of segments) {
    if (cur === null || typeof cur !== "object") return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

/**
 * Check whether a `requires[]` predicate is satisfied. Three forms:
 *   - "ctx.<dot.path>"           → Boolean(dotGet(ctx, dot.path))
 *   - "ctx.activeSkills:<key>"   → ctx.activeSkills includes <key> OR
 *                                   active set already has <key>
 *   - "<tag>" (capability tag)   → some skill in active provides[] flat-union
 */
export function satisfiesRequirement(
  predicate: string,
  ctx: ClaireContext,
  active: SkillV2[]
): boolean {
  if (!predicate) return true

  // ctx.activeSkills:<key>
  if (predicate.startsWith("ctx.activeSkills:")) {
    const target = predicate.slice("ctx.activeSkills:".length).trim()
    if (!target) return false
    if (ctx.activeSkills?.includes(target)) return true
    return active.some((s) => s.playbookKey === target)
  }

  // ctx.<dot.path>
  if (predicate.startsWith("ctx.")) {
    const path = predicate.slice("ctx.".length)
    const value = dotGet(ctx, path)
    return Boolean(value)
  }

  // capability tag — any active skill provides[] includes this tag
  return active.some((s) => s.provides.includes(predicate))
}

/**
 * Check structured `requiresCtxState` predicates (WS4-B amendment).
 * All set keys must be true on the ctx-state derived from ClaireContext.
 *
 * Derivation (iter30): light-weight inference rather than first-class fields:
 *   - turn_gap_ge_2h: derived from `ctx.recentTurns` timestamps OR a
 *     pre-computed flag if the orchestrator sets one (deferred to iter31).
 *     For iter30 this defaults to FALSE unless pre-set on ctx.
 *   - resume_recently_accepted: ctx.userProfile.resumeAccepted &&
 *     resumeParseCount within recent window (here proxied by resumeAccepted).
 *   - conversation_warmed: ctx.recentTurns.length >= 3
 *   - job_search_active: any active skill provides "intent:job_search" OR
 *     active set includes "headhunter".
 *   - onboarding_completed: ctx.userProfile.onboardingState === "complete"
 */
export function evaluateCtxState(
  ctx: ClaireContext,
  active: SkillV2[]
): {
  turn_gap_ge_2h: boolean
  resume_recently_accepted: boolean
  conversation_warmed: boolean
  job_search_active: boolean
  onboarding_completed: boolean
} {
  // turn_gap_ge_2h — read pre-computed marker if present (orchestrator may
  // set on ctx in iter31). Default false for iter30. Cast through unknown
  // because the field is not part of the strict ClaireContextSchema.
  const turn_gap_ge_2h =
    typeof (ctx as unknown as { turnGapGe2h?: boolean }).turnGapGe2h === "boolean"
      ? Boolean((ctx as unknown as { turnGapGe2h?: boolean }).turnGapGe2h)
      : false

  const resume_recently_accepted = Boolean(ctx.userProfile?.resumeAccepted)
  const conversation_warmed = (ctx.recentTurns?.length ?? 0) >= 3
  // onboarding.ts writes "complete" on q_location_asked → next; legacy v1 also
  // resolves to "complete". "done" was a doc-only typo from earlier draft —
  // never written by any code path.
  const onboarding_completed = ctx.userProfile?.onboardingState === "complete"

  const job_search_active =
    active.some((s) => s.provides.includes("intent:job_search")) ||
    active.some((s) => s.playbookKey === "headhunter") ||
    Boolean(ctx.activeSkills?.includes("headhunter"))

  return {
    turn_gap_ge_2h,
    resume_recently_accepted,
    conversation_warmed,
    job_search_active,
    onboarding_completed,
  }
}

function structuredRequirementMet(skill: SkillV2, ctx: ClaireContext, active: SkillV2[]): boolean {
  if (!skill.requiresCtxState) return true
  const state = evaluateCtxState(ctx, active)
  for (const [key, required] of Object.entries(skill.requiresCtxState)) {
    if (!required) continue
    if (!state[key as keyof typeof state]) return false
  }
  return true
}

/**
 * Compare two skills for tie-resolution. Returns the LOSER (the one to drop).
 * Higher priority wins; equal priority breaks by lex order (a > b → a is loser
 * to keep deterministic).
 */
function pickLoser(a: SkillV2, b: SkillV2): SkillV2 {
  if (a.priority !== b.priority) {
    return a.priority < b.priority ? a : b
  }
  // equal priority — lex tiebreak (alphabetically later loses)
  return a.playbookKey > b.playbookKey ? a : b
}

/**
 * Main entrypoint — stack matched skills into an active set.
 *
 * Pure function (no Firestore reads, no LLM calls) — deterministic given
 * (matched, ctx).
 */
export function stack(matched: SkillV2[], ctx: ClaireContext): StackedResult {
  const pruned: PruneRecord[] = []

  // STEP 1 — ctx-gating: drop skills whose requires[] / requiresCtxState are unmet.
  // Pass 1: free-form `requires[]` (capability tags + ctx.dot-paths).
  // We seed `active` empty and iterate matched in input order; skills that
  // depend on other skills via tag may need 2-pass — for iter30 the 6
  // existing skills have requires=[], so single-pass is correct.
  let active: SkillV2[] = []
  for (const sk of matched) {
    const unmet = sk.requires.filter((req) => !satisfiesRequirement(req, ctx, active))
    if (unmet.length > 0) {
      pruned.push({ key: sk.playbookKey, reason: `requires-unmet:${unmet.join(",")}` })
      continue
    }
    if (!structuredRequirementMet(sk, ctx, active)) {
      const ks = Object.entries(sk.requiresCtxState ?? {})
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join(",")
      pruned.push({
        key: sk.playbookKey,
        reason: `requiresCtxState-unmet:${ks}`,
      })
      continue
    }
    active.push(sk)
  }

  // STEP 2 — composability check: skill A's composableWith non-empty AND
  // some active B not listed → conflict, resolve by priority.
  // Iterate over a snapshot so removals during iteration are safe.
  for (const a of [...active]) {
    if (!active.includes(a)) continue
    const aRestricts = a.composableWith.length > 0
    if (!aRestricts) continue
    for (const b of [...active]) {
      if (a.playbookKey === b.playbookKey) continue
      if (!active.includes(b)) continue
      const bAllowed = a.composableWith.includes(b.playbookKey as SkillKey)
      if (!bAllowed) {
        const loser = pickLoser(a, b)
        const idx = active.indexOf(loser)
        if (idx >= 0) {
          active.splice(idx, 1)
          pruned.push({
            key: loser.playbookKey,
            reason: `composability-conflict:${a.playbookKey}<>${b.playbookKey}`,
          })
        }
      }
    }
  }

  // STEP 3 — explicit conflictsWith resolution: bidirectional, highest priority wins.
  // Iterate snapshot; remove losers in-place.
  for (const a of [...active]) {
    if (!active.includes(a)) continue
    for (const b of [...active]) {
      if (a.playbookKey === b.playbookKey) continue
      if (!active.includes(b)) continue
      const conflicts =
        a.conflictsWith.includes(b.playbookKey as SkillKey) ||
        b.conflictsWith.includes(a.playbookKey as SkillKey)
      if (conflicts) {
        const loser = pickLoser(a, b)
        const idx = active.indexOf(loser)
        if (idx >= 0) {
          active.splice(idx, 1)
          pruned.push({
            key: loser.playbookKey,
            reason: `conflictsWith:${a.playbookKey}<>${b.playbookKey}`,
          })
        }
      }
    }
  }

  // STEP 4 — sort by priority desc (highest first → strongest directive top).
  active = active.slice().sort(
    (x, y) => y.priority - x.priority || x.playbookKey.localeCompare(y.playbookKey)
  )

  // STEP 5 — concat addenda + union allowedTools.
  const addendum = active
    .map((s) => s.addendum)
    .filter((x) => typeof x === "string" && x.trim().length > 0)
    .join("\n\n")
  const allowedTools = Array.from(new Set(active.flatMap((s) => s.allowedTools)))

  return { activeSkills: active, addendum, allowedTools, prunedReasons: pruned }
}

/**
 * Convenience — stack and apply audit-row writeback. Wraps `stack()` and
 * appends a `skill-stacker` guardrail audit row to ctx (per detail-plan §3.2).
 *
 * Mutates ctx — designed to be called from SkillRouter.route().
 */
export function stackWithAudit(
  matched: SkillV2[],
  ctx: ClaireContext,
  latencyMs = 0
): StackedResult {
  const result = stack(matched, ctx)
  ctx.guardrailHits.push({
    name: "skill-stacker",
    type: "input",
    tripped: false,
    metadata: {
      matched: matched.map((s) => s.playbookKey),
      active: result.activeSkills.map((s) => s.playbookKey),
      pruned: result.prunedReasons,
    },
    latencyMs,
  })
  return result
}
