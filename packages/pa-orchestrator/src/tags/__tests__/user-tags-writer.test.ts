/**
 * Phase 54 (USER-TAG-05) — Tests for the sole-writer (user-tags-writer.ts).
 *
 * Coverage:
 *   - writeUserTagsFull: happy path + error path (Firestore throw → ok:false)
 *   - applyPartialUserTags: read-merge-write, schema bookkeeping, fail-open
 *   - auditUsersWithoutTags: counts + missing list
 */

import assert from "node:assert/strict"
import test from "node:test"
import {
  writeUserTagsFull,
  applyPartialUserTags,
  auditUsersWithoutTags,
  projectTagsToGlobalTags,
} from "../user-tags-writer.js"
import { USER_TAGS_SCHEMA_VERSION } from "../user-tags-merger.js"

// Minimal Firestore stub.
function makeDb(initialDocs: Record<string, Record<string, unknown>> = {}) {
  const writes: Array<{ id: string; data: unknown; merge: boolean }> = []
  let throwOnSet = false
  let throwOnGet = false
  const docs = new Map<string, Record<string, unknown>>(Object.entries(initialDocs))

  const collectionFn = (collName: string) => {
    return {
      doc: (id: string) => ({
        get: async () => {
          if (throwOnGet) throw new Error("simulated_get_error")
          const data = docs.get(id)
          return {
            exists: data !== undefined,
            id,
            data: () => data,
          }
        },
        set: async (data: Record<string, unknown>, opts: { merge?: boolean }) => {
          if (throwOnSet) throw new Error("simulated_set_error")
          writes.push({ id, data, merge: !!opts?.merge })
          if (opts?.merge && docs.has(id)) {
            docs.set(id, { ...docs.get(id), ...data, tags: { ...(docs.get(id)?.tags as Record<string, unknown>), ...(data.tags as Record<string, unknown>) } })
          } else {
            docs.set(id, data)
          }
        },
      }),
      orderBy: () => ({
        limit: () => ({
          get: async () => ({ empty: docs.size === 0, docs: Array.from(docs.entries()).map(([id, data]) => ({ id, data: () => data })) }),
          startAfter: () => ({ get: async () => ({ empty: true, docs: [] }) }),
        }),
      }),
    }
  }

  return {
    db: {
      collection: collectionFn,
    } as unknown as Parameters<typeof writeUserTagsFull>[0],
    writes,
    docs,
    triggerSetError: () => { throwOnSet = true },
    triggerGetError: () => { throwOnGet = true },
  }
}

// ---------------------------------------------------------------------------
// writeUserTagsFull
// ---------------------------------------------------------------------------

test("writeUserTagsFull: happy path writes {tags} merge:true", async () => {
  const ctx = makeDb()
  const tags = { skills: ["python"], industryEnum: ["tech_software"], schemaVersion: 1 }
  const res = await writeUserTagsFull(ctx.db, "u-1", tags, { source: "cv" })
  assert.equal(res.ok, true)
  assert.equal(ctx.writes.length, 1)
  assert.equal(ctx.writes[0]!.id, "u-1")
  // PR1 — the sole writer now lands BOTH surfaces atomically: tags + projected globalTags.
  assert.deepEqual(ctx.writes[0]!.data, { tags, globalTags: projectTagsToGlobalTags(tags) })
  assert.equal(ctx.writes[0]!.merge, true)
})

test("writeUserTagsFull: missing userId → ok:false", async () => {
  const ctx = makeDb()
  const res = await writeUserTagsFull(ctx.db, "", { skills: [] })
  assert.equal(res.ok, false)
  assert.equal(res.error, "no_user_id")
  assert.equal(ctx.writes.length, 0)
})

test("writeUserTagsFull: Firestore throws → ok:false (fail-open)", async () => {
  const ctx = makeDb()
  ctx.triggerSetError()
  const res = await writeUserTagsFull(ctx.db, "u-1", { skills: ["python"] })
  assert.equal(res.ok, false)
  assert.match(res.error ?? "", /simulated_set_error/)
})

// ---------------------------------------------------------------------------
// applyPartialUserTags
// ---------------------------------------------------------------------------

test("applyPartialUserTags: read-merge-write (chat source stamps lastUpdatedFromChat)", async () => {
  const ctx = makeDb({
    "u-1": {
      tags: {
        skills: ["python"],
        schemaVersion: USER_TAGS_SCHEMA_VERSION,
      },
    },
  })
  const res = await applyPartialUserTags(
    ctx.db,
    "u-1",
    { targetRoleFunction: ["software_engineering"] } as Record<string, unknown>,
    { source: "chat", nowIso: "2026-05-06T00:00:00.000Z" }
  )
  assert.equal(res.ok, true)
  assert.deepEqual(res.mergedKeys, ["targetRoleFunction"])
  assert.equal(ctx.writes.length, 1)
  const written = ctx.writes[0]!.data as { tags: Record<string, unknown> }
  // Merged: existing skills (string-shape preserved when not in partial) + new targetRoleFunction
  assert.deepEqual(written.tags.skills, ["python"])
  assert.deepEqual(written.tags.targetRoleFunction, ["software_engineering"])
  assert.equal(written.tags.lastUpdatedFromChat, "2026-05-06T00:00:00.000Z")
  assert.equal(written.tags.schemaVersion, USER_TAGS_SCHEMA_VERSION)
})

test("applyPartialUserTags: cv source stamps lastUpdatedFromCv", async () => {
  const ctx = makeDb()
  await applyPartialUserTags(
    ctx.db,
    "u-1",
    { skills: ["go"] } as Record<string, unknown>,
    { source: "cv", nowIso: "2026-05-06T01:00:00.000Z" }
  )
  const written = ctx.writes[0]!.data as { tags: Record<string, unknown> }
  assert.equal(written.tags.lastUpdatedFromCv, "2026-05-06T01:00:00.000Z")
  assert.equal(written.tags.lastUpdatedFromChat, undefined)
  // Phase 61 — applyPartialUserTags now canonicalizes raw string skills to
  // SkillEntry objects so the V16 score reads `skills[].baseWeight` correctly.
  const skills = written.tags.skills as Array<{ name: string; baseWeight: number }>
  assert.equal(skills.length, 1)
  assert.equal(skills[0]!.name, "go")
  assert.equal(skills[0]!.baseWeight, 1.0)
})

test("applyPartialUserTags: empty partial → ok:false skip", async () => {
  const ctx = makeDb()
  const res = await applyPartialUserTags(ctx.db, "u-1", {}, { source: "chat" })
  assert.equal(res.ok, false)
  assert.equal(res.error, "empty_partial")
  assert.equal(ctx.writes.length, 0)
})

test("applyPartialUserTags: undefined values stripped", async () => {
  const ctx = makeDb()
  await applyPartialUserTags(
    ctx.db,
    "u-1",
    { skills: undefined, targetRoleFunction: ["software_engineering"] } as Record<string, unknown>,
    { source: "chat", nowIso: "2026-05-06T02:00:00.000Z" }
  )
  const written = ctx.writes[0]!.data as { tags: Record<string, unknown> }
  // skills (undefined) NOT written
  assert.equal("skills" in (written.tags as Record<string, unknown>), false)
  assert.deepEqual(written.tags.targetRoleFunction, ["software_engineering"])
})

test("applyPartialUserTags: normalizes extractor minSalaryUsd to V16 minSalary", async () => {
  const ctx = makeDb()
  const res = await applyPartialUserTags(
    ctx.db,
    "u-1",
    { minSalaryUsd: 180000 } as Record<string, unknown>,
    { source: "chat", nowIso: "2026-05-06T02:30:00.000Z" }
  )
  assert.equal(res.ok, true)
  assert.deepEqual(res.mergedKeys, ["minSalary"])
  const written = ctx.writes[0]!.data as { tags: Record<string, unknown> }
  assert.equal(written.tags.minSalary, 180000)
  assert.equal("minSalaryUsd" in written.tags, false)
})

test("applyPartialUserTags: no userId → ok:false skip", async () => {
  const ctx = makeDb()
  const res = await applyPartialUserTags(ctx.db, "", { skills: ["x"] } as Record<string, unknown>)
  assert.equal(res.ok, false)
  assert.equal(res.error, "no_user_id")
  assert.equal(ctx.writes.length, 0)
})

test("applyPartialUserTags: Firestore read fails → continues with empty existing", async () => {
  const ctx = makeDb()
  ctx.triggerGetError()
  const res = await applyPartialUserTags(
    ctx.db,
    "u-1",
    { skills: ["go"] } as Record<string, unknown>,
    { source: "chat", nowIso: "2026-05-06T03:00:00.000Z" }
  )
  // Write still proceeds.
  assert.equal(res.ok, true)
  assert.equal(ctx.writes.length, 1)
})

test("applyPartialUserTags: Firestore write fails → ok:false (fail-open)", async () => {
  const ctx = makeDb()
  ctx.triggerSetError()
  const res = await applyPartialUserTags(ctx.db, "u-1", { skills: ["x"] } as Record<string, unknown>)
  assert.equal(res.ok, false)
  assert.match(res.error ?? "", /simulated_set_error/)
})

test("applyPartialUserTags: raw string skills auto-upgraded to SkillEntry[] (Phase 61)", async () => {
  const ctx = makeDb()
  await applyPartialUserTags(
    ctx.db,
    "u-1",
    { skills: ["Python", "TypeScript", "react"] } as Record<string, unknown>,
    { source: "chat" }
  )
  const written = ctx.writes[0]!.data as { tags: Record<string, unknown> }
  const skills = written.tags.skills as Array<{
    name: string
    bucket: string
    proficiency: string
    evidenceCount: number
    baseWeight: number
  }>
  assert.equal(skills.length, 3)
  assert.deepEqual(
    skills.map((s) => s.name),
    ["python", "typescript", "react"]
  )
  // Phase 52 buckets via inferSkillBucket heuristic.
  assert.equal(skills[0]!.bucket, "programming_languages")
  assert.equal(skills[2]!.bucket, "frameworks_and_libraries")
  // baseWeight=1.0 default so V16 score works.
  assert.ok(skills.every((s) => s.baseWeight === 1.0))
  assert.ok(skills.every((s) => s.proficiency === "intermediate"))
})

test("applyPartialUserTags: SkillEntry input preserved (object shape)", async () => {
  const ctx = makeDb()
  const inputSkills = [
    {
      name: "python",
      bucket: "programming_languages",
      proficiency: "expert",
      evidenceCount: 5,
      baseWeight: 0.9,
    },
  ]
  await applyPartialUserTags(
    ctx.db,
    "u-1",
    { skills: inputSkills } as Record<string, unknown>,
    { source: "cv" }
  )
  const written = ctx.writes[0]!.data as { tags: Record<string, unknown> }
  const skills = written.tags.skills as Array<Record<string, unknown>>
  assert.equal(skills[0]!.proficiency, "expert")
  assert.equal(skills[0]!.evidenceCount, 5)
  assert.equal(skills[0]!.baseWeight, 0.9)
})

// ---------------------------------------------------------------------------
// auditUsersWithoutTags
// ---------------------------------------------------------------------------

test("auditUsersWithoutTags: counts users with/without tags", async () => {
  const ctx = makeDb({
    "u-1": { tags: { skills: ["python"] } },
    "u-2": { name: "no tags here" },
    "u-3": { tags: { skills: ["go"] } },
    "u-4": {},
  })
  const res = await auditUsersWithoutTags(ctx.db, { pageSize: 100 })
  assert.equal(res.total, 4)
  assert.equal(res.withTags, 2)
  assert.deepEqual(res.missing.sort(), ["u-2", "u-4"])
})

// ===========================================================================
// SOFT-vs-HARD (2026-05-28) — preferenceHardness per-axis merge
// ===========================================================================

test("applyPartialUserTags: preferenceHardness merges PER-AXIS (accumulates deltas)", async () => {
  const ctx = makeDb({
    "u-ph": {
      tags: {
        skills: ["python"],
        schemaVersion: USER_TAGS_SCHEMA_VERSION,
        preferenceHardness: {
          salary: { hardness: "hard", source: "conversation" },
        },
      },
    },
  })
  // A later chat turn adds a DIFFERENT axis — salary must survive.
  const res = await applyPartialUserTags(
    ctx.db,
    "u-ph",
    { preferenceHardness: { location: { hardness: "soft", source: "conversation" } } } as Record<string, unknown>,
    { source: "chat" },
  )
  assert.equal(res.ok, true)
  const written = ctx.writes[0]!.data as { tags: Record<string, unknown> }
  const ph = written.tags.preferenceHardness as Record<string, { hardness: string }>
  assert.equal(ph.salary?.hardness, "hard") // preserved
  assert.equal(ph.location?.hardness, "soft") // added
})

test("applyPartialUserTags: preferenceHardness same-axis update overwrites", async () => {
  const ctx = makeDb({
    "u-ph2": {
      tags: {
        skills: ["python"],
        schemaVersion: USER_TAGS_SCHEMA_VERSION,
        preferenceHardness: { industrySector: { hardness: "soft" } },
      },
    },
  })
  const res = await applyPartialUserTags(
    ctx.db,
    "u-ph2",
    { preferenceHardness: { industrySector: { hardness: "hard" } } } as Record<string, unknown>,
    { source: "chat" },
  )
  assert.equal(res.ok, true)
  const written = ctx.writes[0]!.data as { tags: Record<string, unknown> }
  const ph = written.tags.preferenceHardness as Record<string, { hardness: string }>
  assert.equal(ph.industrySector?.hardness, "hard") // overwritten
})

test("applyPartialUserTags: preferenceHardness on a doc with none writes it wholesale", async () => {
  const ctx = makeDb({
    "u-ph3": { tags: { skills: ["python"], schemaVersion: USER_TAGS_SCHEMA_VERSION } },
  })
  const res = await applyPartialUserTags(
    ctx.db,
    "u-ph3",
    { preferenceHardness: { salary: { hardness: "hard" } } } as Record<string, unknown>,
    { source: "chat" },
  )
  assert.equal(res.ok, true)
  const written = ctx.writes[0]!.data as { tags: Record<string, unknown> }
  const ph = written.tags.preferenceHardness as Record<string, { hardness: string }>
  assert.equal(ph.salary?.hardness, "hard")
})

// ---------------------------------------------------------------------------
// PR1 — projectTagsToGlobalTags (tags → /me globalTags) + write-through
// ---------------------------------------------------------------------------

test("projectTagsToGlobalTags: renames tags→globalTags fields", () => {
  const g = projectTagsToGlobalTags({
    targetRoleFunction: ["software_engineering"],
    skills: [{ name: "python" }],
    industrySector: ["financial_technology"],
    targetLocations: ["new_york"],
    targetJobType: ["full_time"],
    relevantTags: ["fintech"],
    minSalary: 140000,
    visaStatus: "sponsor_needed",
  })
  assert.deepEqual(g.roleFunction, ["software_engineering"])
  assert.deepEqual(g.skills, [{ name: "python" }])
  assert.deepEqual(g.industrySector, ["financial_technology"])
  assert.deepEqual(g.targetLocations, ["new_york"])
  assert.deepEqual(g.targetJobType, ["full_time"])
  assert.deepEqual(g.relevantTags, ["fintech"])
  assert.equal(g.minSalaryUsd, 140000)
  assert.equal(g.visaStatus, "sponsor_needed")
  // tags-only field names must NOT leak into globalTags.
  assert.equal(g.targetRoleFunction, undefined)
  assert.equal(g.minSalary, undefined)
})

test("projectTagsToGlobalTags: companySize 'open' → 'no_preference' sentinel + scalar lift", () => {
  assert.deepEqual(
    projectTagsToGlobalTags({ companySize: "open" }).companySizePreference,
    ["no_preference"],
  )
  // scalar single-pick lifts to a 1-elem array (was dropped pre-PR1)
  assert.deepEqual(
    projectTagsToGlobalTags({ companySize: "enterprise" }).companySizePreference,
    ["enterprise"],
  )
  // array form: only 'open' is rewritten, others pass through
  assert.deepEqual(
    projectTagsToGlobalTags({ companySize: ["seed", "open", "enterprise"] }).companySizePreference,
    ["seed", "no_preference", "enterprise"],
  )
})

test("projectTagsToGlobalTags: careerStageRange derived from careerStage + bufferSteps", () => {
  const g = projectTagsToGlobalTags({
    careerStage: "junior",
    preferenceHardness: { careerStage: { hardness: "soft", bufferSteps: 2 } },
  })
  assert.equal(g.careerStage, "junior")
  // junior + 2 steps up CAREER_STAGE_VOCAB → [junior, senior] (mid_level is +1, senior +2)
  const range = g.careerStageRange as [string, string]
  assert.equal(range[0], "junior")
  assert.equal(range[1], "senior")
  // no buffer → scalar only, no range
  const g2 = projectTagsToGlobalTags({ careerStage: "junior" })
  assert.equal(g2.careerStage, "junior")
  assert.equal(g2.careerStageRange, undefined)
})

test("projectTagsToGlobalTags: companyStage projected as array (scalar or array on tags)", () => {
  assert.deepEqual(
    projectTagsToGlobalTags({ companyStage: "seed" }).companyStage,
    ["seed"],
  )
  assert.deepEqual(
    projectTagsToGlobalTags({ companyStage: ["seed", "series_a"] }).companyStage,
    ["seed", "series_a"],
  )
  // absent companyStage → not emitted
  assert.equal(projectTagsToGlobalTags({ skills: [] }).companyStage, undefined)
})

test("projectTagsToGlobalTags: legacy visa tokens folded; off-vocab dropped", () => {
  assert.equal(projectTagsToGlobalTags({ visaStatus: "gc" }).visaStatus, "permanent_resident")
  assert.equal(projectTagsToGlobalTags({ visaStatus: "h1b" }).visaStatus, "sponsor_needed")
  assert.equal(projectTagsToGlobalTags({ visaStatus: "opt" }).visaStatus, "sponsor_needed")
  assert.equal(projectTagsToGlobalTags({ visaStatus: "citizen" }).visaStatus, "citizen")
  // unknown/off-vocab visa is dropped (must never fail the /me read parse)
  assert.equal(projectTagsToGlobalTags({ visaStatus: "tn_visa" }).visaStatus, undefined)
})

test("applyPartialUserTags: write lands projected globalTags alongside tags", async () => {
  const ctx = makeDb({
    "u-proj": { tags: { skills: [{ name: "python" }], schemaVersion: USER_TAGS_SCHEMA_VERSION } },
  })
  const res = await applyPartialUserTags(
    ctx.db,
    "u-proj",
    { targetRoleFunction: ["software_engineering"], companySize: "open" } as Record<string, unknown>,
    { source: "chat" },
  )
  assert.equal(res.ok, true)
  const data = ctx.writes[0]!.data as { tags: Record<string, unknown>; globalTags: Record<string, unknown> }
  assert.ok(data.globalTags, "write must include globalTags")
  assert.deepEqual(data.globalTags.roleFunction, ["software_engineering"])
  assert.deepEqual(data.globalTags.companySizePreference, ["no_preference"])
  assert.deepEqual(data.globalTags.skills, [{ name: "python" }])
})
