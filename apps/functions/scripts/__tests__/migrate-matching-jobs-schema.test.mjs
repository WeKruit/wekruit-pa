/**
 * v1.6 Phase 55 (MATCH-02) — Tests for migrate-matching-jobs-schema.mjs.
 *
 * Coverage:
 *   - mapper exports match canonical values
 *   - computeNewFields extracts roleFunction + industrySector correctly
 *   - isAlreadyMigrated idempotency guard works
 *   - migrateJob (dry-run) writes only to audit collection
 *   - migrateJob (apply) writes to matching-jobs with timestamps
 *   - migrateJob (error) propagates failures
 *   - industryEnum array (legacy 10-bucket) gets mapped + deduped
 */

import test from "node:test"
import assert from "node:assert/strict"
import {
  JOBRIGHT_CATEGORY_TO_ROLE_FUNCTION,
  LEGACY_INDUSTRY_TO_CANONICAL,
  mapJobrightCategoryToRoleFunction,
  mapLegacyIndustryToCanonical,
  inferRoleFromTitle,
  computeNewFields,
  isAlreadyMigrated,
  migrateJob,
} from "../migrate-matching-jobs-schema.mjs"

// ─── Re-export sanity ─────────────────────────────────────────────────────────

test("exports: mapper tables present", () => {
  assert.ok(JOBRIGHT_CATEGORY_TO_ROLE_FUNCTION.tech, "tech mapping present")
  assert.deepEqual(JOBRIGHT_CATEGORY_TO_ROLE_FUNCTION.tech, ["software_engineering"])
  assert.ok(LEGACY_INDUSTRY_TO_CANONICAL.fintech, "fintech mapping present")
  assert.deepEqual(LEGACY_INDUSTRY_TO_CANONICAL.fintech, ["financial_technology"])
})

// ─── computeNewFields ─────────────────────────────────────────────────────────

test("computeNewFields: tech category + fintech key", () => {
  const out = computeNewFields({
    category: "tech",
    title: "Software Engineer",
    industryKey: "fintech",
  })
  assert.deepEqual(out.newRoleFunction, ["software_engineering"])
  assert.deepEqual(out.newIndustrySector, ["financial_technology"])
  assert.equal(out.mapperUsed.role, "category_direct")
  assert.equal(out.mapperUsed.industry, "industryKey")
})

test("computeNewFields: general + industryKey 'tech' is also a category", () => {
  // 'tech' as industryKey IS in category map → wins over title regex.
  const out = computeNewFields({
    category: "general",
    title: "Senior Product Manager",
    industryKey: "tech",
  })
  assert.deepEqual(out.newRoleFunction, ["software_engineering"])
  assert.deepEqual(out.newIndustrySector, ["technology_general"])
  assert.equal(out.mapperUsed.role, "industryKey_as_category")
})

test("computeNewFields: general + no industryKey-as-category → title fallback", () => {
  const out = computeNewFields({
    category: "general",
    title: "Senior Product Manager",
    // 'fintech' is industry-only, not a category
    industryKey: "fintech",
  })
  // No category match in 'general' or 'fintech' → title regex picks PM
  assert.ok(out.newRoleFunction.includes("product_management"))
  assert.equal(out.mapperUsed.role, "title_regex_fallback")
  assert.deepEqual(out.newIndustrySector, ["financial_technology"])
  assert.equal(out.mapperUsed.industry, "industryKey")
})

test("computeNewFields: missing category + missing title", () => {
  const out = computeNewFields({
    industryKey: "ecommerce",
  })
  assert.deepEqual(out.newRoleFunction, [])
  assert.deepEqual(out.newIndustrySector, ["e_commerce_and_retail"])
  assert.equal(out.mapperUsed.role, "no_mapping")
})

test("computeNewFields: industryEnum is an array (legacy 10-bucket)", () => {
  const out = computeNewFields({
    category: "tech",
    industryEnum: ["fintech", "ai_ml"],
  })
  assert.deepEqual(out.newIndustrySector.sort(), [
    "artificial_intelligence_and_machine_learning",
    "financial_technology",
  ].sort())
  assert.equal(out.mapperUsed.industry, "industryEnum_array")
})

test("computeNewFields: industryEnum array dedupes", () => {
  const out = computeNewFields({
    category: "tech",
    // banking + finance both collapse to financial_technology
    industryEnum: ["banking", "finance"],
  })
  assert.deepEqual(out.newIndustrySector, ["financial_technology"])
})

test("computeNewFields: industry fallback chain industryEnum→industryKey→industry", () => {
  // industryEnum present but unmapped; falls through to industryKey
  const out = computeNewFields({
    category: "tech",
    industryEnum: "zzz_not_a_key",
    industryKey: "fintech",
    industry: "tech",
  })
  assert.deepEqual(out.newIndustrySector, ["financial_technology"])

  const out2 = computeNewFields({
    category: "tech",
    industry: "fintech",
  })
  assert.deepEqual(out2.newIndustrySector, ["financial_technology"])
  assert.equal(out2.mapperUsed.industry, "industry")
})

test("computeNewFields: live-data shape — industryKey as category (engineering)", () => {
  // Production verified 2026-05-06: matching-jobs has no `category` or
  // `title` field; industryKey holds 'engineering', 'human_resources',
  // 'customer_service', 'sales', 'product', etc. (jobright category-style).
  const out = computeNewFields({
    industry: "engineering",
    industryKey: "engineering",
    roleTitle: "Optical Manufacturing Technician 2",
  })
  assert.deepEqual(out.newRoleFunction, ["engineering_and_development"])
  assert.equal(out.mapperUsed.role, "industryKey_as_category")
  // 'engineering' is NOT in the industry map → industrySector empty
  assert.deepEqual(out.newIndustrySector, [])
  assert.equal(out.mapperUsed.industry, "no_mapping")
})

test("computeNewFields: live-data — industryKey 'fintech' is industry, title gives role", () => {
  const out = computeNewFields({
    industryKey: "fintech",
    roleTitle: "Software Engineer",
  })
  assert.deepEqual(out.newRoleFunction, ["software_engineering"])
  assert.equal(out.mapperUsed.role, "title_regex_fallback")
  assert.deepEqual(out.newIndustrySector, ["financial_technology"])
  assert.equal(out.mapperUsed.industry, "industryKey")
})

test("computeNewFields: live-data — industryEnum array 10-bucket maps to canonical", () => {
  const out = computeNewFields({
    industryKey: "healthtech",
    industryEnum: ["healthcare_biotech"],
    roleTitle: "Software Engineering Intern",
  })
  assert.deepEqual(out.newIndustrySector, ["healthcare_and_life_sciences"])
  assert.equal(out.mapperUsed.industry, "industryEnum_array")
})

test("computeNewFields: live-data — industryEnum array 'tech_software'", () => {
  const out = computeNewFields({
    industryKey: "enterprise_saas",
    industryEnum: ["tech_software"],
  })
  assert.deepEqual(out.newIndustrySector, ["software_and_saas"])
})

test("computeNewFields: SWE + ML title gets multi-role from title regex", () => {
  const out = computeNewFields({
    category: "general",
    title: "Senior Machine Learning Engineer",
  })
  assert.ok(out.newRoleFunction.includes("software_engineering"))
  assert.ok(out.newRoleFunction.includes("data_analysis"))
})

// ─── isAlreadyMigrated ────────────────────────────────────────────────────────

test("isAlreadyMigrated: never migrated → false", () => {
  const job = { category: "tech" }
  assert.equal(
    isAlreadyMigrated(job, ["software_engineering"], ["technology_general"]),
    false
  )
})

test("isAlreadyMigrated: migrated AND values match → true", () => {
  const job = {
    category: "tech",
    roleFunction: ["software_engineering"],
    industrySector: ["technology_general"],
    roleFunctionMigratedAt: "2026-05-06T00:00:00Z",
    industrySectorMigratedAt: "2026-05-06T00:00:00Z",
  }
  assert.equal(
    isAlreadyMigrated(job, ["software_engineering"], ["technology_general"]),
    true
  )
})

test("isAlreadyMigrated: migrated but value differs → false (re-migrate)", () => {
  const job = {
    category: "tech",
    roleFunction: ["data_analysis"],
    industrySector: ["technology_general"],
    roleFunctionMigratedAt: "2026-05-06T00:00:00Z",
    industrySectorMigratedAt: "2026-05-06T00:00:00Z",
  }
  assert.equal(
    isAlreadyMigrated(job, ["software_engineering"], ["technology_general"]),
    false
  )
})

test("isAlreadyMigrated: only one timestamp set → false", () => {
  const job = {
    roleFunction: ["software_engineering"],
    industrySector: ["technology_general"],
    roleFunctionMigratedAt: "2026-05-06T00:00:00Z",
    // industrySectorMigratedAt missing
  }
  assert.equal(
    isAlreadyMigrated(job, ["software_engineering"], ["technology_general"]),
    false
  )
})

// ─── migrateJob (with stub Firestore) ─────────────────────────────────────────

function makeStubDb({ throwOnUpdate = false, throwOnSet = false } = {}) {
  const writes = []
  const updates = []
  const collectionFn = (collName) => ({
    doc: (id) => ({
      set: async (data) => {
        if (throwOnSet) throw new Error("simulated_audit_set_error")
        writes.push({ collection: collName, id, data })
      },
      update: async (data) => {
        if (throwOnUpdate) throw new Error("simulated_update_error")
        updates.push({ collection: collName, id, data })
      },
      collection: (subName) => ({
        doc: (subId) => ({
          set: async (subData) => {
            if (throwOnSet) throw new Error("simulated_audit_set_error")
            writes.push({ collection: `${collName}/${id}/${subName}`, id: subId, data: subData })
          },
        }),
      }),
    }),
  })
  return {
    db: { collection: collectionFn },
    writes,
    updates,
  }
}

test("migrateJob: dry-run writes ONLY to audit subcollection", async () => {
  const ctx = makeStubDb()
  const res = await migrateJob(
    ctx.db,
    "run-1",
    "job-1",
    {
      category: "tech",
      title: "Software Engineer",
      industryKey: "fintech",
      status: "active",
    },
    { dryRun: true, log: () => {} }
  )
  assert.equal(res.mode, "dry-run")
  assert.deepEqual(res.after.roleFunction, ["software_engineering"])
  assert.deepEqual(res.after.industrySector, ["financial_technology"])
  // Exactly one audit write — to the subcollection.
  assert.equal(ctx.writes.length, 1)
  assert.match(ctx.writes[0].collection, /matching-jobs-migration-audit\/run-1\/jobs/)
  assert.equal(ctx.writes[0].id, "job-1")
  // No updates to matching-jobs in dry-run.
  assert.equal(ctx.updates.length, 0)
})

test("migrateJob: apply writes to matching-jobs with timestamps", async () => {
  const ctx = makeStubDb()
  const res = await migrateJob(
    ctx.db,
    "run-2",
    "job-2",
    {
      category: "data_analytics",
      industryKey: "ai_ml",
    },
    { dryRun: false, log: () => {} }
  )
  assert.equal(res.mode, "applied")
  assert.equal(ctx.updates.length, 1)
  assert.equal(ctx.updates[0].collection, "matching-jobs")
  assert.equal(ctx.updates[0].id, "job-2")
  assert.deepEqual(ctx.updates[0].data.roleFunction, ["data_analysis"])
  assert.deepEqual(ctx.updates[0].data.industrySector, [
    "artificial_intelligence_and_machine_learning",
  ])
  assert.match(ctx.updates[0].data.roleFunctionMigratedAt, /^\d{4}-/)
  assert.match(ctx.updates[0].data.industrySectorMigratedAt, /^\d{4}-/)
})

test("migrateJob: idempotent — already-migrated doc is skipped", async () => {
  const ctx = makeStubDb()
  const res = await migrateJob(
    ctx.db,
    "run-3",
    "job-3",
    {
      category: "tech",
      industryKey: "fintech",
      roleFunction: ["software_engineering"],
      industrySector: ["financial_technology"],
      roleFunctionMigratedAt: "2026-05-06T00:00:00Z",
      industrySectorMigratedAt: "2026-05-06T00:00:00Z",
    },
    { dryRun: false, log: () => {} }
  )
  assert.equal(res.mode, "skipped-already-migrated")
  assert.equal(ctx.updates.length, 0)
  assert.equal(ctx.writes.length, 0)
})

test("migrateJob: idempotent — re-running on same doc twice gives same result", async () => {
  const ctx = makeStubDb()
  const job = { category: "tech", industryKey: "fintech" }
  const r1 = await migrateJob(ctx.db, "run-4", "job-4", job, { dryRun: true, log: () => {} })
  const r2 = await migrateJob(ctx.db, "run-4", "job-4", job, { dryRun: true, log: () => {} })
  assert.deepEqual(r1.after, r2.after)
})

test("migrateJob: apply error returns mode=error", async () => {
  const ctx = makeStubDb({ throwOnUpdate: true })
  const res = await migrateJob(
    ctx.db,
    "run-5",
    "job-5",
    { category: "tech" },
    { dryRun: false, log: () => {} }
  )
  assert.equal(res.mode, "error")
  assert.match(res.error, /simulated_update_error/)
})

test("migrateJob: dry-run audit write error returns mode=error", async () => {
  const ctx = makeStubDb({ throwOnSet: true })
  const res = await migrateJob(
    ctx.db,
    "run-6",
    "job-6",
    { category: "tech" },
    { dryRun: true, log: () => {} }
  )
  assert.equal(res.mode, "error")
  assert.match(res.error, /simulated_audit_set_error/)
})

// ─── Mapper convergence with TS source ───────────────────────────────────────

test("mapper: every JOBRIGHT_CATEGORY_TO_ROLE_FUNCTION entry is callable", () => {
  for (const cat of Object.keys(JOBRIGHT_CATEGORY_TO_ROLE_FUNCTION)) {
    const out = mapJobrightCategoryToRoleFunction(cat, undefined)
    // general → []  is fine; everything else returns at least one role.
    if (cat === "general") {
      assert.deepEqual(out, [])
    } else {
      assert.ok(out.length > 0, `${cat} → ${JSON.stringify(out)}`)
    }
  }
})

test("mapper: every LEGACY_INDUSTRY_TO_CANONICAL entry is callable", () => {
  for (const k of Object.keys(LEGACY_INDUSTRY_TO_CANONICAL)) {
    const out = mapLegacyIndustryToCanonical(k)
    if (k === "other" || k === "unknown") {
      assert.deepEqual(out, [])
    } else {
      assert.ok(out.length > 0, `${k} → ${JSON.stringify(out)}`)
    }
  }
})

test("inferRoleFromTitle: empty/null → []", () => {
  assert.deepEqual(inferRoleFromTitle(""), [])
  assert.deepEqual(inferRoleFromTitle(undefined), [])
  assert.deepEqual(inferRoleFromTitle(null), [])
})
