import assert from "node:assert/strict"
import test from "node:test"
import { ROLE_FUNCTION_VOCAB } from "../canonical/role-function.js"
import {
  ROLE_FUNCTION_TO_LENS,
  SCHOOL_TIERS,
  lookupSchoolPrior,
  normalizeSchoolKey,
} from "../canonical/school-strength-priors.js"

test("every canonical roleFunction maps to exactly one lens (exhaustive, no extras)", () => {
  for (const rf of ROLE_FUNCTION_VOCAB) {
    assert.ok(ROLE_FUNCTION_TO_LENS[rf], `roleFunction ${rf} has no lens`)
  }
  assert.equal(Object.keys(ROLE_FUNCTION_TO_LENS).length, ROLE_FUNCTION_VOCAB.length)
})

test("role-aware: a top CS school is strong for engineering", () => {
  const r = lookupSchoolPrior("MIT", "software_engineering")
  assert.equal(r.strength, "strong")
  assert.equal(r.tier, "tier_1")
  assert.equal(r.lens, "engineering_cs")
  assert.equal(r.matchedVia, "lens")
})

test("role-aware divergence: a design school is strong for design, not via the CS list", () => {
  const r = lookupSchoolPrior("Rhode Island School of Design", "creatives_and_design")
  assert.equal(r.strength, "strong")
  assert.equal(r.lens, "design")
})

test("alias drift fixed: UC Berkeley resolves under every common variant in the same lens", () => {
  for (const v of ["UC Berkeley", "University of California-Berkeley", "Cal", "UCB", "Berkeley"]) {
    const r = lookupSchoolPrior(v, "software_engineering")
    assert.equal(r.strength, "strong", `variant "${v}" should resolve strong`)
    assert.equal(r.lens, "engineering_cs")
  }
})

test("not-found is 'unknown' — never a negative (Baker College is not a target school)", () => {
  const r = lookupSchoolPrior("Baker College", "software_engineering")
  assert.equal(r.strength, "unknown")
  assert.equal(r.tier, null)
  assert.equal(r.matchedVia, "none")
})

test("general fallback: a broadly-elite school still earns a prior when the functional lens misses", () => {
  // Duke is a general-top-US elite; if it is not in the engineering_cs lens it must fall back.
  const r = lookupSchoolPrior("Duke University", "software_engineering")
  assert.notEqual(r.strength, "unknown")
  if (r.matchedVia === "general_fallback") assert.equal(r.lens, "general_top_us")
})

test("multi-pick job takes the strongest lens hit", () => {
  const r = lookupSchoolPrior("Stanford University", ["customer_service_and_support", "software_engineering"])
  assert.equal(r.strength, "strong")
})

test("the 3 malformed canonicals were split into clean school names (no prose/slash keys)", () => {
  const all = Object.values(SCHOOL_TIERS).flatMap((lens) => Object.values(lens).flat())
  for (const e of all) {
    assert.ok(!/—| peer | aside |flagships/.test(e.canonical), `prose canonical leaked: "${e.canonical}"`)
    assert.ok(!/ \/ /.test(e.canonical), `two-school canonical leaked: "${e.canonical}"`)
    assert.ok(!/\(.+\)/.test(e.canonical), `program parenthetical left in canonical: "${e.canonical}"`)
  }
  // the split targets exist as their own clean entries
  const canon = new Set(all.map((e) => normalizeSchoolKey(e.canonical)))
  assert.ok(canon.has(normalizeSchoolKey("Cleveland Institute of Art")))
  assert.ok(canon.has(normalizeSchoolKey("Southern Methodist University")))
})

test("arts_and_entertainment no longer maps to the product-design lens (critic fix)", () => {
  assert.notEqual(ROLE_FUNCTION_TO_LENS.arts_and_entertainment, "design")
  assert.equal(ROLE_FUNCTION_TO_LENS.business_analyst, "finance_consulting")
})
