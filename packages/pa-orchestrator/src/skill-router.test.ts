/**
 * iter30 WS4-A — SkillRouter integration tests.
 *
 * Test gates (per ws-4a-detail.md §10.2):
 *   - regex+LLM merge: vent regex hit + LLM returns headhunter (conflict).
 *     Assert: vent wins, headhunter pruned, audit reason populated.
 *   - flag OFF: classifier never called, regex-only behavior.
 *   - audit row: skill-router guardrail hit appended.
 *   - regex floor crisis msg always tripped (priority over LLM intent).
 */
import assert from "node:assert/strict"
import test from "node:test"

import { SkillSchemaV2, type Playbook, type SkillV2 } from "@pa/agent-registry"
import { route, SkillRouter } from "./skill-router.js"
import { _clearClassifierCache } from "./skill-intent-classifier.js"
import { createMockContext } from "./run-context.js"

// ---------------------------------------------------------------------------
// Test fixtures — V2 catalog as Playbook[] (with V2 fields attached)
// ---------------------------------------------------------------------------

function makeCatalog(): Playbook[] {
  // Synthesize V2 docs and cast to Playbook (V1 superset with V2 fields).
  const fixtures: SkillV2[] = [
    SkillSchemaV2.parse({
      playbookKey: "vent_support",
      name: "Vent",
      addendum: "VENT BODY",
      regexTriggers: ["崩溃|烦死|emo|burnt out|exhausted"],
      enabled: true,
      provides: ["stance:companion"],
      composableWith: ["motivation_nudge", "interview_prep"],
      conflictsWith: ["headhunter", "jd_roast"],
      priority: 80,
      llmInvokable: true,
    }),
    SkillSchemaV2.parse({
      playbookKey: "motivation_nudge",
      name: "Motivation",
      addendum: "MOTIVATION BODY",
      regexTriggers: ["拖延|没动力|deadline.*天"],
      enabled: true,
      composableWith: ["vent_support", "interview_prep"],
      conflictsWith: [],
      priority: 60,
      llmInvokable: true,
    }),
    SkillSchemaV2.parse({
      playbookKey: "headhunter",
      name: "Headhunter",
      addendum: "HEADHUNTER BODY",
      regexTriggers: ["想换|在看工作|new role"],
      enabled: true,
      composableWith: ["jd_roast", "interview_prep", "negotiation"],
      conflictsWith: ["vent_support"],
      priority: 40,
      llmInvokable: true,
    }),
    SkillSchemaV2.parse({
      playbookKey: "interview_prep",
      name: "Interview",
      addendum: "INTERVIEW BODY",
      regexTriggers: ["面试.*紧张|onsite tomorrow|interview prep"],
      enabled: true,
      composableWith: ["headhunter", "vent_support", "motivation_nudge"],
      conflictsWith: [],
      priority: 55,
      llmInvokable: true,
    }),
  ]
  return fixtures as unknown as Playbook[]
}

// ---------------------------------------------------------------------------
// Regex+LLM merge tests
// ---------------------------------------------------------------------------

test("regex+LLM merge: vent regex hit + LLM headhunter → vent wins (conflict)", async () => {
  _clearClassifierCache()
  const ctx = createMockContext({
    featureFlags: {
      paHumanizeRuntimeEnabled: false,
      paOnboardingProbeV2Enabled: false,
      paOnboardingIntentAckEnabled: true,
      paSafetyCheckEnabled: true,
      paSafetyIllegalContentEnabled: false,
      paSafetyRateAbuse24hEnabled: false,
      paCrisisHotlineInjectionEnabled: true,
      paVoiceMirrorDisabled: false,
      paABFrameworkStrippingEnabled: true,
      paImperfectionInjectorArm: "off",
      paSkillsLlmFallbackEnabled: true,
    },
  })
  const llmCall = async () =>
    JSON.stringify({
      skills: [{ key: "headhunter", confidence: 0.85 }],
      reason: "user mentioned wanting to switch jobs",
    })
  const result = await route("我崩溃了 但是想换工作", ctx, {
    playbooks: makeCatalog(),
    classifyDeps: { llmCall },
  })
  // vent_support wins the conflict
  assert.equal(result.activeSkills.length, 1)
  assert.equal(result.activeSkills[0].playbookKey, "vent_support")
  // both sources recorded
  assert.ok(result.source.regex.includes("vent_support"))
  assert.ok(result.source.llm.includes("headhunter"))
  // headhunter pruned
  const prunedKeys = result.prunedReasons.map((p) => p.key)
  assert.ok(prunedKeys.includes("headhunter"))
})

test("flag OFF: classifier never called, regex-only behavior", async () => {
  _clearClassifierCache()
  const ctx = createMockContext()
  let llmCalls = 0
  const llmCall = async () => {
    llmCalls++
    return ""
  }
  const result = await route("我崩溃了", ctx, {
    playbooks: makeCatalog(),
    classifyDeps: { llmCall },
    forceClassifierEnabled: false,
  })
  assert.equal(llmCalls, 0, "classifier should not be called when flag OFF")
  assert.deepEqual(result.source.llm, [])
  assert.ok(result.source.regex.includes("vent_support"))
  assert.equal(result.classifierLatencyMs, 0)
})

test("audit row: skill-router guardrail hit appended", async () => {
  _clearClassifierCache()
  const ctx = createMockContext()
  await route("无关消息没匹配", ctx, {
    playbooks: makeCatalog(),
    forceClassifierEnabled: false,
  })
  assert.ok(ctx.guardrailHits.length >= 1)
  const hit = ctx.guardrailHits.find((h) => h.name === "skill-router")
  assert.ok(hit, "skill-router audit row appended")
  assert.equal(hit?.tripped, false)
})

test("LLM intent: confidence below 0.6 filtered out", async () => {
  _clearClassifierCache()
  const ctx = createMockContext()
  const llmCall = async () =>
    JSON.stringify({
      skills: [{ key: "headhunter", confidence: 0.5 }], // below threshold
    })
  const result = await route("无关消息", ctx, {
    playbooks: makeCatalog(),
    classifyDeps: { llmCall },
    forceClassifierEnabled: true,
  })
  assert.deepEqual(result.source.llm, [])
})

test("LLM intent: llmInvokable=false skill excluded even if classifier returns it", async () => {
  _clearClassifierCache()
  const ctx = createMockContext()
  const catalog = makeCatalog()
  // Mark headhunter as not-llm-invokable (regex-only)
  const customCat = catalog.map((p) => {
    if (p.playbookKey === "headhunter") {
      const v2 = p as unknown as SkillV2
      const next = SkillSchemaV2.parse({ ...v2, llmInvokable: false })
      return next as unknown as Playbook
    }
    return p
  })
  const llmCall = async () =>
    JSON.stringify({
      skills: [{ key: "headhunter", confidence: 0.9 }],
    })
  const result = await route("无关消息", ctx, {
    playbooks: customCat,
    classifyDeps: { llmCall },
    forceClassifierEnabled: true,
  })
  assert.deepEqual(result.source.llm, [], "llmInvokable=false → not stacked from LLM intent")
})

test("merge: regex hit dedupes when LLM returns same skill", async () => {
  _clearClassifierCache()
  const ctx = createMockContext()
  const llmCall = async () =>
    JSON.stringify({
      skills: [{ key: "vent_support", confidence: 0.92 }],
    })
  const result = await route("我崩溃了", ctx, {
    playbooks: makeCatalog(),
    classifyDeps: { llmCall },
    forceClassifierEnabled: true,
  })
  assert.equal(result.activeSkills.length, 1)
  assert.equal(result.activeSkills[0].playbookKey, "vent_support")
  // both sources record the same skill — dedupe in merge
  assert.ok(result.source.regex.includes("vent_support"))
  assert.ok(result.source.llm.includes("vent_support"))
})

test("classifier rate-limited → rateLimited propagated; regex still works", async () => {
  _clearClassifierCache()
  const ctx = createMockContext()
  const llmCall = async () => {
    throw new Error("429 rate limit")
  }
  const result = await route("我崩溃了", ctx, {
    playbooks: makeCatalog(),
    classifyDeps: { llmCall },
    forceClassifierEnabled: true,
  })
  assert.equal(result.classifierRateLimited, true)
  // regex floor still active
  assert.ok(result.source.regex.includes("vent_support"))
  assert.equal(result.activeSkills.length, 1)
})

test("composability: vent + motivation both stack via regex hit", async () => {
  _clearClassifierCache()
  const ctx = createMockContext()
  const result = await route("我崩溃了 而且 deadline 还有 2 天", ctx, {
    playbooks: makeCatalog(),
    forceClassifierEnabled: false,
  })
  // both regex match and stack (vent composableWith includes motivation_nudge)
  assert.equal(result.activeSkills.length, 2)
  const keys = result.activeSkills.map((s) => s.playbookKey)
  assert.deepEqual(keys, ["vent_support", "motivation_nudge"], "priority desc")
})

test("SkillRouter namespace export: route accessible", () => {
  assert.equal(typeof SkillRouter.route, "function")
})

// ---------------------------------------------------------------------------
// Regex floor priority — crisis-class msg ALWAYS tripped over LLM intent
// ---------------------------------------------------------------------------

test("regex floor priority: vent regex always wins over LLM headhunter", async () => {
  _clearClassifierCache()
  const ctx = createMockContext({
    featureFlags: {
      paHumanizeRuntimeEnabled: false,
      paOnboardingProbeV2Enabled: false,
      paOnboardingIntentAckEnabled: true,
      paSafetyCheckEnabled: true,
      paSafetyIllegalContentEnabled: false,
      paSafetyRateAbuse24hEnabled: false,
      paCrisisHotlineInjectionEnabled: true,
      paVoiceMirrorDisabled: false,
      paABFrameworkStrippingEnabled: true,
      paImperfectionInjectorArm: "off",
      paSkillsLlmFallbackEnabled: true,
    },
  })
  // LLM mistakenly returns headhunter for a vent message; regex floor catches vent.
  const llmCall = async () =>
    JSON.stringify({
      skills: [{ key: "headhunter", confidence: 0.95 }],
      reason: "ll-misclassified",
    })
  const result = await route("我崩溃了 烦死了", ctx, {
    playbooks: makeCatalog(),
    classifyDeps: { llmCall },
    forceClassifierEnabled: true,
  })
  // vent (regex hit) wins — headhunter pruned via conflictsWith
  assert.equal(result.activeSkills[0].playbookKey, "vent_support")
})
