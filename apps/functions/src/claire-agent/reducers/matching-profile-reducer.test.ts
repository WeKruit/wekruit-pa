/**
 * L1 reducer code-asserts for the keystone matching reducer (no LLM).
 *
 * These pin the RC1 canary fix: "avoid SWE, only product" must REMOVE SWE from
 * the positive set, write negativeRoleFunction, and switch jobType.
 *
 * Run: node --import tsx --test apps/functions/src/claire-agent/reducers/matching-profile-reducer.test.ts
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { reduceMatchingPreferences } from "./matching-profile-reducer.js"

test("RC1: 'done with SWE, only product, full-time' replaces + writes negative + drops internship", () => {
  const current = {
    targetRoleFunction: ["software_engineering"],
    targetJobType: ["internship"],
  }
  const { next } = reduceMatchingPreferences(current, {
    onlyRoleFunctions: ["product_management"],
    avoidRoleFunctions: ["software_engineering"],
    jobType: ["full_time"],
  })
  assert.deepEqual(next.targetRoleFunction, ["product_management"], "SWE removed, product present")
  assert.ok(
    (next.negativeRoleFunction ?? []).includes("software_engineering"),
    "negativeRoleFunction has SWE",
  )
  assert.deepEqual(next.targetJobType, ["full_time"], "jobType switched to full_time")
})

test("'only X' REPLACES the positive set (not append)", () => {
  const { next } = reduceMatchingPreferences(
    { targetRoleFunction: ["software_engineering", "data_analysis"] },
    { onlyRoleFunctions: ["product_management"] },
  )
  assert.deepEqual(next.targetRoleFunction, ["product_management"])
})

test("'avoid Y' subtracts from positive even without an 'only'", () => {
  const { next, removedFromPositive } = reduceMatchingPreferences(
    { targetRoleFunction: ["software_engineering", "product_management"] },
    { avoidRoleFunctions: ["software_engineering"] },
  )
  assert.deepEqual(next.targetRoleFunction, ["product_management"])
  assert.deepEqual(next.negativeRoleFunction, ["software_engineering"])
  assert.deepEqual(removedFromPositive, ["software_engineering"])
})

test("negatives ACCUMULATE across turns (durable, not replaced)", () => {
  const afterFirst = reduceMatchingPreferences(
    { targetRoleFunction: ["software_engineering", "sales", "product_management"] },
    { avoidRoleFunctions: ["software_engineering"] },
  ).next
  const afterSecond = reduceMatchingPreferences(afterFirst, {
    avoidRoleFunctions: ["sales"],
  }).next
  assert.deepEqual(afterSecond.negativeRoleFunction?.sort(), ["sales", "software_engineering"])
  assert.deepEqual(afterSecond.targetRoleFunction, ["product_management"])
})

test("'only X' un-avoids X if it was previously on the negative axis", () => {
  const start = { targetRoleFunction: ["product_management"], negativeRoleFunction: ["software_engineering"] }
  const { next } = reduceMatchingPreferences(start, { onlyRoleFunctions: ["software_engineering"] })
  assert.deepEqual(next.targetRoleFunction, ["software_engineering"])
  assert.deepEqual(next.negativeRoleFunction ?? [], [], "SWE removed from negative axis when now wanted")
})

test("empty/absent proposal fields are no-ops (no accidental clobber)", () => {
  const start = {
    targetRoleFunction: ["product_management"],
    targetJobType: ["full_time"],
    targetLocations: ["san_francisco_bay_area"],
  }
  const { next, changed } = reduceMatchingPreferences(start, {
    onlyRoleFunctions: null,
    avoidRoleFunctions: [],
    jobType: null,
    locations: undefined,
  })
  assert.deepEqual(next.targetRoleFunction, ["product_management"])
  assert.deepEqual(next.targetJobType, ["full_time"])
  assert.deepEqual(next.targetLocations, ["san_francisco_bay_area"])
  assert.deepEqual(changed, {}, "nothing changed")
})

test("'only' then 'avoid' in one proposal: avoid wins the subtraction", () => {
  const { next } = reduceMatchingPreferences(
    { targetRoleFunction: ["sales"] },
    { onlyRoleFunctions: ["product_management", "sales"], avoidRoleFunctions: ["sales"] },
  )
  assert.deepEqual(next.targetRoleFunction, ["product_management"])
  assert.deepEqual(next.negativeRoleFunction, ["sales"])
})

// ── negation coverage for the jobType axis (live victim 2026-06-09: "I am not
// looking for an internship" left tags.targetJobType=["internship"], an
// EXACT-match hard filter → only intern jobs ever matched) ─────────────────

test("avoidJobTypes subtracts from targetJobType — pure negation writes [] (must actually clear)", () => {
  const { next, changed } = reduceMatchingPreferences(
    { targetJobType: ["internship"] },
    { avoidJobTypes: ["internship"] },
  )
  assert.deepEqual(next.targetJobType, [], "internship removed; empty set remains")
  assert.deepEqual(changed.targetJobType, [], "the [] MUST be in `changed` so the writer persists the clear")
  assert.deepEqual(changed.negativeJobType, ["internship"], "negation recorded durably")
})

test("avoidJobTypes subtracts only the avoided tokens (others survive)", () => {
  const { next } = reduceMatchingPreferences(
    { targetJobType: ["internship", "full_time"] },
    { avoidJobTypes: ["internship"] },
  )
  assert.deepEqual(next.targetJobType, ["full_time"])
  assert.deepEqual(next.negativeJobType, ["internship"])
})

test("avoidJobTypes accumulates negativeJobType across turns", () => {
  const afterFirst = reduceMatchingPreferences(
    { targetJobType: ["internship", "contract", "full_time"] },
    { avoidJobTypes: ["internship"] },
  ).next
  const afterSecond = reduceMatchingPreferences(afterFirst, { avoidJobTypes: ["contract"] }).next
  assert.deepEqual(afterSecond.negativeJobType?.sort(), ["contract", "internship"])
  assert.deepEqual(afterSecond.targetJobType, ["full_time"])
})

test("positive jobType replace un-avoids a previously-negated job type", () => {
  const start = { targetJobType: [], negativeJobType: ["internship"] }
  const { next, changed } = reduceMatchingPreferences(start, { jobType: ["internship"] })
  assert.deepEqual(next.targetJobType, ["internship"])
  assert.deepEqual(next.negativeJobType ?? [], [], "internship off the negative axis once re-wanted")
  assert.deepEqual(changed.negativeJobType, [], "the un-avoid is persisted, not just computed")
})

test("jobType + avoidJobTypes in one proposal: avoid wins the subtraction", () => {
  const { next } = reduceMatchingPreferences(
    { targetJobType: ["internship"] },
    { jobType: ["full_time", "internship"], avoidJobTypes: ["internship"] },
  )
  assert.deepEqual(next.targetJobType, ["full_time"])
  assert.deepEqual(next.negativeJobType, ["internship"])
})

test("clearTargetJobType empties targetJobType regardless of prior value", () => {
  const { next, changed } = reduceMatchingPreferences(
    { targetJobType: ["internship", "new_graduate"] },
    { clearTargetJobType: true },
  )
  assert.deepEqual(next.targetJobType, [])
  assert.deepEqual(changed.targetJobType, [])
})

test("clearTargetJobType=false / null / absent is a no-op", () => {
  for (const clear of [false, null, undefined]) {
    const { changed } = reduceMatchingPreferences(
      { targetJobType: ["full_time"] },
      { clearTargetJobType: clear },
    )
    assert.deepEqual(changed, {}, `clear=${String(clear)} must not change anything`)
  }
})

// ── full preference-axis coverage (2026-06-09 follow-up to PR #385): the tool
// schema promised visa/salary/industry/company-size/career-stage but the
// reducer could not carry them — schema-can't-express = silent drop. The
// industry axis gets the SAME only/avoid semantics as jobType; visa / salary /
// companySize / careerStage are scalar/replace pass-throughs. ───────────────

test("'healthcare not fintech': industrySector REPLACES + avoidIndustrySector subtracts and accumulates", () => {
  const { next, changed } = reduceMatchingPreferences(
    { industrySector: ["financial_technology"] },
    {
      industrySector: ["healthcare_and_life_sciences"],
      avoidIndustrySector: ["financial_technology"],
    },
  )
  assert.deepEqual(next.industrySector, ["healthcare_and_life_sciences"], "fintech removed from positive")
  assert.deepEqual(next.negativeIndustrySector, ["financial_technology"])
  assert.deepEqual(changed.industrySector, ["healthcare_and_life_sciences"])
  assert.deepEqual(changed.negativeIndustrySector, ["financial_technology"])
})

test("avoidIndustrySector alone subtracts from positive — subtract-to-empty writes [] (explicit clear)", () => {
  const { next, changed } = reduceMatchingPreferences(
    { industrySector: ["financial_technology"] },
    { avoidIndustrySector: ["financial_technology"] },
  )
  assert.deepEqual(next.industrySector, [])
  assert.deepEqual(changed.industrySector, [], "the [] MUST be in `changed` so the writer persists the clear")
  assert.deepEqual(changed.negativeIndustrySector, ["financial_technology"])
})

test("positive industrySector un-avoids a previously-negated sector", () => {
  const { next, changed } = reduceMatchingPreferences(
    { industrySector: [], negativeIndustrySector: ["financial_technology"] },
    { industrySector: ["financial_technology"] },
  )
  assert.deepEqual(next.industrySector, ["financial_technology"])
  assert.deepEqual(next.negativeIndustrySector ?? [], [])
  assert.deepEqual(changed.negativeIndustrySector, [], "the un-avoid is persisted, not just computed")
})

test("negativeIndustrySector accumulates across turns", () => {
  const afterFirst = reduceMatchingPreferences(
    { industrySector: ["financial_technology", "gaming_and_esports", "healthcare_and_life_sciences"] },
    { avoidIndustrySector: ["financial_technology"] },
  ).next
  const afterSecond = reduceMatchingPreferences(afterFirst, {
    avoidIndustrySector: ["gaming_and_esports"],
  }).next
  assert.deepEqual(
    afterSecond.negativeIndustrySector?.sort(),
    ["financial_technology", "gaming_and_esports"],
  )
  assert.deepEqual(afterSecond.industrySector, ["healthcare_and_life_sciences"])
})

test("scalar axes: visaStatus / minSalary / companySize / careerStage REPLACE when stated and different", () => {
  const { changed } = reduceMatchingPreferences(
    { visaStatus: "citizen", minSalary: 100000 },
    {
      visaStatus: "sponsor_needed",
      minSalary: 140000,
      companySize: ["early_startup"],
      careerStage: "senior",
    },
  )
  assert.equal(changed.visaStatus, "sponsor_needed")
  assert.equal(changed.minSalary, 140000)
  assert.deepEqual(changed.companySize, ["early_startup"])
  assert.equal(changed.careerStage, "senior")
})

test("scalar axes: restating the SAME value is a no-op (no spurious write)", () => {
  const { changed } = reduceMatchingPreferences(
    { visaStatus: "sponsor_needed", minSalary: 140000, companySize: ["early_startup"], careerStage: "senior" },
    {
      visaStatus: "sponsor_needed",
      minSalary: 140000,
      companySize: ["early_startup"],
      careerStage: "senior",
    },
  )
  assert.deepEqual(changed, {}, "identical restatement must not change anything")
})

test("scalar axes: null / absent proposals never clobber stored values", () => {
  const { next, changed } = reduceMatchingPreferences(
    { visaStatus: "sponsor_needed", minSalary: 140000, careerStage: "senior" },
    { visaStatus: null, minSalary: null, companySize: null, careerStage: undefined },
  )
  assert.deepEqual(changed, {})
  assert.equal(next.visaStatus, "sponsor_needed")
  assert.equal(next.minSalary, 140000)
  assert.equal(next.careerStage, "senior")
})

// yoeRange — explicit YoE correction (2026-06-19). "3 to 4 years" must be a
// durable tuple, not collapse to a scalar careerStage (the silently-dropped bug).
test("yoeRange: a stated [min,max] REPLACES and is normalized lo..hi", () => {
  const { next, changed } = reduceMatchingPreferences({}, { yoeRange: [4, 3] })
  assert.deepEqual(changed.yoeRange, [3, 4], "endpoints normalized lo..hi")
  assert.deepEqual(next.yoeRange, [3, 4])
})

test("yoeRange: restating the same range (any order) is a no-op", () => {
  const { changed } = reduceMatchingPreferences({ yoeRange: [3, 4] }, { yoeRange: [3, 4] })
  assert.deepEqual(changed, {}, "identical yoeRange must not change anything")
})

test("yoeRange: null / malformed proposal never clobbers a stored range", () => {
  const { next, changed } = reduceMatchingPreferences(
    { yoeRange: [3, 4] },
    { yoeRange: null },
  )
  assert.deepEqual(changed, {})
  assert.deepEqual(next.yoeRange, [3, 4])
  // malformed (single negative / NaN endpoints) is ignored too.
  const bad = reduceMatchingPreferences({ yoeRange: [3, 4] }, { yoeRange: [-1, 2] as never })
  assert.deepEqual(bad.changed, {})
  assert.deepEqual(bad.next.yoeRange, [3, 4])
})
