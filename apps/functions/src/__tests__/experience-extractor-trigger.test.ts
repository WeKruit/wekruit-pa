/**
 * EX1 PR-C — handler tests for the parsedCandidateResumes trigger.
 *
 * Pins:
 *   - feature flag off → status="disabled", no DB writes
 *   - empty workHistory → no_work_history
 *   - same content hash + version → already_at_version (idempotent)
 *   - happy path writes derivedExperience + derivedExperienceVersion +
 *     derivedExperienceContentHash to pa-users/{uid}
 *
 * The extractor itself is mocked at the cache layer so we don't hit OpenAI.
 */

import { test, mock } from "node:test"
import assert from "node:assert/strict"
import type { Firestore } from "firebase-admin/firestore"
import {
  computeWorkHistoryHash,
  isExperienceExtractorLive,
  runExperienceExtractorForUser,
} from "../experience-extractor-trigger.js"
import type { WorkEntryExtractionOutput } from "@pa/pa-experience-extractor"

function makeFirestoreStub(
  initialUser: Record<string, unknown> | undefined,
  cacheSeed: Record<string, WorkEntryExtractionOutput> = {}
) {
  const userStore: Map<string, Record<string, unknown>> = new Map()
  if (initialUser) userStore.set("u1", initialUser)
  const cacheStore: Map<string, WorkEntryExtractionOutput> = new Map(
    Object.entries(cacheSeed)
  )

  let userWrites = 0

  function docHandle(path: string) {
    return {
      async get() {
        if (path === "pa-users/u1") {
          return {
            exists: userStore.has("u1"),
            data: () => userStore.get("u1"),
          }
        }
        // Cache subcollection doc
        const match = /^pa-users\/(?<uid>[^/]+)\/workEntries\/(?<entryId>[^/]+)$/.exec(path)
        if (match) {
          const key = `${match.groups!["uid"]}::${match.groups!["entryId"]}`
          return {
            exists: cacheStore.has(key),
            data: () => cacheStore.get(key),
          }
        }
        return { exists: false, data: () => undefined }
      },
      async set(value: Record<string, unknown>, opts?: { merge?: boolean }) {
        if (path === "pa-users/u1") {
          userWrites++
          const prev = userStore.get("u1") ?? {}
          userStore.set("u1", opts?.merge ? { ...prev, ...value } : value)
          return
        }
        const match = /^pa-users\/(?<uid>[^/]+)\/workEntries\/(?<entryId>[^/]+)$/.exec(path)
        if (match) {
          const key = `${match.groups!["uid"]}::${match.groups!["entryId"]}`
          cacheStore.set(key, value as unknown as WorkEntryExtractionOutput)
        }
      },
      collection(sub: string) {
        return collectionHandle(`${path}/${sub}`)
      },
    }
  }
  function collectionHandle(path: string) {
    return {
      doc(id: string) {
        return docHandle(`${path}/${id}`)
      },
    }
  }
  return {
    db: { collection: (name: string) => collectionHandle(name) } as unknown as Firestore,
    userStore,
    cacheStore,
    get userWrites() {
      return userWrites
    },
  }
}

const FIXED_NOW = new Date("2026-05-22T00:00:00.000Z")

test("isExperienceExtractorLive: defaults to false", () => {
  assert.equal(isExperienceExtractorLive({}), false)
  assert.equal(isExperienceExtractorLive({ PA_EXPERIENCE_EXTRACTOR_LIVE: "false" }), false)
  assert.equal(isExperienceExtractorLive({ PA_EXPERIENCE_EXTRACTOR_LIVE: "true" }), true)
})

test("computeWorkHistoryHash: stable across reruns", () => {
  const wh = [{ title: "SWE", company: "Acme", startDate: "2022-01", endDate: "2024-01" }]
  assert.equal(computeWorkHistoryHash(wh), computeWorkHistoryHash(wh))
})

test("computeWorkHistoryHash: changes when title changes", () => {
  const a = computeWorkHistoryHash([
    { title: "SWE", company: "Acme", startDate: "2022-01", endDate: "2024-01" },
  ])
  const b = computeWorkHistoryHash([
    { title: "Senior SWE", company: "Acme", startDate: "2022-01", endDate: "2024-01" },
  ])
  assert.notEqual(a, b)
})

test("runExperienceExtractorForUser: feature-flag off → disabled, no write", async () => {
  const stub = makeFirestoreStub({})
  const result = await runExperienceExtractorForUser({
    db: stub.db,
    uid: "u1",
    workHistory: [{ title: "SWE", company: "Acme", startDate: "2022-01", endDate: "2024-01" }],
    claimedSkills: ["python"],
    openaiApiKey: "fake",
    isLive: false,
    now: FIXED_NOW,
  })
  assert.equal(result.status, "disabled")
  assert.equal(stub.userWrites, 0)
})

test("runExperienceExtractorForUser: empty workHistory → no_work_history, no write", async () => {
  const stub = makeFirestoreStub({})
  const result = await runExperienceExtractorForUser({
    db: stub.db,
    uid: "u1",
    workHistory: [],
    claimedSkills: ["python"],
    openaiApiKey: "fake",
    isLive: true,
    now: FIXED_NOW,
  })
  assert.equal(result.status, "no_work_history")
  assert.equal(stub.userWrites, 0)
})

test("runExperienceExtractorForUser: idempotent — already at version + same hash → skip", async () => {
  const wh = [{ title: "SWE", company: "Acme", startDate: "2022-01", endDate: "2024-01" }]
  const expectedHash = computeWorkHistoryHash(wh)
  const stub = makeFirestoreStub({
    derivedExperienceVersion: "v1",
    derivedExperienceContentHash: expectedHash,
  })
  const result = await runExperienceExtractorForUser({
    db: stub.db,
    uid: "u1",
    workHistory: wh,
    claimedSkills: ["python"],
    openaiApiKey: "fake",
    isLive: true,
    now: FIXED_NOW,
  })
  assert.equal(result.status, "already_at_version")
  assert.equal(stub.userWrites, 0, "no write when already at version + same hash")
})

test("runExperienceExtractorForUser: cache-hit happy path writes derivedExperience", async () => {
  // Seed the cache so the extractor never calls OpenAI in this test.
  const cachedOutput: WorkEntryExtractionOutput = {
    entryId: "_will_be_replaced_",
    extractedSkills: ["python", "react"],
    durationMonths: 24,
    industryGuess: "fintech",
    responsibilityLevel: "individual_contributor",
    confidence: 0.9,
    llmModel: "gpt-5.4-nano",
    extractedAt: "2026-01-01T00:00:00.000Z",
  }
  // Replicate computeEntryId(uid="u1", index=0, title="SWE", startDate="2022-01")
  const { computeEntryId } = await import("@pa/pa-experience-extractor")
  const entryId = computeEntryId({
    uid: "u1",
    index: 0,
    title: "SWE",
    startDate: "2022-01",
  })
  const seeded: WorkEntryExtractionOutput = { ...cachedOutput, entryId }

  const stub = makeFirestoreStub(undefined, { [`u1::${entryId}`]: seeded })
  const result = await runExperienceExtractorForUser({
    db: stub.db,
    uid: "u1",
    workHistory: [{ title: "SWE", company: "Acme", startDate: "2022-01", endDate: "2024-01" }],
    claimedSkills: ["python", "react", "rust"],
    openaiApiKey: undefined, // never used because cache hits
    isLive: true,
    now: FIXED_NOW,
  })

  assert.equal(result.status, "written")
  assert.equal(result.entriesProcessed, 1)
  assert.equal(result.cacheHits, 1)
  assert.equal(result.llmCalls, 0)
  assert.equal(stub.userWrites, 1)

  const written = stub.userStore.get("u1") as Record<string, unknown>
  assert.equal(written["derivedExperienceVersion"], "v1")
  assert.ok(typeof written["derivedExperienceContentHash"] === "string")
  const derived = written["derivedExperience"] as Record<string, unknown>
  assert.ok(derived)
  assert.equal(derived["version"], "v1")
  assert.deepEqual(derived["unverifiedSkills"], ["rust"])
})
