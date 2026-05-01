import test from "node:test"
import assert from "node:assert/strict"
import { MockFirestore, asFirestore } from "../mock-firestore.js"
import { saveJobProfile } from "../../tools/save-job-profile.js"

test("saveJobProfile: first save creates active doc with createdAt", async () => {
  const mfs = new MockFirestore()
  const out = await saveJobProfile(
    {
      userId: "u1",
      profile: { industry: "tech", sponsorship: "h1b", location: "湾区", sizePreference: "either" },
    },
    { db: asFirestore(mfs), nowIso: () => "2026-04-30T00:00:00Z" }
  )
  assert.equal(out.ok, true)
  const got = (await mfs.collection("pa-job-profiles").doc("u1").get()).data()
  assert.equal(got?.status, "active")
  assert.equal(got?.createdAt, "2026-04-30T00:00:00Z")
  assert.equal(got?.cvParsedAt, "2026-04-30T00:00:00Z")
  assert.equal(got?.lastJobBatchSentAt, null)
})

test("saveJobProfile: re-save merges + bumps updatedAt + preserves createdAt", async () => {
  const mfs = new MockFirestore()
  await saveJobProfile(
    {
      userId: "u1",
      profile: { industry: "tech", sponsorship: "h1b", location: "湾区", sizePreference: "either" },
    },
    { db: asFirestore(mfs), nowIso: () => "2026-04-30T00:00:00Z" }
  )
  await saveJobProfile(
    {
      userId: "u1",
      profile: { industry: "fintech", sponsorship: "none", location: "NYC", sizePreference: "bigtech" },
    },
    { db: asFirestore(mfs), nowIso: () => "2026-05-01T00:00:00Z" }
  )
  const got = (await mfs.collection("pa-job-profiles").doc("u1").get()).data() as Record<string, unknown>
  const profile = got.profile as { industry: string }
  assert.equal(profile.industry, "fintech")
  assert.equal(got.createdAt, "2026-04-30T00:00:00Z")
  assert.equal(got.updatedAt, "2026-05-01T00:00:00Z")
})

test("saveJobProfile: paused status is preserved across saves (operator pause)", async () => {
  const mfs = new MockFirestore()
  // Operator manually flipped to paused via dashboard.
  await mfs.collection("pa-job-profiles").doc("u1").set({
    userId: "u1",
    profile: { industry: "tech", sponsorship: "none", location: "remote", sizePreference: "either" },
    cvParsedAt: "2026-04-30T00:00:00Z",
    lastJobBatchSentAt: null,
    status: "paused",
    createdAt: "2026-04-30T00:00:00Z",
    updatedAt: "2026-04-30T00:00:00Z",
  })
  await saveJobProfile(
    {
      userId: "u1",
      profile: { industry: "fintech", sponsorship: "h1b", location: "NYC", sizePreference: "startup" },
    },
    { db: asFirestore(mfs) }
  )
  const got = (await mfs.collection("pa-job-profiles").doc("u1").get()).data()
  assert.equal(got?.status, "paused")
})

test("saveJobProfile: rejects bad input via Zod (empty userId)", async () => {
  const mfs = new MockFirestore()
  await assert.rejects(
    saveJobProfile(
      {
        userId: "",
        profile: { industry: "tech", sponsorship: "none", location: "x", sizePreference: "either" },
      },
      { db: asFirestore(mfs) }
    )
  )
})

test("saveJobProfile: validates inner profile shape (rejects bad enum)", async () => {
  const mfs = new MockFirestore()
  await assert.rejects(
    saveJobProfile(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { userId: "u1", profile: { industry: "tech", sponsorship: "yolo", location: "x", sizePreference: "either" } as any },
      { db: asFirestore(mfs) }
    )
  )
})
