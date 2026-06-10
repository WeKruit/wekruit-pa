/**
 * Tests for the LLM-driven canonical-enum VALIDATION gate (no-regex tagging).
 * Adam directive 2026-05-30: "no regex allowed AT ALL in the tagging system."
 *
 * These prove the validator:
 *   - accepts the agent's structured canonical picks,
 *   - validates EVERY pick against `@wekruit/shared-tags` closed enums,
 *   - drops anything off-vocab (never invents / pattern-matches),
 *   - supports OR multi-pick (arrays) on every multi-value axis,
 *   - contains NO regex classification (asserted at the source level).
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import test from "node:test"

import { validateOnboardingCanonicalTags } from "../onboarding-canonical-tags.js"

test("validates closed-enum picks and drops off-vocab values", () => {
  const tags = validateOnboardingCanonicalTags({
    targetRoleFunction: ["software_engineering", "not_a_role", "product_management"],
    industrySector: ["financial_technology", "totally_made_up"],
    visaStatus: "sponsor_needed",
    careerStage: "not_a_stage",
    minSalary: 140000,
  })
  assert.deepEqual(tags.targetRoleFunction, ["software_engineering", "product_management"])
  assert.deepEqual(tags.industrySector, ["financial_technology"])
  assert.equal((tags as { visaStatus?: string }).visaStatus, "sponsor_needed")
  assert.equal(tags.careerStage, undefined, "off-vocab careerStage dropped")
  assert.equal(tags.minSalary, 140000)
})

test("OR multi-pick: companySize array is preserved end-to-end", () => {
  // "a small startup OR big tech" → two canonical sizes (OR).
  const multi = validateOnboardingCanonicalTags({ companySize: ["early_startup", "enterprise"] })
  assert.deepEqual(multi.companySize, ["early_startup", "enterprise"])

  // A single pick collapses to a scalar (schema accepts enum | enum[]).
  const single = validateOnboardingCanonicalTags({ companySize: ["scale_up"] })
  assert.equal(single.companySize, "scale_up")

  // A bare scalar from the model is also accepted.
  const scalar = validateOnboardingCanonicalTags({ companySize: "open" })
  assert.equal(scalar.companySize, "open")

  // Off-vocab size dropped; nothing valid → field absent.
  const dropped = validateOnboardingCanonicalTags({ companySize: ["megacorp"] })
  assert.equal(dropped.companySize, undefined)
})

test("companyStage (funding) is captured ORTHOGONALLY to companySize", () => {
  // "early-stage startup OR a public company" → funding-stage OR, distinct from headcount.
  const multi = validateOnboardingCanonicalTags({
    companyStage: ["seed", "ipo_public"],
    companySize: ["early_startup", "enterprise"],
  })
  assert.deepEqual((multi as { companyStage?: unknown }).companyStage, ["seed", "ipo_public"])
  assert.deepEqual(multi.companySize, ["early_startup", "enterprise"]) // size axis untouched

  // single → scalar; bare scalar accepted; off-vocab dropped.
  assert.equal((validateOnboardingCanonicalTags({ companyStage: ["series_a"] }) as { companyStage?: unknown }).companyStage, "series_a")
  assert.equal((validateOnboardingCanonicalTags({ companyStage: "seed" }) as { companyStage?: unknown }).companyStage, "seed")
  assert.equal((validateOnboardingCanonicalTags({ companyStage: ["megacorp"] }) as { companyStage?: unknown }).companyStage, undefined)
})

test("OR multi-pick: industries + role functions capture every value the candidate mentioned", () => {
  const tags = validateOnboardingCanonicalTags({
    industrySector: [
      "artificial_intelligence_and_machine_learning",
      "financial_technology",
      "crypto_web3_blockchain",
    ],
    targetRoleFunction: ["product_management", "marketing"],
  })
  assert.deepEqual(tags.industrySector, [
    "artificial_intelligence_and_machine_learning",
    "financial_technology",
    "crypto_web3_blockchain",
  ])
  assert.deepEqual(tags.targetRoleFunction, ["product_management", "marketing"])
})

test("negative axes validate against the same vocab", () => {
  const tags = validateOnboardingCanonicalTags({
    negativeRoleFunction: ["software_engineering"],
    negativeIndustrySector: ["crypto_web3_blockchain", "nope"],
  })
  assert.deepEqual(tags.negativeRoleFunction, ["software_engineering"])
  assert.deepEqual(tags.negativeIndustrySector, ["crypto_web3_blockchain"])
})

test("negativeJobType validates against JOB_TYPE_VOCAB (jobType negation parity 2026-06-09)", () => {
  const tags = validateOnboardingCanonicalTags({
    targetJobType: ["full_time"],
    negativeJobType: ["internship", "side_hustle"],
  })
  assert.deepEqual(tags.targetJobType, ["full_time"])
  assert.deepEqual(tags.negativeJobType, ["internship"], "off-vocab dropped, valid token kept")
})

test("dedupe + mechanical normalize only (no semantic classification)", () => {
  const tags = validateOnboardingCanonicalTags({
    targetLocations: ["New York", "new york", "remote"],
    industrySector: ["financial_technology", "financial_technology"],
  })
  // whitespace→underscore + dedupe; never pattern-classified.
  assert.deepEqual(tags.targetLocations, ["new_york", "remote"])
  assert.deepEqual(tags.industrySector, ["financial_technology"])
})

test("per-axis hardness + negotiability degree validated against HARDNESS_AXIS_VOCAB", () => {
  const tags = validateOnboardingCanonicalTags({
    minSalary: 140000,
    careerStage: "senior",
    targetLocations: ["new_york"],
    preferenceHardness: {
      // soft + degree: "need 140k but could flex to 130" → bufferPct
      salary: { hardness: "soft", bufferPct: 0.07 },
      // soft + degree: "ideally senior but open to mid" → bufferSteps
      careerStage: { hardness: "soft", bufferSteps: 1 },
      // hard dealbreaker: "must be NYC, remote not ok"
      location: { hardness: "hard" },
      // off-vocab axis dropped
      vibes: { hardness: "soft" },
      // missing/invalid hardness dropped
      industrySector: { bufferSteps: 2 },
    },
  })
  const ph = (tags as { preferenceHardness?: Record<string, Record<string, unknown>> }).preferenceHardness ?? {}
  assert.equal(ph.salary?.hardness, "soft")
  assert.equal(ph.salary?.bufferPct, 0.07)
  assert.equal(ph.salary?.source, "onboarding")
  assert.equal(ph.careerStage?.hardness, "soft")
  assert.equal(ph.careerStage?.bufferSteps, 1)
  assert.equal(ph.location?.hardness, "hard")
  assert.equal(ph.vibes, undefined, "off-vocab axis dropped")
  assert.equal(ph.industrySector, undefined, "entry without valid hardness dropped")
})

test("hardness provenance source can be overridden (e.g. conversation)", () => {
  const tags = validateOnboardingCanonicalTags(
    { preferenceHardness: { salary: { hardness: "hard" } } },
    { source: "conversation", confidence: 0.9, updatedAt: "2026-05-30T00:00:00.000Z" },
  )
  const ph = (tags as { preferenceHardness?: Record<string, Record<string, unknown>> }).preferenceHardness ?? {}
  assert.equal(ph.salary?.source, "conversation")
  assert.equal(ph.salary?.confidence, 0.9)
})

test("null / empty / garbage input → empty tags (never throws)", () => {
  assert.deepEqual(validateOnboardingCanonicalTags(null), {})
  assert.deepEqual(validateOnboardingCanonicalTags(undefined), {})
  assert.deepEqual(validateOnboardingCanonicalTags({}), {})
  assert.deepEqual(
    validateOnboardingCanonicalTags({ targetRoleFunction: [], industrySector: null, minSalary: -5 }),
    {},
  )
})

test("SOURCE GUARD: the validator contains no regex-based classification", () => {
  const raw = readFileSync(
    fileURLToPath(new URL("../onboarding-canonical-tags.ts", import.meta.url)),
    "utf8",
  )
  // Strip comments so the doc-comment that NAMES the banned pattern (as an
  // example of what NOT to do) doesn't trip the guard. Only executable code is
  // checked.
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "")) // line comments
    .join("\n")
  // Only mechanical normalizers are allowed: trim/toLowerCase/whitespace-collapse.
  // No enum-classifying regex token-literals, no RegExp.test()/String.match().
  assert.equal(/\b(?:new\s+RegExp|RegExp\s*\()/.test(code), false, "no RegExp constructor")
  assert.equal(/\.test\s*\(/.test(code), false, "no RegExp.test() classification")
  assert.equal(/\.match\s*\(/.test(code), false, "no String.match() classification")
  // The only regex literals allowed are trivial whitespace normalizers.
  const regexLiterals = code.match(/\/(?:\\.|[^/\n])+\/[gimsuy]*/g) ?? []
  for (const lit of regexLiterals) {
    assert.ok(
      lit === "/\\s+/g" || lit === "/\\s+/",
      `unexpected regex literal in tagging path: ${lit}`,
    )
  }
})
