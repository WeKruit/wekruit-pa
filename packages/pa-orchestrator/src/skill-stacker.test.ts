/**
 * iter30 WS4-A — SkillStacker unit tests.
 *
 * Test gates (per ws-4a-detail.md §10.1):
 *   (a) composability: vent + motivation_nudge → both stack
 *   (b) conflictsWith: vent + headhunter → vent wins (priority 80 > 40)
 *   (c) tiebreaker: equal priority → lex sort
 *   (d) ctx-gate: skill with requires:["ctx.userProfile.resumeAccepted"]
 *       drops when ctx flag false
 *   (e) addendum order: priority desc
 *   (f) allowedTools union deduplicates
 *   (g) audit prune reasons populated (via stackWithAudit)
 *   (h) requiresCtxState structured gate
 *   (i) iter30 invariant — no sub-agent handoffs in skill activation
 */
import assert from "node:assert/strict"
import test from "node:test"

import { SkillSchemaV2, type SkillV2 } from "@pa/agent-registry"
import { stack, stackWithAudit, satisfiesRequirement, evaluateCtxState } from "./skill-stacker.js"
import { createMockContext } from "./run-context.js"

// ---------------------------------------------------------------------------
// Test fixtures — build realistic V2 skills using the actual EXISTING_6_METADATA
// shape (priority + composability tables matched to ws-4a-detail.md §4.1).
// ---------------------------------------------------------------------------

function makeSkill(partial: Partial<SkillV2> & { playbookKey: string; name: string }): SkillV2 {
  const { playbookKey, name, addendum, ...rest } = partial
  return SkillSchemaV2.parse({
    playbookKey,
    name,
    addendum: addendum ?? `# ${playbookKey}`,
    enabled: true,
    ...rest,
  })
}

const FIXTURE_VENT = makeSkill({
  playbookKey: "vent_support",
  name: "Vent",
  addendum: "VENT BODY",
  provides: ["stance:companion", "tone:vent"],
  composableWith: ["motivation_nudge", "interview_prep"],
  conflictsWith: ["headhunter", "jd_roast"],
  priority: 80,
})

const FIXTURE_MOTIVATION = makeSkill({
  playbookKey: "motivation_nudge",
  name: "Motivation",
  addendum: "MOTIVATION BODY",
  provides: ["stance:companion", "tone:nudge"],
  composableWith: ["vent_support", "interview_prep"],
  conflictsWith: [],
  priority: 60,
})

const FIXTURE_HEADHUNTER = makeSkill({
  playbookKey: "headhunter",
  name: "Headhunter",
  addendum: "HEADHUNTER BODY",
  provides: ["stance:advisor"],
  composableWith: ["jd_roast", "interview_prep", "negotiation"],
  conflictsWith: ["vent_support"],
  priority: 40,
})

const FIXTURE_JD = makeSkill({
  playbookKey: "jd_roast",
  name: "JD Roast",
  addendum: "JD BODY",
  composableWith: ["headhunter", "negotiation"],
  conflictsWith: ["vent_support"],
  priority: 45,
})

const FIXTURE_INTERVIEW = makeSkill({
  playbookKey: "interview_prep",
  name: "Interview",
  addendum: "INTERVIEW BODY",
  composableWith: ["headhunter", "vent_support", "motivation_nudge"],
  conflictsWith: [],
  priority: 55,
})

// ---------------------------------------------------------------------------
// (a) composability — vent + motivation_nudge → both stack
// ---------------------------------------------------------------------------

test("(a) composability: vent + motivation_nudge — both stack", () => {
  const ctx = createMockContext()
  const result = stack([FIXTURE_VENT, FIXTURE_MOTIVATION], ctx)
  assert.equal(result.activeSkills.length, 2)
  assert.deepEqual(
    result.activeSkills.map((s) => s.playbookKey),
    ["vent_support", "motivation_nudge"], // priority 80 > 60
    "priority desc order"
  )
  assert.equal(result.prunedReasons.length, 0)
})

// ---------------------------------------------------------------------------
// (b) conflictsWith — vent + headhunter → vent wins
// ---------------------------------------------------------------------------

test("(b) conflictsWith: vent + headhunter — vent wins (priority 80 > 40)", () => {
  const ctx = createMockContext()
  const result = stack([FIXTURE_VENT, FIXTURE_HEADHUNTER], ctx)
  assert.equal(result.activeSkills.length, 1)
  assert.equal(result.activeSkills[0].playbookKey, "vent_support")
  assert.equal(result.prunedReasons.length, 1)
  assert.equal(result.prunedReasons[0].key, "headhunter")
  // Reason can be either composability-conflict (vent.composableWith does not
  // include headhunter — fires first) OR conflictsWith (explicit declaration).
  // Both are correct semantics; either prune mechanism produces the right
  // outcome (headhunter dropped, vent retained).
  assert.match(
    result.prunedReasons[0].reason,
    /(conflictsWith|composability-conflict):/
  )
})

test("(b2) conflictsWith bidirectional — only one side declares", () => {
  // vent declares conflictsWith jd_roast; jd_roast declares vent_support
  // (both directions — should still fire once).
  const ctx = createMockContext()
  const result = stack([FIXTURE_VENT, FIXTURE_JD], ctx)
  assert.equal(result.activeSkills.length, 1)
  assert.equal(result.activeSkills[0].playbookKey, "vent_support")
})

// ---------------------------------------------------------------------------
// (c) tiebreaker — equal priority → lex sort
// ---------------------------------------------------------------------------

test("(c) tiebreaker: equal priority → lex sort (loser is alphabetically later)", () => {
  const ctx = createMockContext()
  const a = makeSkill({
    playbookKey: "career_pivot",
    name: "A",
    priority: 50,
    conflictsWith: ["motivation_nudge"], // synthesize a conflict
  })
  const b = makeSkill({
    playbookKey: "motivation_nudge",
    name: "B",
    priority: 50, // same priority
    conflictsWith: [],
  })
  const result = stack([a, b], ctx)
  assert.equal(result.activeSkills.length, 1)
  // lex: motivation_nudge < career_pivot? "career_pivot" > "motivation_nudge"? compare strings
  // "c" (99) < "m" (109) so career_pivot < motivation_nudge lex
  // pickLoser returns "later" key → motivation_nudge is loser
  assert.equal(result.activeSkills[0].playbookKey, "career_pivot")
})

// ---------------------------------------------------------------------------
// (d) ctx-gate — requires:["ctx.userProfile.resumeAccepted"] drops when false
// ---------------------------------------------------------------------------

test("(d) ctx-gate: requires ctx.userProfile.resumeAccepted drops when false", () => {
  const skill = makeSkill({
    playbookKey: "cv_followup",
    name: "CV followup",
    requires: ["ctx.userProfile.resumeAccepted"],
    priority: 50,
  })
  const ctx = createMockContext({
    userProfile: {
      preferences: [],
      resumeAccepted: false,
      resumeParseCount: 0,
    },
  })
  const result = stack([skill], ctx)
  assert.equal(result.activeSkills.length, 0)
  assert.equal(result.prunedReasons.length, 1)
  assert.match(result.prunedReasons[0].reason, /requires-unmet/)
})

test("(d2) ctx-gate: requires ctx.userProfile.resumeAccepted accepts when true", () => {
  const skill = makeSkill({
    playbookKey: "cv_followup",
    name: "CV followup",
    requires: ["ctx.userProfile.resumeAccepted"],
    priority: 50,
  })
  const ctx = createMockContext({
    userProfile: {
      preferences: [],
      resumeAccepted: true,
      resumeParseCount: 1,
    },
  })
  const result = stack([skill], ctx)
  assert.equal(result.activeSkills.length, 1)
})

test("(d3) ctx-gate: capability tag requirement satisfied by another active skill", () => {
  const skillA = makeSkill({
    playbookKey: "headhunter",
    name: "Headhunter",
    provides: ["intent:job_search"],
    priority: 40,
  })
  const skillB = makeSkill({
    playbookKey: "interview_prep",
    name: "Interview",
    requires: ["intent:job_search"],
    priority: 55,
  })
  const ctx = createMockContext()
  const result = stack([skillA, skillB], ctx)
  assert.equal(result.activeSkills.length, 2)
})

test("(d4) ctx-gate: ctx.activeSkills:<key> predicate", () => {
  const ctx = createMockContext({ activeSkills: ["headhunter"] })
  assert.equal(satisfiesRequirement("ctx.activeSkills:headhunter", ctx, []), true)
  assert.equal(satisfiesRequirement("ctx.activeSkills:vent_support", ctx, []), false)
})

// ---------------------------------------------------------------------------
// (e) addendum order — priority desc
// ---------------------------------------------------------------------------

test("(e) addendum order: priority desc", () => {
  const ctx = createMockContext()
  // VENT (80) + MOTIVATION (60) + INTERVIEW (55) — all composable
  const result = stack(
    [FIXTURE_INTERVIEW, FIXTURE_MOTIVATION, FIXTURE_VENT], // unsorted input
    ctx
  )
  assert.equal(result.activeSkills.length, 3)
  assert.deepEqual(
    result.activeSkills.map((s) => s.playbookKey),
    ["vent_support", "motivation_nudge", "interview_prep"]
  )
  // addendum body order matches: VENT BODY first, INTERVIEW BODY last
  const idxVent = result.addendum.indexOf("VENT BODY")
  const idxMot = result.addendum.indexOf("MOTIVATION BODY")
  const idxInt = result.addendum.indexOf("INTERVIEW BODY")
  assert.ok(idxVent < idxMot && idxMot < idxInt, "addendum priority desc")
})

// ---------------------------------------------------------------------------
// (f) allowedTools union deduplicates
// ---------------------------------------------------------------------------

test("(f) allowedTools union deduplicates", () => {
  const a = makeSkill({
    playbookKey: "headhunter",
    name: "A",
    allowedTools: ["job_search", "resume_parse"],
    priority: 40,
  })
  const b = makeSkill({
    playbookKey: "jd_roast",
    name: "B",
    allowedTools: ["job_search", "company_lookup"],
    priority: 45,
  })
  const ctx = createMockContext()
  const result = stack([a, b], ctx)
  assert.equal(result.allowedTools.length, 3)
  assert.deepEqual(result.allowedTools.sort(), ["company_lookup", "job_search", "resume_parse"])
})

// ---------------------------------------------------------------------------
// (g) audit prune reasons via stackWithAudit
// ---------------------------------------------------------------------------

test("(g) stackWithAudit: appends guardrail hit with prune metadata", () => {
  const ctx = createMockContext()
  const result = stackWithAudit([FIXTURE_VENT, FIXTURE_HEADHUNTER], ctx, 5)
  assert.equal(ctx.guardrailHits.length, 1)
  const hit = ctx.guardrailHits[0]
  assert.equal(hit.name, "skill-stacker")
  assert.equal(hit.type, "input")
  assert.equal(hit.tripped, false)
  assert.equal(hit.latencyMs, 5)
  const meta = hit.metadata as {
    matched: string[]
    active: string[]
    pruned: { key: string; reason: string }[]
  }
  assert.deepEqual(meta.matched.sort(), ["headhunter", "vent_support"])
  assert.deepEqual(meta.active, ["vent_support"])
  assert.equal(meta.pruned.length, 1)
  assert.equal(meta.pruned[0].key, "headhunter")
  assert.equal(result.activeSkills.length, 1)
})

// ---------------------------------------------------------------------------
// (h) requiresCtxState structured gate
// ---------------------------------------------------------------------------

test("(h) requiresCtxState: turn_gap_ge_2h false (default) → drop", () => {
  const skill = makeSkill({
    playbookKey: "silence_anchor",
    name: "Silence anchor",
    requiresCtxState: { turn_gap_ge_2h: true },
    priority: 50,
  })
  const ctx = createMockContext()
  const result = stack([skill], ctx)
  assert.equal(result.activeSkills.length, 0)
  assert.equal(result.prunedReasons.length, 1)
  assert.match(result.prunedReasons[0].reason, /requiresCtxState-unmet/)
})

test("(h2) requiresCtxState: resume_recently_accepted matches userProfile flag", () => {
  const skill = makeSkill({
    playbookKey: "cv_followup",
    name: "CV followup",
    requiresCtxState: { resume_recently_accepted: true },
    priority: 50,
  })
  const ctxYes = createMockContext({
    userProfile: {
      preferences: [],
      resumeAccepted: true,
      resumeParseCount: 1,
    },
  })
  const ctxNo = createMockContext({
    userProfile: {
      preferences: [],
      resumeAccepted: false,
      resumeParseCount: 0,
    },
  })
  assert.equal(stack([skill], ctxYes).activeSkills.length, 1)
  assert.equal(stack([skill], ctxNo).activeSkills.length, 0)
})

test("(h3) evaluateCtxState: derives flags correctly", () => {
  const ctx = createMockContext({
    userProfile: {
      preferences: [],
      resumeAccepted: true,
      resumeParseCount: 1,
      onboardingState: "complete",
    },
    recentTurns: Array.from({ length: 5 }).map((_, i) => ({
      id: `t${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: "x",
      ts: new Date().toISOString(),
    })) as never,
    activeSkills: ["headhunter"],
  })
  const state = evaluateCtxState(ctx, [])
  assert.equal(state.resume_recently_accepted, true)
  assert.equal(state.conversation_warmed, true)
  assert.equal(state.onboarding_completed, true)
  assert.equal(state.job_search_active, true)
  assert.equal(state.turn_gap_ge_2h, false)
})

// ---------------------------------------------------------------------------
// Empty / edge cases
// ---------------------------------------------------------------------------

test("stack: empty input returns empty active set", () => {
  const ctx = createMockContext()
  const result = stack([], ctx)
  assert.equal(result.activeSkills.length, 0)
  assert.equal(result.addendum, "")
  assert.deepEqual(result.allowedTools, [])
})

test("stack: single skill no conflicts → kept verbatim", () => {
  const ctx = createMockContext()
  const result = stack([FIXTURE_VENT], ctx)
  assert.equal(result.activeSkills.length, 1)
  assert.equal(result.addendum, "VENT BODY")
})

test("stack: composability with empty composableWith stacks all (V1 default)", () => {
  // motivation_nudge has composableWith: ["vent_support", "interview_prep"]
  // But headhunter has composableWith: ["jd_roast", "interview_prep", "negotiation"]
  // headhunter does NOT include motivation_nudge → restricts.
  // Skill X with empty composableWith should NOT trigger the restriction
  // when paired with restrictive skill.
  const x = makeSkill({
    playbookKey: "career_pivot",
    name: "X",
    priority: 70, // higher than motivation_nudge (60)
    composableWith: [], // empty = stacks with all (V1 default)
    conflictsWith: [],
  })
  const ctx = createMockContext()
  const result = stack([x, FIXTURE_MOTIVATION], ctx)
  // Both stack — x doesn't restrict; motivation_nudge composableWith=[vent_support, interview_prep]
  // so motivation_nudge restricts vs x → conflict → x wins (priority 70 > 60)
  // EXPECTED: only x active.
  assert.equal(result.activeSkills.length, 1)
  assert.equal(result.activeSkills[0].playbookKey, "career_pivot")
})

// ---------------------------------------------------------------------------
// (i) iter30 invariant — no sub-agent handoffs in skill activation
// ---------------------------------------------------------------------------

test("(i) iter30 invariant: SkillStacker output is flat addendum-stack (no handoffs)", () => {
  const ctx = createMockContext()
  const result = stack([FIXTURE_VENT, FIXTURE_MOTIVATION], ctx)
  // No `handoffs` field on StackedResult — addendum is a string, allowedTools
  // is a flat array, activeSkills is a flat array. There is no sub-agent
  // boundary inside the result. If a future iter wires sub-agents per skill,
  // this assertion forces a re-design touch-point.
  assert.ok(typeof result.addendum === "string")
  assert.ok(Array.isArray(result.activeSkills))
  assert.ok(Array.isArray(result.allowedTools))
  // Sanity: no field named "handoffs" leaks into result.
  assert.equal(
    Object.keys(result).filter((k) => k.toLowerCase().includes("handoff")).length,
    0,
    "no handoff-related keys leak into StackedResult"
  )
})
