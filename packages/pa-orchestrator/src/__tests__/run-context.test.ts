/**
 * iter30 WS3 — `run-context.ts` unit tests.
 *
 * Coverage:
 *  1. Zod parse round-trip for `ClaireContextSchema` — ensures every
 *     readonly + mutable field is shaped per detail-plan §3.
 *  2. `createMockContext` partial override semantics — required fields
 *     fall through to safe defaults, callers may override any subset.
 *  3. `freezeContext` immutability invariants — readonly buckets throw
 *     on write; mutable buckets stay writable for guardrails.
 */

import assert from "node:assert/strict"
import test from "node:test"
import { z } from "zod"
import {
  ClaireContextSchema,
  FeatureFlagsSchema,
  buildMockCtx,
  createMockContext,
  freezeContext,
  type ClaireContext,
  type GuardrailHit,
} from "../run-context.js"

// ---------------------------------------------------------------------------

test("ClaireContextSchema parses a fully populated ctx round-trip", () => {
  const draft = createMockContext({
    locale: "en-US",
    userProfile: {
      role: "swe",
      yoe: 5,
      visa: "h1b",
      location: "sf",
      onboardingState: "done",
      preferences: [
        {
          tagKey: "remote_only",
          type: "preference",
          confidence: 0.92,
          lastReinforced: "2026-05-03T00:00:00.000Z",
        },
      ],
      resumeAccepted: true,
      resumeParseCount: 2,
    },
    weightTables: {
      "ai-agent-2026": [
        { skillKey: "rag", weight: 1.5, reason: "core" },
        { skillKey: "evals", weight: 1.2 },
      ],
    },
  })
  // Re-parse should be idempotent.
  const reparsed = ClaireContextSchema.parse(draft)
  assert.equal(reparsed.userId, draft.userId)
  assert.equal(reparsed.userProfile.role, "swe")
  assert.equal(reparsed.userProfile.preferences[0]?.tagKey, "remote_only")
  assert.equal(reparsed.weightTables["ai-agent-2026"]?.length, 2)
  assert.equal(reparsed.featureFlags.paOnboardingIntentAckEnabled, true)
})

test("ClaireContextSchema rejects an invalid locale enum", () => {
  assert.throws(
    () =>
      ClaireContextSchema.parse({
        ...createMockContext(),
        locale: "fr-FR" as unknown as ClaireContext["locale"],
      }),
    (err) => err instanceof z.ZodError
  )
})

test("ClaireContextSchema rejects empty userId / agentId", () => {
  assert.throws(
    () => createMockContext({ userId: "" }),
    (err) => err instanceof z.ZodError
  )
  assert.throws(
    () => createMockContext({ agentId: "" }),
    (err) => err instanceof z.ZodError
  )
})

test("FeatureFlagsSchema seeds production-on defaults", () => {
  const flags = FeatureFlagsSchema.parse({})
  assert.equal(flags.paOnboardingIntentAckEnabled, true)
  assert.equal(flags.paSafetyCheckEnabled, true)
  assert.equal(flags.paCrisisHotlineInjectionEnabled, true)
  assert.equal(flags.paABFrameworkStrippingEnabled, true)
  // Off-by-default flags.
  assert.equal(flags.paHumanizeRuntimeEnabled, false)
  assert.equal(flags.paOnboardingProbeV2Enabled, false)
  assert.equal(flags.paImperfectionInjectorArm, "off")
})

// ---------------------------------------------------------------------------

test("createMockContext: partial override merges over defaults", () => {
  const ctx = createMockContext({
    crisisTripped: true,
    activeSkills: ["jdRoast", "cvFollowup"],
  })
  assert.equal(ctx.crisisTripped, true)
  assert.deepEqual(ctx.activeSkills, ["jdRoast", "cvFollowup"])
  // Untouched defaults preserved.
  assert.equal(ctx.userId, "test-user-1")
  assert.equal(ctx.locale, "zh-CN")
  assert.equal(ctx.featureFlags.paSafetyCheckEnabled, true)
})

test("createMockContext: override deeply replaces nested userProfile", () => {
  const ctx = createMockContext({
    userProfile: {
      role: "pm",
      preferences: [],
      resumeAccepted: false,
      resumeParseCount: 0,
    },
  })
  assert.equal(ctx.userProfile.role, "pm")
})

test("buildMockCtx is the same factory as createMockContext", () => {
  assert.equal(buildMockCtx, createMockContext)
})

// ---------------------------------------------------------------------------

test("freezeContext: readonly bucket throws on write in strict mode", () => {
  const ctx = freezeContext(createMockContext())
  assert.throws(
    () => {
      ;(ctx as ClaireContext).userId = "mutated"
    },
    /read.?only|cannot assign|object is not extensible|Cannot redefine/i
  )
  assert.throws(
    () => {
      ;(ctx.userProfile as { role?: string }).role = "mutated"
    },
    /read.?only|cannot assign|object is not extensible|Cannot redefine/i
  )
})

test("freezeContext: mutable buckets stay writable for guardrails", () => {
  const ctx = freezeContext(createMockContext())
  // crisisTripped is mutable — write succeeds.
  ctx.crisisTripped = true
  assert.equal(ctx.crisisTripped, true)
  // guardrailHits append.
  const hit: GuardrailHit = {
    name: "crisisDetector",
    type: "input",
    tripped: true,
    latencyMs: 3,
  }
  ctx.guardrailHits.push(hit)
  assert.equal(ctx.guardrailHits.length, 1)
  assert.equal(ctx.guardrailHits[0]?.name, "crisisDetector")
  // activeSkills mutate (WS4 SkillStacker).
  ctx.activeSkills.push("jdRoast")
  ctx.skillAddendum = "addendum text"
  assert.equal(ctx.activeSkills[0], "jdRoast")
  assert.equal(ctx.skillAddendum, "addendum text")
})

test("freezeContext: top-level seal blocks adding new keys", () => {
  const ctx = freezeContext(createMockContext())
  assert.throws(() => {
    ;(ctx as unknown as Record<string, unknown>).bogusField = 1
  }, /not extensible|cannot add|object is sealed/i)
})

test("freezeContext: nested arrays in readonly buckets are frozen", () => {
  const ctx = freezeContext(
    createMockContext({
      memorySnapshot: [],
      recentTurns: [],
    })
  )
  assert.equal(Object.isFrozen(ctx.memorySnapshot), true)
  assert.equal(Object.isFrozen(ctx.recentTurns), true)
})
