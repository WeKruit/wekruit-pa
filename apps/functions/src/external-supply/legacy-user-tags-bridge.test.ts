/**
 * Tests for the dual-write bridge that wires external-sourcing records into
 * `pa-users.tags` via `mergeUserTags` + `applyPartialUserTags`.
 *
 * Focus areas:
 *   1. New candidate (no existing `pa-users.tags`) — bridge fills every
 *      field it can derive from the external record.
 *   2. Existing candidate WITH stronger tags — bridge leaves them alone,
 *      records the skip in `skippedKeys`, and only fills empty slots.
 *   3. Record with no useful signal — bridge no-ops and returns
 *      `wrote: false`.
 */

import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import type { ExternalCandidateRecord } from "@pa/core-types"
import { dualWriteLegacyUserTagsFromExternal } from "./legacy-user-tags-bridge.js"

type Doc = Record<string, unknown>
type Store = Map<string, Map<string, Doc>>

function makeFakeFirestore(seed: Store = new Map()): { db: Firestore; store: Store } {
  const store: Store = seed
  const ensure = (name: string) => {
    let col = store.get(name)
    if (!col) {
      col = new Map()
      store.set(name, col)
    }
    return col
  }
  const collection = (name: string) => {
    const col = ensure(name)
    return {
      doc(id: string) {
        return {
          async get() {
            const data = col.get(id)
            return {
              exists: data !== undefined,
              data: () => data,
            }
          },
          async set(value: Doc, opts?: { merge?: boolean }) {
            const prior = col.get(id) ?? {}
            if (opts?.merge) {
              col.set(id, { ...prior, ...value })
            } else {
              col.set(id, value)
            }
          },
        }
      },
    }
  }
  return { db: { collection } as unknown as Firestore, store }
}

const NOW = "2026-05-14T01:00:00.000Z"

function makeRecord(over: Partial<ExternalCandidateRecord> = {}): ExternalCandidateRecord {
  return {
    recordId: "rec-1",
    batchId: "batch-1",
    source: "juicebox",
    rawPayload: {},
    canonicalLinkedInUrl: "https://linkedin.com/in/alice-example",
    linkedinProfileHash: "h".repeat(64),
    emails: [],
    name: "Alice Example",
    currentTitle: "Senior Software Engineer",
    currentCompany: "Acme Robotics",
    experience: [
      { company: "Acme Robotics", title: "Senior Software Engineer" },
      { company: "Stripe", title: "Software Engineer" },
    ],
    education: [{ school: "MIT", degree: "BS" }],
    sourceTags: [],
    normalizationStatus: "ok",
    identityResolutionStatus: "create_new",
    evidence: [],
    createdAt: NOW,
    ...over,
  }
}

test("bridge fills tags on a fresh candidate (no existing pa-users.tags)", async () => {
  const { db, store } = makeFakeFirestore()
  store.set("pa-users", new Map([["cand-1", { candidateId: "cand-1" }]]))
  const result = await dualWriteLegacyUserTagsFromExternal(
    db,
    "cand-1",
    makeRecord(),
    { nowIso: NOW }
  )
  assert.equal(result.wrote, true)
  const written = (store.get("pa-users")!.get("cand-1") as { tags?: Record<string, unknown> }).tags
  assert.ok(written, "tags subdoc must be present")
  assert.equal(typeof written.recentRoleTitle, "string")
  assert.equal(written.recentRoleTitle, "Senior Software Engineer")
  assert.equal(written.recentCompany, "Acme Robotics")
})

test("bridge preserves existing populated tag fields and reports skips", async () => {
  const { db, store } = makeFakeFirestore()
  store.set(
    "pa-users",
    new Map([
      [
        "cand-2",
        {
          candidateId: "cand-2",
          tags: {
            recentRoleTitle: "Principal Engineer (CV)",
            recentCompany: "Stripe (CV)",
            schemaVersion: 1,
          },
        },
      ],
    ])
  )
  const result = await dualWriteLegacyUserTagsFromExternal(
    db,
    "cand-2",
    makeRecord(),
    { nowIso: NOW }
  )
  // Existing strong-evidence fields kept; bridge did not overwrite them.
  const written = (store.get("pa-users")!.get("cand-2") as { tags: Record<string, unknown> }).tags
  assert.equal(written.recentRoleTitle, "Principal Engineer (CV)")
  assert.equal(written.recentCompany, "Stripe (CV)")
  // skippedKeys advertises the protection.
  assert.ok(result.skippedKeys.includes("recentRoleTitle"))
  assert.ok(result.skippedKeys.includes("recentCompany"))
})

test("P2 (V2.1): coresignal_collect_v2 record with sourceTags fills pa-users.tags.skills", async () => {
  const { db, store } = makeFakeFirestore()
  store.set("pa-users", new Map([["cand-cs-1", { candidateId: "cand-cs-1" }]]))
  const csRecord = makeRecord({
    source: "coresignal_collect_v2",
    sourceTags: [
      "python",
      "kubernetes",
      "react",
      "talent acquisition",
      "machine learning",
    ],
  })
  const result = await dualWriteLegacyUserTagsFromExternal(
    db,
    "cand-cs-1",
    csRecord,
    { nowIso: NOW }
  )
  assert.equal(result.wrote, true)
  const written = (store.get("pa-users")!.get("cand-cs-1") as {
    tags: Record<string, unknown>
  }).tags
  // skills field should be populated with non-empty array (mergeUserTags
  // converts string list to SkillEntry shape with neutral defaults).
  assert.ok(Array.isArray(written.skills), "skills must be an array")
  assert.ok((written.skills as unknown[]).length > 0, "skills must be non-empty")
  assert.ok(result.mergedKeys.includes("skills"))
})

test("P2 (V2.1): existing strong skills are NOT overwritten by sourceTags weak fill", async () => {
  const { db, store } = makeFakeFirestore()
  store.set(
    "pa-users",
    new Map([
      [
        "cand-cs-2",
        {
          candidateId: "cand-cs-2",
          tags: {
            skills: [
              { name: "rust", bucket: "language", baseWeight: 1.2 },
            ],
            schemaVersion: 1,
          },
        },
      ],
    ])
  )
  const csRecord = makeRecord({
    source: "coresignal_collect_v2",
    sourceTags: ["python", "kubernetes"],
  })
  await dualWriteLegacyUserTagsFromExternal(db, "cand-cs-2", csRecord, {
    nowIso: NOW,
  })
  const written = (store.get("pa-users")!.get("cand-cs-2") as {
    tags: Record<string, unknown>
  }).tags
  // existing CV-derived skills preserved
  const skills = written.skills as Array<{ name: string }>
  assert.equal(skills.length, 1)
  assert.equal(skills[0].name, "rust")
})

test("bridge fills legacy tags without clobbering existing globalTags skills", async () => {
  const { db, store } = makeFakeFirestore()
  store.set(
    "pa-users",
    new Map([
      [
        "cand-global-strong",
        {
          candidateId: "cand-global-strong",
          globalTags: {
            skills: [
              {
                name: "python",
                bucket: "programming_languages",
                proficiency: "expert",
                evidenceCount: 5,
                baseWeight: 0.95,
              },
            ],
          },
        },
      ],
    ])
  )
  const csRecord = makeRecord({
    source: "coresignal_collect_v2",
    sourceTags: ["typescript", "react"],
  })
  const result = await dualWriteLegacyUserTagsFromExternal(
    db,
    "cand-global-strong",
    csRecord,
    { nowIso: NOW }
  )
  assert.equal(result.wrote, true)
  const written = store.get("pa-users")!.get("cand-global-strong") as {
    tags: Record<string, unknown>
    globalTags: Record<string, unknown>
  }
  const legacySkills = written.tags.skills as Array<{ name: string }>
  assert.ok(legacySkills.some((s) => s.name === "typescript"))
  const globalSkills = written.globalTags.skills as Array<{ name: string; baseWeight: number }>
  assert.equal(globalSkills.length, 1)
  assert.equal(globalSkills[0].name, "python")
  assert.equal(globalSkills[0].baseWeight, 0.95)
})

test("bridge on a record with no useful signal fills only the canonical 'other' industry sentinel", async () => {
  const { db, store } = makeFakeFirestore()
  store.set("pa-users", new Map([["cand-3", { candidateId: "cand-3" }]]))
  const empty = makeRecord({
    name: undefined,
    currentTitle: undefined,
    currentCompany: undefined,
    experience: [],
  })
  const result = await dualWriteLegacyUserTagsFromExternal(
    db,
    "cand-3",
    empty,
    { nowIso: NOW }
  )
  // `mergeUserTags` returns `industryEnum: ["other"]` for a zero-signal input;
  // that token IS the canonical "industry unknown" sentinel and is safe to
  // write into an empty `pa-users.tags`. We deliberately keep this rather
  // than blanket-suppressing the write so the matching pipeline at least
  // sees a schemaVersion-stamped row.
  assert.equal(result.wrote, true)
  assert.deepEqual(result.mergedKeys, ["industryEnum"])
  const written = (store.get("pa-users")!.get("cand-3") as { tags: Record<string, unknown> }).tags
  assert.deepEqual(written.industryEnum, ["other"])
  // No accidental recentRole / company / skills writes.
  assert.equal(written.recentRoleTitle, undefined)
  assert.equal(written.recentCompany, undefined)
})
