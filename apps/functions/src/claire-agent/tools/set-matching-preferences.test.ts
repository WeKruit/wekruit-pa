/**
 * set-matching-preferences.test.ts — negation coverage through the THIN tool chain.
 *
 * Live victim (2026-06-09): a candidate said "I am not looking for an internship"
 * and tags.targetJobType stayed ["internship"] — an EXACT-match HARD filter, so
 * only intern jobs ever matched. Negations were INEXPRESSIBLE: the tool had
 * avoidRoleFunctions but no avoidJobTypes, and the reducer ignored empty arrays.
 *
 * These guards drive the REAL tool execute (tool → reduceMatchingPreferences →
 * applyPartialUserTags) against a stub Firestore and assert the PERSISTED doc:
 *   - avoidJobTypes subtracts from stored targetJobType, and a subtraction that
 *     empties the set persists [] (the clear must actually land in Firestore),
 *   - clearTargetJobType empties the stored set,
 *   - negativeJobType accumulates durably.
 *
 * Pure/offline — stub db, no SDK/LLM/network.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { buildMatchingTools } from "./matching-tools.js"
import type { ClaireToolContext } from "../types.js"

function makeDb(initialTags: Record<string, unknown>) {
  const docs = new Map<string, Record<string, unknown>>([["u1", { tags: initialTags }]])
  return {
    docs,
    collection: (_name: string) => ({
      doc: (id: string) => ({
        get: async () => {
          const data = docs.get(id)
          return { exists: data !== undefined, id, data: () => data }
        },
        set: async (data: Record<string, unknown>, _opts?: { merge?: boolean }) => {
          // shallow merge:true is all the writer uses; tags is replaced wholesale per key.
          docs.set(id, { ...(docs.get(id) ?? {}), ...data })
        },
      }),
    }),
  }
}

function makeCtx(db: ReturnType<typeof makeDb>): ClaireToolContext {
  return {
    db: db as never,
    userId: "u1",
    sessionId: "s1",
    lang: "en",
    transport: {
      markRead: async () => {},
      typing: async () => {},
      sendStatus: async () => {},
      sendText: async () => {},
      tapback: async () => {},
      noReply: async () => {},
    },
    judgeModel: "gpt-4.1-mini",
    log: () => {},
    nowIso: () => "2026-06-09T00:00:00.000Z",
  } as unknown as ClaireToolContext
}

function setPrefsTool(ctx: ClaireToolContext) {
  const t = buildMatchingTools(ctx).find(
    (x) => (x as { name?: string }).name === "set_matching_preferences",
  )
  assert.ok(t, "set_matching_preferences tool must be registered")
  return t as { invoke: (a: never, raw: string) => Promise<unknown> }
}

const NULL_ARGS = {
  onlyRoleFunctions: null,
  avoidRoleFunctions: null,
  jobType: null,
  avoidJobTypes: null,
  clearTargetJobType: null,
  locations: null,
  visaStatus: null,
  minSalary: null,
  industrySector: null,
  avoidIndustrySector: null,
  companySize: null,
  careerStage: null,
}

async function run(ctx: ClaireToolContext, args: Record<string, unknown>) {
  const raw = await setPrefsTool(ctx).invoke({} as never, JSON.stringify({ ...NULL_ARGS, ...args }))
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown>
}

function storedTags(db: ReturnType<typeof makeDb>): Record<string, unknown> {
  return (db.docs.get("u1")?.tags ?? {}) as Record<string, unknown>
}

test("avoidJobTypes:['internship'] on targetJobType=['internship'] PERSISTS targetJobType=[] (the live-victim clear)", async () => {
  const db = makeDb({ targetJobType: ["internship"], targetRoleFunction: ["software_engineering"] })
  const ctx = makeCtx(db)
  const out = await run(ctx, { avoidJobTypes: ["internship"] })
  assert.equal(out.ok, true)
  const tags = storedTags(db)
  assert.deepEqual(tags.targetJobType, [], "the empty set MUST land in Firestore — that IS the fix")
  assert.deepEqual(tags.negativeJobType, ["internship"], "negation recorded durably")
  assert.deepEqual(tags.targetRoleFunction, ["software_engineering"], "other axes untouched")
})

test("avoidJobTypes subtracts only the avoided tokens", async () => {
  const db = makeDb({ targetJobType: ["internship", "full_time"] })
  const ctx = makeCtx(db)
  await run(ctx, { avoidJobTypes: ["internship"] })
  assert.deepEqual(storedTags(db).targetJobType, ["full_time"])
})

test("clearTargetJobType:true empties the stored set", async () => {
  const db = makeDb({ targetJobType: ["internship", "new_graduate"] })
  const ctx = makeCtx(db)
  const out = await run(ctx, { clearTargetJobType: true })
  assert.equal(out.ok, true)
  assert.deepEqual(storedTags(db).targetJobType, [])
})

test("positive jobType still REPLACES and un-avoids", async () => {
  const db = makeDb({ targetJobType: [], negativeJobType: ["internship"] })
  const ctx = makeCtx(db)
  await run(ctx, { jobType: ["internship"] })
  const tags = storedTags(db)
  assert.deepEqual(tags.targetJobType, ["internship"])
  assert.deepEqual(tags.negativeJobType, [], "re-wanted job type leaves the negative axis")
})

test("all-null proposal is a no-op (nothing new to save, no write)", async () => {
  const db = makeDb({ targetJobType: ["full_time"] })
  const ctx = makeCtx(db)
  const out = await run(ctx, {})
  assert.equal(out.ok, true)
  assert.match(String(out.summary), /Nothing new/i)
  assert.deepEqual(storedTags(db).targetJobType, ["full_time"])
})

// ── full preference-axis coverage (2026-06-09 follow-up): the prompt promises
// "location, salary floor, visa status → call set_matching_preferences" but the
// schema could not carry visa/salary/industry/company-size/career-stage —
// schema-can't-express = silent drop (the same bug class PR #385 fixed for
// jobType negations). These drive the REAL tool chain and assert the
// PERSISTED doc. ─────────────────────────────────────────────────────────────

test("'I need H1B sponsorship' → visaStatus:'sponsor_needed' PERSISTS", async () => {
  const db = makeDb({ targetRoleFunction: ["software_engineering"] })
  const ctx = makeCtx(db)
  const out = await run(ctx, { visaStatus: "sponsor_needed" })
  assert.equal(out.ok, true)
  assert.equal(storedTags(db).visaStatus, "sponsor_needed")
})

test("'nothing under 140k' → minSalary:140000 PERSISTS", async () => {
  const db = makeDb({})
  const ctx = makeCtx(db)
  const out = await run(ctx, { minSalary: 140000 })
  assert.equal(out.ok, true)
  assert.equal(storedTags(db).minSalary, 140000)
})

test("'I want healthcare, not fintech' → industrySector replaced, fintech onto the negative axis and OUT of positive", async () => {
  const db = makeDb({ industrySector: ["financial_technology"] })
  const ctx = makeCtx(db)
  const out = await run(ctx, {
    industrySector: ["healthcare_and_life_sciences"],
    avoidIndustrySector: ["financial_technology"],
  })
  assert.equal(out.ok, true)
  const tags = storedTags(db)
  assert.deepEqual(tags.industrySector, ["healthcare_and_life_sciences"], "fintech REMOVED from positive")
  assert.deepEqual(tags.negativeIndustrySector, ["financial_technology"], "negation recorded durably")
})

test("companySize + careerStage scalar/replace axes persist", async () => {
  const db = makeDb({})
  const ctx = makeCtx(db)
  const out = await run(ctx, { companySize: ["early_startup"], careerStage: "senior" })
  assert.equal(out.ok, true)
  const tags = storedTags(db)
  assert.deepEqual(tags.companySize, ["early_startup"])
  assert.equal(tags.careerStage, "senior")
})

// ── capture_match_feedback tagDeltas — visaStatus + negativeJobType ride the
// same validateOnboardingCanonicalTags → applyPartialUserTags path (GAP 3). ──

function captureFeedbackTool(ctx: ClaireToolContext) {
  const t = buildMatchingTools(ctx).find(
    (x) => (x as { name?: string }).name === "capture_match_feedback",
  )
  assert.ok(t, "capture_match_feedback tool must be registered")
  return t as { invoke: (a: never, raw: string) => Promise<unknown> }
}

test("capture_match_feedback tagDeltas carries visaStatus + negativeJobType to the persisted doc", async () => {
  const db = makeDb({ targetJobType: ["internship", "full_time"] })
  const ctx = makeCtx(db)
  const raw = await captureFeedbackTool(ctx).invoke(
    {} as never,
    JSON.stringify({
      sentiment: "ambiguous",
      reasonCategory: "none",
      reasonText: "I'm on H1B and not looking for internships anymore",
      tagDeltas: {
        targetRoleFunction: null,
        negativeRoleFunction: null,
        industrySector: null,
        negativeIndustrySector: null,
        companySize: null,
        targetJobType: null,
        negativeJobType: ["internship"],
        targetLocations: null,
        careerStage: null,
        visaStatus: "sponsor_needed",
        minSalary: null,
      },
    }),
  )
  const out = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown>
  assert.equal(out.ok, true)
  assert.equal(out.tagWriteOk, true)
  const tags = storedTags(db)
  assert.equal(tags.visaStatus, "sponsor_needed")
  assert.deepEqual(tags.negativeJobType, ["internship"])
  // the sole writer's boundary subtraction removes the negated type from targetJobType.
  assert.deepEqual(tags.targetJobType, ["full_time"])
})
