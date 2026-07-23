/**
 * audience-provision.test.ts — cadence-audience widener (2026-06-11).
 *
 * Contract under test:
 *   - eligibility: tags.targetRoleFunction non-empty + phoneE164 +
 *     doNotContact !== true + no open prescreen work session
 *   - idempotent: existing pa-job-profiles rows NEVER touched (esp. paused)
 *   - ramp: ≤ maxNewProfiles new rows per run, deterministic userId order
 *   - provisioned row shape: status active, source marker, minimal legacy
 *     "no preference" profile that normalizeJobProfile accepts
 */
import test from "node:test"
import assert from "node:assert/strict"
import { MockFirestore, asFirestore } from "./mock-firestore.js"
import {
  provisionCadenceAudience,
  AUDIENCE_PROVISION_SOURCE,
  DEFAULT_PROVISION_CAP_PER_RUN,
} from "../audience-provision.js"
import { normalizeJobProfile } from "../daily-batch.js"

const NOW_MS = Date.parse("2026-06-11T16:00:00.000Z")

function eligibleUser(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    phoneE164: "+15551230000",
    tags: { targetRoleFunction: ["software_engineering"] },
    ...over,
  }
}

test("provision: eligible user missing a profile gets an ACTIVE row with source marker", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("pa-users").doc("u1").set(eligibleUser())

  const out = await provisionCadenceAudience({ db: asFirestore(mfs), nowMs: NOW_MS })
  assert.equal(out.eligible, 1)
  assert.equal(out.provisioned, 1)
  assert.equal(out.alreadyProvisioned, 0)

  const row = (await mfs.collection("pa-job-profiles").doc("u1").get()).data()
  assert.ok(row)
  assert.equal(row!.status, "active")
  assert.equal(row!.userId, "u1")
  assert.equal(row!.source, AUDIENCE_PROVISION_SOURCE)
  assert.equal(row!.lastJobBatchSentAt, null)
  assert.ok(row!.createdAt)
  // The minimal profile must be consumable by the batch's normalizer (a
  // corrupt-profile row would just burn the skip path every run).
  assert.ok(normalizeJobProfile(row!.profile), "provisioned profile must normalize")
})

test("provision: ineligible users are not provisioned (no role / no phone / DNC / open prescreen)", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("pa-users").doc("no-role").set(eligibleUser({ tags: { targetRoleFunction: [] } }))
  await mfs.collection("pa-users").doc("no-phone").set(eligibleUser({ phoneE164: "" }))
  await mfs.collection("pa-users").doc("dnc").set(eligibleUser({ doNotContact: true }))
  await mfs.collection("pa-users").doc("screening").set(
    eligibleUser({
      workSession: {
        kind: "job_prescreen",
        status: "active",
        startedAt: new Date(NOW_MS - 60_000).toISOString(),
      },
    })
  )

  const out = await provisionCadenceAudience({ db: asFirestore(mfs), nowMs: NOW_MS })
  assert.equal(out.eligible, 0)
  assert.equal(out.provisioned, 0)
  assert.equal(out.skippedDoNotContact, 1)
  assert.equal(out.skippedOpenPrescreen, 1)
  assert.equal((await mfs.collection("pa-job-profiles").limit(0).get()).size, 0)
})

test("provision: yc_startup_school users are NEVER auto-provisioned (founder-match promise, not a rec cadence)", async () => {
  const mfs = new MockFirestore()
  // Fully rec-eligible otherwise (role tags from a LinkedIn enrich, phone bound).
  await mfs.collection("pa-users").doc("yc1").set(eligibleUser({ source: "yc_startup_school" }))

  const out = await provisionCadenceAudience({ db: asFirestore(mfs), nowMs: NOW_MS })
  assert.equal(out.eligible, 0)
  assert.equal(out.provisioned, 0)
  assert.equal((await mfs.collection("pa-job-profiles").limit(0).get()).size, 0)
})

test("provision: STALE (>48h) prescreen work session does not block provisioning", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("pa-users").doc("stale-screen").set(
    eligibleUser({
      workSession: {
        kind: "job_prescreen",
        status: "active",
        startedAt: new Date(NOW_MS - 72 * 60 * 60 * 1000).toISOString(),
      },
    })
  )
  const out = await provisionCadenceAudience({ db: asFirestore(mfs), nowMs: NOW_MS })
  assert.equal(out.provisioned, 1)
})

test("provision: IDEMPOTENT — existing rows untouched, paused row is NOT flipped to active", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("pa-users").doc("paused-user").set(eligibleUser())
  await mfs.collection("pa-users").doc("active-user").set(eligibleUser({ phoneE164: "+15551230001" }))
  const pausedRow = {
    userId: "paused-user",
    profile: { industry: "tech", sponsorship: "none", location: "remote", sizePreference: "either" },
    cvParsedAt: "2026-05-01T00:00:00Z",
    lastJobBatchSentAt: "2026-06-01T00:00:00Z",
    status: "paused",
    createdAt: "2026-05-01T00:00:00Z",
    updatedAt: "2026-05-01T00:00:00Z",
  }
  await mfs.collection("pa-job-profiles").doc("paused-user").set(pausedRow)
  const activeRow = { ...pausedRow, userId: "active-user", status: "active" }
  await mfs.collection("pa-job-profiles").doc("active-user").set(activeRow)

  const writesBefore = mfs.writeLog.length
  const out = await provisionCadenceAudience({ db: asFirestore(mfs), nowMs: NOW_MS })
  assert.equal(out.eligible, 2)
  assert.equal(out.alreadyProvisioned, 2)
  assert.equal(out.provisioned, 0)
  // Byte-identical rows + zero new writes against pa-job-profiles.
  assert.deepEqual((await mfs.collection("pa-job-profiles").doc("paused-user").get()).data(), pausedRow)
  assert.deepEqual((await mfs.collection("pa-job-profiles").doc("active-user").get()).data(), activeRow)
  const profileWrites = mfs.writeLog.slice(writesBefore).filter((w) => w.path === "pa-job-profiles")
  assert.equal(profileWrites.length, 0)
})

test("provision: re-run is a no-op (second run provisions nothing)", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("pa-users").doc("u1").set(eligibleUser())
  const first = await provisionCadenceAudience({ db: asFirestore(mfs), nowMs: NOW_MS })
  assert.equal(first.provisioned, 1)
  const second = await provisionCadenceAudience({ db: asFirestore(mfs), nowMs: NOW_MS })
  assert.equal(second.provisioned, 0)
  assert.equal(second.alreadyProvisioned, 1)
})

test("provision: RAMP — caps new rows per run in deterministic userId order", async () => {
  const mfs = new MockFirestore()
  for (let i = 0; i < 10; i++) {
    await mfs
      .collection("pa-users")
      .doc(`user-${String(i).padStart(2, "0")}`)
      .set(eligibleUser({ phoneE164: `+1555000${String(i).padStart(4, "0")}` }))
  }
  const out = await provisionCadenceAudience({
    db: asFirestore(mfs),
    nowMs: NOW_MS,
    maxNewProfiles: 4,
  })
  assert.equal(out.eligible, 10)
  assert.equal(out.provisioned, 4)
  assert.equal(out.cappedOut, 6)
  // Deterministic: lexicographically-first userIds provisioned first.
  for (const id of ["user-00", "user-01", "user-02", "user-03"]) {
    assert.ok((await mfs.collection("pa-job-profiles").doc(id).get()).exists, `${id} provisioned`)
  }
  assert.equal((await mfs.collection("pa-job-profiles").doc("user-04").get()).exists, false)
})

test("provision: default ramp cap is 60", () => {
  assert.equal(DEFAULT_PROVISION_CAP_PER_RUN, 60)
})
