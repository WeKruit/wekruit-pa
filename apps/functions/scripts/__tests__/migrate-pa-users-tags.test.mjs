/**
 * Phase 54 (USER-TAG-04) — Tests for migrate-pa-users-tags.mjs.
 *
 * Coverage:
 *   - projectStatedPrefsToPhase52: maps targetRole/visa/locations correctly
 *   - projectCvSignalsToPhase52: full skill bag + industry passthrough
 *   - bucketYoe: numeric thresholds
 *   - diffTagsObjects: detects added vs changed vs unchanged keys
 *   - migrateUser: idempotency (running twice produces same merge)
 */

import test from "node:test"
import assert from "node:assert/strict"
import {
  projectStatedPrefsToPhase52,
  projectCvSignalsToPhase52,
  bucketYoe,
  diffTagsObjects,
  migrateUser,
  ROLE_TO_FUNCTION,
} from "../migrate-pa-users-tags.mjs"

// ---------------------------------------------------------------------------
// projectStatedPrefsToPhase52
// ---------------------------------------------------------------------------

test("projectStatedPrefsToPhase52: targetRole swe → targetRoleFunction", () => {
  const out = projectStatedPrefsToPhase52({ targetRole: ["swe"] })
  assert.deepEqual(out.targetRoleFunction, ["software_engineering"])
})

test("projectStatedPrefsToPhase52: visaStatus opt → sponsor_needed", () => {
  const out = projectStatedPrefsToPhase52({ visaStatus: "opt" })
  assert.equal(out.visaStatus, "sponsor_needed")
})

test("projectStatedPrefsToPhase52: visaStatus citizen → citizen", () => {
  const out = projectStatedPrefsToPhase52({ visaStatus: "citizen" })
  assert.equal(out.visaStatus, "citizen")
})

test("projectStatedPrefsToPhase52: yoeRange [3,5] → 2-3 (uses min)", () => {
  const out = projectStatedPrefsToPhase52({ yoeRange: [3, 5] })
  assert.equal(out.yoeRange, "2-3")
})

test("projectStatedPrefsToPhase52: targetLocations sf → san_francisco_bay_area", () => {
  const out = projectStatedPrefsToPhase52({ targetLocations: ["sf", "remote"] })
  assert.deepEqual(out.targetLocations, ["san_francisco_bay_area", "remote_united_states"])
})

test("projectStatedPrefsToPhase52: prefersStartup boolean preserved", () => {
  assert.equal(projectStatedPrefsToPhase52({ prefersStartup: true }).prefersStartup, true)
  assert.equal(projectStatedPrefsToPhase52({ prefersStartup: false }).prefersStartup, false)
  assert.equal(projectStatedPrefsToPhase52({ prefersStartup: null }).prefersStartup, undefined)
})

test("projectStatedPrefsToPhase52: empty input → {}", () => {
  assert.deepEqual(projectStatedPrefsToPhase52(null), {})
  assert.deepEqual(projectStatedPrefsToPhase52(undefined), {})
  assert.deepEqual(projectStatedPrefsToPhase52({}), {})
})

// ---------------------------------------------------------------------------
// projectCvSignalsToPhase52
// ---------------------------------------------------------------------------

test("projectCvSignalsToPhase52: skills full bag + dedupe + lowercase", () => {
  const out = projectCvSignalsToPhase52({
    candidateProfile: { skills: ["Python", "TypeScript", "react"] },
    workHistory: [{ skills: ["Python", "AWS"] }],
  })
  assert.deepEqual(out.skills, ["python", "typescript", "react", "aws"])
})

test("projectCvSignalsToPhase52: industries passthrough", () => {
  const out = projectCvSignalsToPhase52({
    industries: ["financial_technology", "software_and_saas"],
    relevantIndustry: ["software_and_saas"],
  })
  assert.deepEqual(out.industrySector, ["financial_technology", "software_and_saas"])
  assert.deepEqual(out.relevantIndustry, ["software_and_saas"])
})

test("projectCvSignalsToPhase52: legacy industryTags → industryEnum", () => {
  const out = projectCvSignalsToPhase52({ industryTags: ["tech_software", "ai_ml"] })
  assert.deepEqual(out.industryEnum, ["tech_software", "ai_ml"])
})

test("projectCvSignalsToPhase52: recentRoleTitle from workHistory[0]", () => {
  const out = projectCvSignalsToPhase52({
    workHistory: [{ title: "SWE Intern", company: "Tesla" }],
  })
  assert.equal(out.recentRoleTitle, "SWE Intern")
  assert.equal(out.recentCompany, "Tesla")
})

test("projectCvSignalsToPhase52: empty CV → {}", () => {
  assert.deepEqual(projectCvSignalsToPhase52(null), {})
  assert.deepEqual(projectCvSignalsToPhase52({}), {})
})

// ---------------------------------------------------------------------------
// bucketYoe
// ---------------------------------------------------------------------------

test("bucketYoe: thresholds", () => {
  assert.equal(bucketYoe(0), "0-1")
  assert.equal(bucketYoe(2), "2-3")
  assert.equal(bucketYoe(5), "4-6")
  assert.equal(bucketYoe(8), "7-10")
  assert.equal(bucketYoe(15), "10+")
  assert.equal(bucketYoe(null), null)
  assert.equal(bucketYoe(-1), null)
})

// ---------------------------------------------------------------------------
// diffTagsObjects
// ---------------------------------------------------------------------------

test("diffTagsObjects: added / changed / unchanged", () => {
  const existing = { skills: ["python"], schemaVersion: 1 }
  const proposed = {
    skills: ["python"],
    targetRoleFunction: ["software_engineering"],
    schemaVersion: 1,
    visaStatus: "citizen",
  }
  const diff = diffTagsObjects(existing, proposed)
  assert.deepEqual(Object.keys(diff.added).sort(), ["targetRoleFunction", "visaStatus"])
  assert.equal(Object.keys(diff.changed).length, 0)
  assert.equal(diff.unchanged, 2)
})

test("diffTagsObjects: change detection", () => {
  const existing = { skills: ["python"] }
  const proposed = { skills: ["python", "go"] }
  const diff = diffTagsObjects(existing, proposed)
  assert.equal(Object.keys(diff.changed).length, 1)
  assert.deepEqual(diff.changed.skills.from, ["python"])
  assert.deepEqual(diff.changed.skills.to, ["python", "go"])
})

test("diffTagsObjects: empty existing", () => {
  const diff = diffTagsObjects(null, { skills: ["go"] })
  assert.deepEqual(Object.keys(diff.added), ["skills"])
})

// ---------------------------------------------------------------------------
// migrateUser (with stub Firestore)
// ---------------------------------------------------------------------------

function makeStubDb({ resumeDoc = null, throwOnSet = false } = {}) {
  const writes = []
  return {
    db: {
      collection: (collName) => {
        if (collName === "parsedCandidateResumes") {
          return {
            where: () => ({
              orderBy: () => ({
                limit: () => ({
                  get: async () => ({
                    empty: !resumeDoc,
                    docs: resumeDoc ? [{ data: () => resumeDoc }] : [],
                  }),
                }),
              }),
            }),
          }
        }
        return {
          doc: (id) => ({
            set: async (data) => {
              if (throwOnSet) throw new Error("simulated_error")
              writes.push({ collection: collName, id, data })
            },
          }),
        }
      },
    },
    writes,
  }
}

test("migrateUser: dry-run writes audit only, idempotent", async () => {
  const ctx = makeStubDb({
    resumeDoc: {
      candidateProfile: { skills: ["Python", "Go"] },
      industries: ["software_and_saas"],
    },
  })
  const userData = {
    statedPreferences: {
      targetRole: ["swe"],
      yoeRange: [3, 3],
      visaStatus: "opt",
    },
  }
  const res1 = await migrateUser(ctx.db, "u-1", userData, { dryRun: true, log: () => {} })
  assert.equal(res1.mode, "dry-run")
  assert.ok(res1.addedKeys >= 1)
  // Audit doc written
  assert.equal(ctx.writes.length, 1)
  assert.equal(ctx.writes[0].collection, "pa-users-tags-migration-audit")

  // Idempotency: same merge produces same result.
  const res2 = await migrateUser(ctx.db, "u-1", userData, { dryRun: true, log: () => {} })
  assert.equal(res2.addedKeys, res1.addedKeys)
})

test("migrateUser: apply writes to pa-users.tags", async () => {
  const ctx = makeStubDb({
    resumeDoc: {
      candidateProfile: { skills: ["Python"] },
    },
  })
  const userData = {
    statedPreferences: { targetRole: ["pm"] },
  }
  const res = await migrateUser(ctx.db, "u-2", userData, { dryRun: false, log: () => {} })
  assert.equal(res.mode, "applied")
  assert.equal(ctx.writes[0].collection, "pa-users")
  assert.equal(ctx.writes[0].id, "u-2")
  const tags = ctx.writes[0].data.tags
  assert.deepEqual(tags.targetRoleFunction, ["product_management"])
  assert.deepEqual(tags.skills, ["python"])
})

test("migrateUser: apply error path returns mode=error", async () => {
  const ctx = makeStubDb({ resumeDoc: null, throwOnSet: true })
  const res = await migrateUser(
    ctx.db,
    "u-3",
    { statedPreferences: { targetRole: ["swe"] } },
    { dryRun: false, log: () => {} }
  )
  assert.equal(res.mode, "error")
  assert.match(res.error, /simulated_error/)
})

// ---------------------------------------------------------------------------
// ROLE_TO_FUNCTION sanity
// ---------------------------------------------------------------------------

test("ROLE_TO_FUNCTION: all CanonicalRole tokens map to valid Phase 52 token or null", () => {
  for (const [role, fn] of Object.entries(ROLE_TO_FUNCTION)) {
    if (fn !== null) {
      assert.match(fn, /^[a-z][a-z_]+$/, `${role} → ${fn} is canonical snake_case`)
    }
  }
})
