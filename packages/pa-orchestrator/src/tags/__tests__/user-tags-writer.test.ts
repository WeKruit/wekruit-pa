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

test("writeUserTagsFull: happy path writes {tags, globalTags} merge:true", async () => {
  const ctx = makeDb()
  const tags = { skills: ["python"], industryEnum: ["tech_software"], schemaVersion: 1 }
  const res = await writeUserTagsFull(ctx.db, "u-1", tags, { source: "cv" })
  assert.equal(res.ok, true)
  assert.equal(ctx.writes.length, 1)
  assert.equal(ctx.writes[0]!.id, "u-1")
  // Writes BOTH the matching store (tags) AND the /me-facing projection (globalTags) atomically
  // (2026-05-30 — closes the tags↔globalTags split so phone-onboarded users render on /me).
  const written = ctx.writes[0]!.data as { tags: unknown; globalTags: Record<string, unknown> }
  assert.deepEqual(written.tags, tags)
  // Only mappable axes project; skills is 1:1, industryEnum/schemaVersion do not map.
  assert.deepEqual(written.globalTags, { skills: ["python"] })
  // PR1 — the sole writer lands BOTH surfaces atomically: tags + projected globalTags.
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

test("applyPartialUserTags: targetJobType: [] is a LEGAL write that clears the stored value", async () => {
  // Intent axes must be clearable from a pure negation ("I am not looking for
  // an internship"). The cleaner strips only `undefined` — an explicit [] must
  // survive the shallow merge and replace the stale hard-filter value.
  const ctx = makeDb({ "u-1": { tags: { targetJobType: ["internship"] } } })
  const res = await applyPartialUserTags(
    ctx.db,
    "u-1",
    { targetJobType: [] } as Record<string, unknown>,
    { source: "chat", nowIso: "2026-06-09T00:00:00.000Z" }
  )
  assert.equal(res.ok, true)
  const written = ctx.writes[0]!.data as { tags: Record<string, unknown> }
  assert.deepEqual(written.tags.targetJobType, [])
})

test("applyPartialUserTags: negativeJobType subtracts from stored targetJobType (delta-apply)", async () => {
  // Extractor parity (negativeJobType mirrors negativeRoleFunction). targetJobType
  // is an EXACT-match HARD filter with no matcher-side negative read, so the
  // sole writer must apply the subtraction at the boundary: stored ["internship",
  // "full_time"] minus negativeJobType ["internship"] → ["full_time"].
  const ctx = makeDb({ "u-1": { tags: { targetJobType: ["internship", "full_time"] } } })
  const res = await applyPartialUserTags(
    ctx.db,
    "u-1",
    { negativeJobType: ["internship"] } as Record<string, unknown>,
    { source: "chat", nowIso: "2026-06-09T00:00:00.000Z" }
  )
  assert.equal(res.ok, true)
  const written = ctx.writes[0]!.data as { tags: Record<string, unknown> }
  assert.deepEqual(written.tags.targetJobType, ["full_time"])
  assert.deepEqual(written.tags.negativeJobType, ["internship"])
})

test("applyPartialUserTags: PURE negativeJobType negation empties targetJobType to [] (live-victim case)", async () => {
  // "I am not looking for an internship" with targetJobType=["internship"] —
  // the subtraction result [] MUST be persisted (not skipped as empty), or the
  // exact-match hard filter keeps the user locked to intern-only matches.
  const ctx = makeDb({ "u-1": { tags: { targetJobType: ["internship"] } } })
  const res = await applyPartialUserTags(
    ctx.db,
    "u-1",
    { negativeJobType: ["internship"] } as Record<string, unknown>,
    { source: "chat", nowIso: "2026-06-09T00:00:00.000Z" }
  )
  assert.equal(res.ok, true)
  const written = ctx.writes[0]!.data as { tags: Record<string, unknown> }
  assert.deepEqual(written.tags.targetJobType, [])
  assert.deepEqual(written.tags.negativeJobType, ["internship"])
})

test("applyPartialUserTags: negativeJobType storage is shallow-replaced (parity with negativeRoleFunction); subtraction still applies", async () => {
  // Cross-turn ACCUMULATION of the negative axis is the matching-profile
  // REDUCER's job (it reads current.negativeJobType and emits the union). The
  // sole writer replaces per key like every other field — and still subtracts
  // the incoming tokens from the stored positive set.
  const ctx = makeDb({
    "u-1": { tags: { targetJobType: ["contract", "full_time"], negativeJobType: ["internship"] } },
  })
  await applyPartialUserTags(
    ctx.db,
    "u-1",
    { negativeJobType: ["contract"] } as Record<string, unknown>,
    { source: "chat", nowIso: "2026-06-09T00:00:00.000Z" }
  )
  const written = ctx.writes[0]!.data as { tags: Record<string, unknown> }
  assert.deepEqual(written.tags.negativeJobType, ["contract"])
  assert.deepEqual(written.tags.targetJobType, ["full_time"])
})

test("applyPartialUserTags: same-write POSITIVE targetJobType + negativeJobType of OTHER tokens — replace lands, nothing subtracted", async () => {
  // "full-time only, no more internships" → targetJobType:["full_time"] +
  // negativeJobType:["internship"]: the replace lands, then the subtraction
  // removes nothing (internship is not in the new positive set).
  const ctx = makeDb({ "u-1": { tags: { targetJobType: ["internship"] } } })
  await applyPartialUserTags(
    ctx.db,
    "u-1",
    { targetJobType: ["full_time"], negativeJobType: ["internship"] } as Record<string, unknown>,
    { source: "chat", nowIso: "2026-06-09T00:00:00.000Z" }
  )
  const written = ctx.writes[0]!.data as { tags: Record<string, unknown> }
  assert.deepEqual(written.tags.targetJobType, ["full_time"])
  assert.deepEqual(written.tags.negativeJobType, ["internship"])
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

test("applyPartialUserTags: minSalaryUsd=100000 normalizes to V16 minSalary=100000 ('at least 100k')", async () => {
  // Capture-merger-writer contract: the candidate said "at least 100k" → the
  // extractor emits `minSalaryUsd`; V16 reads `tags.minSalary`. The sole writer
  // normalizes at the boundary so the salary floor survives (the live bug
  // dropped it entirely). This is the exact value from the root-caused case.
  const ctx = makeDb()
  const res = await applyPartialUserTags(
    ctx.db,
    "u-1",
    { minSalaryUsd: 100000 } as Record<string, unknown>,
    { source: "chat", nowIso: "2026-05-29T00:00:00.000Z" }
  )
  assert.equal(res.ok, true)
  assert.deepEqual(res.mergedKeys, ["minSalary"])
  const written = ctx.writes[0]!.data as { tags: Record<string, unknown> }
  assert.equal(written.tags.minSalary, 100000)
  assert.equal("minSalaryUsd" in written.tags, false)
})

test("applyPartialUserTags: targetLocations=['anywhere'] preserved (V16 anywhere-bypass token survives)", async () => {
  // "open to anything" → targetLocations:['anywhere'] is the matcher's
  // anywhere-bypass signal (ANYWHERE_LOCATION_TOKENS). The token must reach
  // pa-users.tags verbatim (lowercased) or the bypass never fires and an empty
  // location list over-filters to zero — part of the live recall bug.
  const ctx = makeDb()
  const res = await applyPartialUserTags(
    ctx.db,
    "u-1",
    { targetLocations: ["anywhere"] } as Record<string, unknown>,
    { source: "chat" }
  )
  assert.equal(res.ok, true)
  const written = ctx.writes[0]!.data as { tags: Record<string, unknown> }
  assert.deepEqual(written.tags.targetLocations, ["anywhere"])
})

test("applyPartialUserTags: targetLocations mixed-case 'Anywhere' lowercased + deduped (token canonical)", async () => {
  const ctx = makeDb()
  await applyPartialUserTags(
    ctx.db,
    "u-1",
    { targetLocations: ["Anywhere", "  anywhere ", "Remote", "remote", ""] } as Record<string, unknown>,
    { source: "chat" }
  )
  const written = ctx.writes[0]!.data as { tags: Record<string, unknown> }
  // lowercased, trimmed, empties dropped, deduped — "anywhere" survives so the
  // V16 ANYWHERE_LOCATION_TOKENS check (also lowercasing) matches.
  assert.deepEqual(written.tags.targetLocations, ["anywhere", "remote"])
})

test("applyPartialUserTags: legacy roleFunctionNegativeList folds into canonical negativeRoleFunction", async () => {
  // Back-compat fold: older callers/docs used `roleFunctionNegativeList`; the
  // canonical SUBTRACT field V16 reads is `negativeRoleFunction`. The writer
  // folds the legacy key in (union + dedupe) and drops the legacy name so there
  // is exactly one source of truth.
  const ctx = makeDb()
  const res = await applyPartialUserTags(
    ctx.db,
    "u-1",
    {
      roleFunctionNegativeList: ["software_engineering", "sales_and_account_management"],
      negativeRoleFunction: ["software_engineering"],
    } as Record<string, unknown>,
    { source: "chat" }
  )
  assert.equal(res.ok, true)
  const written = ctx.writes[0]!.data as { tags: Record<string, unknown> }
  assert.deepEqual(
    (written.tags.negativeRoleFunction as string[]).sort(),
    ["sales_and_account_management", "software_engineering"]
  )
  assert.equal("roleFunctionNegativeList" in written.tags, false)
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

test("projectTagsToGlobalTags: careerStage + bufferSteps → careerStageRange (seniority range for /me)", () => {
  // 8fE's real shape: anchor junior + soft careerStage with bufferSteps 3 → junior..staff.
  const g = projectTagsToGlobalTags({
    careerStage: "junior",
    preferenceHardness: { careerStage: { hardness: "soft", bufferSteps: 3, source: "onboarding" } },
  })
  assert.equal(g.careerStage, "junior")
  assert.deepEqual(g.careerStageRange, ["junior", "staff"])
})

test("projectTagsToGlobalTags: no bufferSteps → scalar careerStage only, no range", () => {
  const g = projectTagsToGlobalTags({ careerStage: "senior" })
  assert.equal(g.careerStage, "senior")
  assert.equal(g.careerStageRange, undefined)
})

test("projectTagsToGlobalTags: bufferSteps clamps at the top of the vocab", () => {
  const g = projectTagsToGlobalTags({
    careerStage: "director",
    preferenceHardness: { careerStage: { hardness: "soft", bufferSteps: 99 } },
  })
  // director + 99 → clamps to the last stage (founder), never out of bounds.
  assert.deepEqual(g.careerStageRange, ["director", "founder"])
})

test("projectTagsToGlobalTags: companyStage projects as a multi-pick array (orthogonal to companySize)", () => {
  const g = projectTagsToGlobalTags({ companyStage: ["seed", "series_a"], companySize: ["enterprise"] })
  assert.deepEqual(g.companyStage, ["seed", "series_a"])
  assert.deepEqual(g.companySizePreference, ["enterprise"]) // size axis projects independently
  // a scalar companyStage lifts to a 1-element array on globalTags.
  assert.deepEqual(projectTagsToGlobalTags({ companyStage: "seed" }).companyStage, ["seed"])
})

test("projectTagsToGlobalTags: scalar companySize lifts to a 1-elem globalTags array (was dropped)", () => {
  // tags.companySize can be a scalar (single pick) — must still reach globalTags.companySizePreference.
  assert.deepEqual(projectTagsToGlobalTags({ companySize: "enterprise" }).companySizePreference, ["enterprise"])
  assert.deepEqual(projectTagsToGlobalTags({ companySize: ["seed", "enterprise"] }).companySizePreference, ["seed", "enterprise"])
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

test("projectTagsToGlobalTags: EXPLICIT careerStageRange wins over the derived one", () => {
  // Candidate authored an explicit range via the /me editor — it must DRIVE the
  // projection (and matching), overriding the scalar+bufferSteps derivation.
  const g = projectTagsToGlobalTags({
    careerStage: "junior",
    careerStageRange: ["entry_level", "senior"],
    preferenceHardness: { careerStage: { hardness: "soft", bufferSteps: 2 } },
  })
  assert.equal(g.careerStage, "junior")
  assert.deepEqual(g.careerStageRange, ["entry_level", "senior"])
})

test("projectTagsToGlobalTags: explicit careerStageRange projects even with no scalar careerStage", () => {
  const g = projectTagsToGlobalTags({ careerStageRange: ["mid_level", "staff"] })
  assert.equal(g.careerStage, undefined)
  assert.deepEqual(g.careerStageRange, ["mid_level", "staff"])
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

test("applyPartialUserTags: projectGlobalTags false writes only legacy tags", async () => {
  const ctx = makeDb({
    "u-legacy": {
      tags: { schemaVersion: USER_TAGS_SCHEMA_VERSION },
      globalTags: {
        skills: [{ name: "python", bucket: "programming_languages", baseWeight: 0.95 }],
      },
    },
  })
  const res = await applyPartialUserTags(
    ctx.db,
    "u-legacy",
    { skills: ["typescript"] } as Record<string, unknown>,
    { source: "migration", projectGlobalTags: false },
  )
  assert.equal(res.ok, true)
  const data = ctx.writes[0]!.data as { tags: Record<string, unknown>; globalTags?: unknown }
  assert.ok(data.tags.skills)
  assert.equal(data.globalTags, undefined)
})
