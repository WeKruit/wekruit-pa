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
  assert.deepEqual(ctx.writes[0]!.data, { tags })
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
        schemaVersion: 1,
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
