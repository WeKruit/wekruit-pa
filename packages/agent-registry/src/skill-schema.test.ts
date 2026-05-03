/**
 * iter30 WS4-A — SkillSchemaV2 backward-compat tests.
 *
 * Test gates (per ws-4a-detail.md §10.1):
 *   (a) V1 doc → V2 type via fromSkillSnap (each of 6 existing skills)
 *   (b) all V2 fields default-fill correctly
 *   (c) validation: priority out-of-range rejected
 *   (d) validation: bad SkillKey in composableWith rejected
 *   (e) validation: bad SkillKey in conflictsWith rejected
 *   (f) intentDescription max length enforced (500 chars)
 *   (g) requiresCtxState valid keys accepted; invalid keys rejected (strict)
 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  SKILL_KEYS,
  SkillSchemaV2,
  fromSkillSnap,
  RequiresCtxStateSchema,
  type SkillV2,
} from "./skill-schema.js"
import { EXISTING_6_METADATA, getExistingSkillMetadata } from "./skill-defaults.js"

// ---------------------------------------------------------------------------
// (a) — V1 doc → V2 type
// ---------------------------------------------------------------------------

test("fromSkillSnap: V1 doc with no V2 fields parses via defaults", () => {
  const v1Doc = {
    playbookKey: "headhunter",
    name: "Headhunter",
    description: "Activates when user signals job search.",
    regexTriggers: ["在看工作", "想换"],
    addendum: "# PLAYBOOK MODE\nbody",
    enabled: true,
    routingHint: "role_chain",
    version: 3,
    updatedAt: "2026-04-15T00:00:00.000Z",
    updatedBy: "test",
    reason: "test seed",
  }
  const v2 = fromSkillSnap("headhunter", v1Doc)
  // V1 fields preserved
  assert.equal(v2.playbookKey, "headhunter")
  assert.equal(v2.name, "Headhunter")
  assert.equal(v2.regexTriggers.length, 2)
  assert.equal(v2.routingHint, "role_chain")
  // V2 fields defaulted
  assert.equal(v2.intentDescription, "")
  assert.deepEqual(v2.provides, [])
  assert.deepEqual(v2.requires, [])
  assert.deepEqual(v2.composableWith, [])
  assert.deepEqual(v2.conflictsWith, [])
  assert.equal(v2.priority, 50)
  assert.deepEqual(v2.allowedTools, [])
  assert.equal(v2.llmInvokable, true)
  assert.deepEqual(v2.paths, [])
})

test("fromSkillSnap: each of the 6 existing keys' V2 metadata round-trips", () => {
  const existing = getExistingSkillMetadata()
  assert.equal(existing.length, 6, "expected exactly 6 metadata entries")
  for (const { key, metadata } of existing) {
    const fakeRaw = {
      playbookKey: key,
      name: key,
      description: "test",
      regexTriggers: [],
      addendum: "addendum body",
      enabled: true,
      ...metadata,
    }
    const v2 = fromSkillSnap(key, fakeRaw)
    assert.equal(v2.playbookKey, key, `${key}: playbookKey preserved`)
    assert.equal(
      v2.intentDescription,
      metadata.intentDescription,
      `${key}: intentDescription preserved`
    )
    assert.deepEqual(v2.provides, metadata.provides, `${key}: provides preserved`)
    assert.deepEqual(
      v2.composableWith,
      metadata.composableWith,
      `${key}: composableWith preserved`
    )
    assert.deepEqual(
      v2.conflictsWith,
      metadata.conflictsWith,
      `${key}: conflictsWith preserved`
    )
    assert.equal(v2.priority, metadata.priority, `${key}: priority preserved`)
    assert.equal(v2.llmInvokable, metadata.llmInvokable, `${key}: llmInvokable preserved`)
  }
})

test("fromSkillSnap: defensively coerces bad input shapes", () => {
  const bad = {
    playbookKey: "vent_support",
    name: "Vent",
    regexTriggers: ["ok", null, 123, "fine"], // mixed garbage
    composableWith: ["motivation_nudge", "fake_skill", null], // typo + null
    conflictsWith: ["headhunter", undefined],
    priority: 999, // out of range → coerce to default 50
    enabled: undefined, // → true
  }
  const v2 = fromSkillSnap("vent_support", bad)
  assert.deepEqual(v2.regexTriggers, ["ok", "fine"]) // strings only
  assert.deepEqual(v2.composableWith, ["motivation_nudge"]) // valid keys only
  assert.deepEqual(v2.conflictsWith, ["headhunter"])
  assert.equal(v2.priority, 50) // out-of-range coerced
  assert.equal(v2.enabled, true) // undefined → true
})

// ---------------------------------------------------------------------------
// (b) — all V2 fields default-fill correctly
// ---------------------------------------------------------------------------

test("SkillSchemaV2: minimum doc parses with all defaults", () => {
  const minimal: { playbookKey: string; name: string } = {
    playbookKey: "minimal",
    name: "Minimal",
  }
  const v2 = SkillSchemaV2.parse(minimal)
  assert.equal(v2.description, "")
  assert.deepEqual(v2.regexTriggers, [])
  assert.equal(v2.addendum, "")
  assert.equal(v2.enabled, true)
  assert.equal(v2.routingHint, null)
  assert.equal(v2.version, 0)
  assert.equal(v2.intentDescription, "")
  assert.deepEqual(v2.provides, [])
  assert.deepEqual(v2.requires, [])
  assert.deepEqual(v2.composableWith, [])
  assert.deepEqual(v2.conflictsWith, [])
  assert.equal(v2.priority, 50)
  assert.deepEqual(v2.allowedTools, [])
  assert.equal(v2.llmInvokable, true)
  assert.deepEqual(v2.paths, [])
  assert.equal(v2.requiresCtxState, undefined)
})

// ---------------------------------------------------------------------------
// (c) — priority validation
// ---------------------------------------------------------------------------

test("SkillSchemaV2: priority < 1 rejected", () => {
  assert.throws(() =>
    SkillSchemaV2.parse({ playbookKey: "k", name: "K", priority: 0 })
  )
  assert.throws(() =>
    SkillSchemaV2.parse({ playbookKey: "k", name: "K", priority: -5 })
  )
})

test("SkillSchemaV2: priority > 100 rejected", () => {
  assert.throws(() =>
    SkillSchemaV2.parse({ playbookKey: "k", name: "K", priority: 101 })
  )
  assert.throws(() =>
    SkillSchemaV2.parse({ playbookKey: "k", name: "K", priority: 1000 })
  )
})

test("SkillSchemaV2: priority boundary 1 and 100 accepted", () => {
  assert.equal(
    SkillSchemaV2.parse({ playbookKey: "k", name: "K", priority: 1 }).priority,
    1
  )
  assert.equal(
    SkillSchemaV2.parse({ playbookKey: "k", name: "K", priority: 100 })
      .priority,
    100
  )
})

// ---------------------------------------------------------------------------
// (d, e) — composableWith / conflictsWith validation
// ---------------------------------------------------------------------------

test("SkillSchemaV2: bad SkillKey in composableWith rejected", () => {
  assert.throws(() =>
    SkillSchemaV2.parse({
      playbookKey: "k",
      name: "K",
      composableWith: ["fake_skill"],
    })
  )
})

test("SkillSchemaV2: bad SkillKey in conflictsWith rejected", () => {
  assert.throws(() =>
    SkillSchemaV2.parse({
      playbookKey: "k",
      name: "K",
      conflictsWith: ["nonexistent_skill"],
    })
  )
})

test("SkillSchemaV2: all 19 SKILL_KEYS pass enum validation", () => {
  for (const key of SKILL_KEYS) {
    assert.doesNotThrow(() =>
      SkillSchemaV2.parse({
        playbookKey: "k",
        name: "K",
        composableWith: [key],
      })
    )
  }
  assert.equal(SKILL_KEYS.length, 19, "expected 19 total skills")
})

// ---------------------------------------------------------------------------
// (f) — intentDescription length cap
// ---------------------------------------------------------------------------

test("SkillSchemaV2: intentDescription >500 chars rejected", () => {
  const tooLong = "x".repeat(501)
  assert.throws(() =>
    SkillSchemaV2.parse({
      playbookKey: "k",
      name: "K",
      intentDescription: tooLong,
    })
  )
})

test("SkillSchemaV2: intentDescription exactly 500 chars accepted", () => {
  const exact = "x".repeat(500)
  const v2 = SkillSchemaV2.parse({
    playbookKey: "k",
    name: "K",
    intentDescription: exact,
  })
  assert.equal(v2.intentDescription.length, 500)
})

// ---------------------------------------------------------------------------
// (g) — requiresCtxState
// ---------------------------------------------------------------------------

test("RequiresCtxStateSchema: valid keys accepted", () => {
  const v = RequiresCtxStateSchema.parse({
    turn_gap_ge_2h: true,
    resume_recently_accepted: true,
  })
  assert.equal(v.turn_gap_ge_2h, true)
  assert.equal(v.resume_recently_accepted, true)
})

test("RequiresCtxStateSchema: empty object accepted", () => {
  const v = RequiresCtxStateSchema.parse({})
  assert.deepEqual(v, {})
})

test("RequiresCtxStateSchema: unknown key rejected (strict)", () => {
  assert.throws(() =>
    RequiresCtxStateSchema.parse({ unknown_predicate: true })
  )
})

test("SkillSchemaV2: requiresCtxState integrated into parent schema", () => {
  const v2 = SkillSchemaV2.parse({
    playbookKey: "silence_anchor",
    name: "Silence anchor",
    requiresCtxState: { turn_gap_ge_2h: true },
  })
  assert.deepEqual(v2.requiresCtxState, { turn_gap_ge_2h: true })
})

// ---------------------------------------------------------------------------
// Permitted edge case — empty regex + non-empty requiresCtxState (cv_followup)
// ---------------------------------------------------------------------------

test("SkillSchemaV2: regex=[] AND requiresCtxState set is permitted (cv_followup case)", () => {
  const v2: SkillV2 = SkillSchemaV2.parse({
    playbookKey: "cv_followup",
    name: "CV followup",
    regexTriggers: [],
    requiresCtxState: { resume_recently_accepted: true },
    requires: ["ctx.userProfile.resumeAccepted"],
  })
  assert.equal(v2.regexTriggers.length, 0)
  assert.deepEqual(v2.requiresCtxState, { resume_recently_accepted: true })
})

// ---------------------------------------------------------------------------
// Backward-compat invariant: 6-skill metadata renders into Zod-valid shape
// ---------------------------------------------------------------------------

test("EXISTING_6_METADATA: all 6 entries pass full schema validation when merged", () => {
  for (const { key, metadata } of getExistingSkillMetadata()) {
    const fakeRaw = {
      playbookKey: key,
      name: key,
      description: "",
      regexTriggers: [],
      addendum: `# ${key}`,
      enabled: true,
      ...metadata,
    }
    assert.doesNotThrow(
      () => SkillSchemaV2.parse(fakeRaw),
      `${key}: full schema validation`
    )
  }
})

test("EXISTING_6_METADATA: priority sparse 1-100 — no two priorities collide on the existing 6", () => {
  const seen = new Set<number>()
  for (const { metadata } of getExistingSkillMetadata()) {
    assert.ok(
      !seen.has(metadata.priority),
      `priority collision: ${metadata.priority}`
    )
    seen.add(metadata.priority)
  }
})
