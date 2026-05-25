/**
 * Phase 38 T2 — contradiction detector tests.
 *
 * Gates (from CONTEXT D-38-9):
 * - Positive recall ≥ 9/10 on seeded fixtures
 * - False-positive rate ≤ 1/5 on negative-control fixtures
 * - S3 sync verified — Type 10 persona_locked reads from `getPersona`
 *   (Phase 32 W3 Firestore source) NOT inline strings
 */
import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { detectContradiction } from "./contradiction-detector.js"
import type {
  AdviceTrackerDeps,
  ContradictionType,
  MemoryPolicyContext,
  PersonaSnapshot,
} from "./types.js"

interface Fixture {
  id: string
  lang: "zh" | "en" | "mixed"
  user_fact: string
  claire_reply: string
  expected_contradiction: boolean
  expected_type: ContradictionType | null
  expected_violated_term_synonyms: string[]
}

// ---------------------------------------------------------------------------
// Fixture loader
// ---------------------------------------------------------------------------

function loadFixtures(): Fixture[] {
  // Resolve relative to THIS test file, not process.cwd() — pnpm runs the
  // test suite with cwd=packages/pa-orchestrator which would double-prefix
  // the path. Walk up from this test file's location to find __fixtures__.
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  const fixturesPath = path.join(__dirname, "__fixtures__", "contradictions.json")
  const raw = fs.readFileSync(fixturesPath, "utf8")
  const parsed = JSON.parse(raw) as Fixture[]
  return parsed
}

const FIXTURES = loadFixtures()
const POSITIVE = FIXTURES.filter((f) => f.expected_contradiction)
const NEGATIVE = FIXTURES.filter((f) => !f.expected_contradiction)

// ---------------------------------------------------------------------------
// Mem0 mock — returns the fixture's user_fact as the only fact.
// ---------------------------------------------------------------------------

function makeMem0FromFact(fact: string) {
  return async (_q: string, _userId: string): Promise<string[]> => {
    return [fact]
  }
}

// ---------------------------------------------------------------------------
// Per-fixture tests
// ---------------------------------------------------------------------------

test("contradictions.json: 15 fixtures (10 positive + 5 negative) — file is shaped correctly", () => {
  assert.equal(FIXTURES.length, 15)
  assert.equal(POSITIVE.length, 10)
  assert.equal(NEGATIVE.length, 5)
})

test("contradictions.json: bilingual coverage (≥5 zh + ≥5 en across all fixtures)", () => {
  const zhCount = FIXTURES.filter((f) => f.lang === "zh").length
  const enCount = FIXTURES.filter((f) => f.lang === "en").length
  assert.ok(zhCount >= 5, `expected ≥5 zh fixtures, got ${zhCount}`)
  assert.ok(enCount >= 5, `expected ≥5 en fixtures, got ${enCount}`)
})

// Run each positive fixture, count passes.
test("positive recall ≥ 9/10 on seeded contradiction fixtures (gate D-38-9)", async () => {
  let passed = 0
  const failures: string[] = []
  for (const fx of POSITIVE) {
    const ctx: MemoryPolicyContext = {
      userId: "u_test",
      turnId: fx.id,
      claireReply: fx.claire_reply,
      userLang: fx.lang === "mixed" ? undefined : fx.lang,
    }
    const deps: AdviceTrackerDeps = {
      mem0Search: makeMem0FromFact(fx.user_fact),
    }
    const r = await detectContradiction(ctx, deps)
    const typeMatches = r.type === fx.expected_type
    const termMatches =
      r.violatedTerm !== null &&
      fx.expected_violated_term_synonyms.some((s) =>
        r.violatedTerm!.toLowerCase().includes(s.toLowerCase())
      )
    if (r.violated && typeMatches && termMatches) {
      passed += 1
    } else {
      failures.push(
        `${fx.id}: violated=${r.violated} type=${r.type} (expected ${fx.expected_type}) term="${r.violatedTerm}"`
      )
    }
  }
  assert.ok(
    passed >= 9,
    `Positive recall gate: expected ≥9/10, got ${passed}/10. Failures:\n  ${failures.join("\n  ")}`
  )
})

test("negative false-positive rate ≤ 1/5 on no-contradiction fixtures", async () => {
  let falsePositives = 0
  const failures: string[] = []
  for (const fx of NEGATIVE) {
    const ctx: MemoryPolicyContext = {
      userId: "u_test",
      turnId: fx.id,
      claireReply: fx.claire_reply,
      userLang: fx.lang === "mixed" ? undefined : fx.lang,
    }
    const deps: AdviceTrackerDeps = {
      mem0Search: makeMem0FromFact(fx.user_fact),
    }
    const r = await detectContradiction(ctx, deps)
    if (r.violated) {
      falsePositives += 1
      failures.push(
        `${fx.id}: incorrectly flagged violated, type=${r.type}, term="${r.violatedTerm}"`
      )
    }
  }
  assert.ok(
    falsePositives <= 1,
    `Negative false-positive gate: expected ≤1/5, got ${falsePositives}/5. Failures:\n  ${failures.join("\n  ")}`
  )
})

// ---------------------------------------------------------------------------
// S3 sync — Type 10 persona_locked reads from getPersona (Firestore source)
// ---------------------------------------------------------------------------

test("S3 sync: Type 10 persona_locked detects vegan persona vs steak reply", async () => {
  const personaSnapshot: PersonaSnapshot = {
    soul: "Claire is a vegetarian who prefers tea over coffee. She values gentle conversations.",
    style: "Warm, gentle, slightly playful.",
    examples: "Always asks open-ended questions.",
  }
  const ctx: MemoryPolicyContext = {
    userId: "u_persona",
    turnId: "t1",
    claireReply: "I recommend the steakhouse downtown — their ribeye is amazing",
  }
  const deps: AdviceTrackerDeps = {
    getPersona: async (slug: string) => {
      assert.equal(slug, "claire", "should query 'claire' persona by default")
      return personaSnapshot
    },
  }
  const r = await detectContradiction(ctx, deps)
  assert.equal(r.violated, true)
  assert.equal(r.type, "persona_locked")
  assert.ok(r.violatedTerm !== null)
  assert.match(r.violatedTerm!.toLowerCase(), /(steak|ribeye|steakhouse)/)
})

test("S3 sync: missing getPersona deps → Type 10 silently skipped (no false-positive)", async () => {
  const ctx: MemoryPolicyContext = {
    userId: "u_persona",
    turnId: "t1",
    claireReply: "I recommend the steakhouse downtown — their ribeye is amazing",
  }
  // No getPersona, no mem0Search → Type 10 + others all return non-violation
  const r = await detectContradiction(ctx, {})
  assert.equal(r.violated, false)
  assert.equal(r.type, null)
})

test("S3 sync: env override of persona slug honored", async (t) => {
  process.env.MEMORY_POLICY_PERSONA_SLUG = "alt_persona"
  t.after(() => delete process.env.MEMORY_POLICY_PERSONA_SLUG)

  const personaSnapshot: PersonaSnapshot = {
    soul: "Alt persona is vegan",
    style: "",
    examples: "",
  }
  let queriedSlug = ""
  const deps: AdviceTrackerDeps = {
    getPersona: async (slug: string) => {
      queriedSlug = slug
      return personaSnapshot
    },
  }
  const ctx: MemoryPolicyContext = {
    userId: "u",
    turnId: "t",
    claireReply: "try the bacon cheeseburger",
  }
  const r = await detectContradiction(ctx, deps)
  assert.equal(queriedSlug, "alt_persona", "should query env-set slug")
  assert.equal(r.violated, true)
  assert.equal(r.type, "persona_locked")
})

test("S3 sync: getPersona returns null → Type 10 skipped, other types still run", async () => {
  // User-fact-based dietary contradiction should still fire.
  const ctx: MemoryPolicyContext = {
    userId: "u",
    turnId: "t",
    claireReply: "try the steakhouse",
  }
  const deps: AdviceTrackerDeps = {
    mem0Search: makeMem0FromFact("I'm vegan"),
    getPersona: async () => null,
  }
  const r = await detectContradiction(ctx, deps)
  assert.equal(r.violated, true)
  assert.equal(r.type, "dietary")
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test("empty reply → no violation", async () => {
  const r = await detectContradiction(
    { userId: "u", turnId: "t", claireReply: "" },
    {}
  )
  assert.equal(r.violated, false)
})

test("missing mem0Search + missing getPersona → no violation (no facts to check against)", async () => {
  const r = await detectContradiction(
    { userId: "u", turnId: "t", claireReply: "anything goes" },
    {}
  )
  assert.equal(r.violated, false)
})

test("ctx.factsCache used directly (skips mem0Search)", async () => {
  let mem0Called = false
  const deps: AdviceTrackerDeps = {
    mem0Search: async () => {
      mem0Called = true
      return []
    },
  }
  const ctx: MemoryPolicyContext = {
    userId: "u",
    turnId: "t",
    claireReply: "try the steakhouse downtown",
    factsCache: ["I'm vegetarian"],
  }
  const r = await detectContradiction(ctx, deps)
  assert.equal(mem0Called, false, "factsCache should bypass mem0Search")
  assert.equal(r.violated, true)
  assert.equal(r.type, "dietary")
})

test("mem0Search throws → swallowed, returns no_violation (graceful degrade)", async () => {
  const deps: AdviceTrackerDeps = {
    mem0Search: async () => {
      throw new Error("mem0 down")
    },
  }
  const r = await detectContradiction(
    { userId: "u", turnId: "t", claireReply: "anything" },
    deps
  )
  assert.equal(r.violated, false)
})

test("language contradiction: zh user + en majority reply → flagged", async () => {
  const ctx: MemoryPolicyContext = {
    userId: "u",
    turnId: "t",
    claireReply: "you should try this absolutely amazing recipe at home tonight",
    userLang: "zh",
  }
  const r = await detectContradiction(ctx, {})
  assert.equal(r.violated, true)
  assert.equal(r.type, "language")
})

test("language contradiction: en user + zh majority reply → flagged", async () => {
  const ctx: MemoryPolicyContext = {
    userId: "u",
    turnId: "t",
    claireReply: "你应该试试这家店 他们做的菜真的很好吃 让人回味无穷",
    userLang: "en",
  }
  const r = await detectContradiction(ctx, {})
  assert.equal(r.violated, true)
  assert.equal(r.type, "language")
})

// ---------------------------------------------------------------------------
// Latency budget
// ---------------------------------------------------------------------------

test("detectContradiction: < 5ms p95 over 50 invocations (rule-based, facts preloaded)", async () => {
  const deps: AdviceTrackerDeps = {
    mem0Search: async () => {
      throw new Error("factsCache should skip mem0 latency in this rule-based budget test")
    },
  }
  const samples: number[] = []
  for (let i = 0; i < 50; i++) {
    const start = performance.now()
    await detectContradiction(
      {
        userId: "u",
        turnId: `t${i}`,
        claireReply: "try the salad bowl",
        factsCache: ["I'm vegetarian", "I have a cat"],
      },
      deps
    )
    samples.push(performance.now() - start)
  }
  samples.sort((a, b) => a - b)
  const p95 = samples[Math.floor(samples.length * 0.95)]
  assert.ok(p95 < 5, `p95 latency ${p95.toFixed(2)}ms exceeds 5ms budget`)
})

// ---------------------------------------------------------------------------
// Priority ordering — when multiple types could match, persona_locked wins
// ---------------------------------------------------------------------------

test("priority: persona_locked > dietary on overlap (persona vegan + reply mentions steak)", async () => {
  const persona: PersonaSnapshot = {
    soul: "Claire is vegetarian and gentle.",
    style: "",
    examples: "",
  }
  const deps: AdviceTrackerDeps = {
    mem0Search: async () => ["I'm vegan"],
    getPersona: async () => persona,
  }
  const r = await detectContradiction(
    {
      userId: "u",
      turnId: "t",
      claireReply: "try the steakhouse",
    },
    deps
  )
  assert.equal(r.violated, true)
  assert.equal(r.type, "persona_locked", "persona_locked has higher priority than dietary")
})

test("priority: allergy > dietary when both could match (reply contains both peanut + meat)", async () => {
  const deps: AdviceTrackerDeps = {
    mem0Search: async () => ["I'm vegan", "I'm allergic to peanuts"],
  }
  const r = await detectContradiction(
    {
      userId: "u",
      turnId: "t",
      claireReply: "try the peanut-crusted steak",
    },
    deps
  )
  assert.equal(r.violated, true)
  assert.equal(r.type, "allergy", "allergy has higher priority than dietary")
})
