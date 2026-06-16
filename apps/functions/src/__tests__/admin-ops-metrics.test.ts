import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { MockFirestore, asFirestore } from "../job-rec/__tests__/mock-firestore.js"
import {
  AdminOpsMetricsInputSchema,
  runAdminOpsMetrics,
  utcDayKey,
  toMs,
} from "../admin-ops-metrics.js"

const NOW = Date.parse("2026-06-16T12:00:00.000Z")
const TODAY_TS = "2026-06-16T08:00:00.000Z"
const TODAY_KEY = "2026-06-16"
const TEN_DAYS_AGO = "2026-06-06T08:00:00.000Z"
const OUT_OF_WINDOW = "2025-11-01T00:00:00.000Z"

function seedUser(
  mfs: MockFirestore,
  id: string,
  data: Record<string, unknown>,
): Promise<void> {
  return mfs.collection("pa-users").doc(id).set({ id, ...data })
}

describe("AdminOpsMetricsInputSchema", () => {
  it("applies defaults", () => {
    const out = AdminOpsMetricsInputSchema.safeParse({})
    assert.equal(out.success, true)
    if (out.success) {
      assert.equal(out.data.rangeDays, 120)
      assert.equal(out.data.includeTest, false)
    }
  })

  it("rejects rangeDays out of bounds", () => {
    assert.equal(AdminOpsMetricsInputSchema.safeParse({ rangeDays: 3 }).success, false)
    assert.equal(AdminOpsMetricsInputSchema.safeParse({ rangeDays: 9999 }).success, false)
  })
})

describe("toMs / utcDayKey", () => {
  it("coerces ISO, epoch ms, and Firestore Timestamp", () => {
    assert.equal(toMs("2026-06-16T08:00:00.000Z"), Date.parse("2026-06-16T08:00:00.000Z"))
    assert.equal(toMs(1_700_000_000_000), 1_700_000_000_000)
    assert.equal(toMs({ toDate: () => new Date("2026-06-16T08:00:00.000Z") }), Date.parse("2026-06-16T08:00:00.000Z"))
    assert.equal(toMs({ seconds: 1_700_000_000 }), 1_700_000_000_000)
    assert.equal(toMs(undefined), 0)
  })

  it("buckets to the UTC day", () => {
    assert.equal(utcDayKey(NOW), "2026-06-16")
  })
})

describe("runAdminOpsMetrics — new users", () => {
  it("attributes channels, dedups by person, excludes test + out-of-window", async () => {
    const mfs = new MockFirestore()
    // recruiter-submitted person
    await seedUser(mfs, "user-alpha", { createdAt: TODAY_TS, recruiterSubmissionTracking: { lastStatus: "submitted" } })
    // authenticated person (auth mapping exists)
    await seedUser(mfs, "user-bravo", { createdAt: TODAY_TS })
    // direct person
    await seedUser(mfs, "user-charlie", { createdAt: TODAY_TS })
    // both recruiter + auth -> must count once, as recruiter (priority)
    await seedUser(mfs, "user-delta", { createdAt: TODAY_TS, recruiterSubmissionTracking: { lastStatus: "submitted" } })
    // excluded: synthetic source
    await seedUser(mfs, "user-echo", { createdAt: TODAY_TS, source: "e2e_run" })
    // excluded: synthetic id pattern ("smoke")
    await seedUser(mfs, "smoke-user", { createdAt: TODAY_TS })
    // excluded: out of window
    await seedUser(mfs, "user-foxtrot", { createdAt: OUT_OF_WINDOW })

    await mfs.collection("pa-candidate-auth").doc("auth-1").set({ candidateId: "user-bravo", createdAt: TODAY_TS })
    await mfs.collection("pa-candidate-auth").doc("auth-2").set({ candidateId: "user-delta", createdAt: TODAY_TS })

    const result = await runAdminOpsMetrics({ rangeDays: 120, includeTest: false }, { db: asFirestore(mfs), now: () => NOW })

    assert.equal(result.totals.newUsersRecruiterSubmitted, 2) // alpha, delta
    assert.equal(result.totals.newUsersAuthenticated, 1) // bravo (delta not double-counted)
    assert.equal(result.totals.newUsersDirect, 1) // charlie
    assert.equal(result.totals.newUsersTotal, 4)

    const today = result.days.find((d) => d.date === TODAY_KEY)
    assert.ok(today)
    assert.equal(today.newUsersTotal, 4)
    assert.equal(today.newUsersRecruiterSubmitted, 2)
  })

  it("includes test accounts when includeTest=true", async () => {
    const mfs = new MockFirestore()
    await seedUser(mfs, "user-alpha", { createdAt: TODAY_TS })
    await seedUser(mfs, "user-echo", { createdAt: TODAY_TS, source: "e2e_run" })

    const result = await runAdminOpsMetrics({ rangeDays: 120, includeTest: true }, { db: asFirestore(mfs), now: () => NOW })
    assert.equal(result.totals.newUsersTotal, 2)
  })
})

describe("runAdminOpsMetrics — interviews", () => {
  it("counts conducted + moved-to-client, deduped across recruiter/prescreen/marketplace", async () => {
    const mfs = new MockFirestore()

    // recruiter submission: cand1 entered WeKruit interview + With client today
    await mfs.collection("pa-recruiter-submissions").doc("sub-1").set({
      candidateId: "cand1",
      updatedAt: TODAY_TS,
      statusHistory: [
        { status: "submitted", atIso: TEN_DAYS_AGO },
        { status: "wekruit_interview", atIso: TODAY_TS },
        { status: "client_review", atIso: TODAY_TS },
      ],
    })
    // second submission, same candidate, client_review again -> dedup
    await mfs.collection("pa-recruiter-submissions").doc("sub-2").set({
      candidateId: "cand1",
      updatedAt: TODAY_TS,
      statusHistory: [{ status: "client_review", atIso: TODAY_TS }],
    })

    // prescreen session: cand2 ran (terminal) -> conducted
    await mfs.collection("pa-prescreen-sessions").doc("ps-1").set({
      userId: "cand2",
      createdAt: TODAY_TS,
      terminal: "PASS",
    })
    // prescreen session: cand1 started -> conducted, dedup with recruiter
    await mfs.collection("pa-prescreen-sessions").doc("ps-2").set({
      userId: "cand1",
      createdAt: TODAY_TS,
      terminal: null,
      workSession: { startedAt: TODAY_TS },
    })
    // prescreen session: never ran -> ignored
    await mfs.collection("pa-prescreen-sessions").doc("ps-3").set({
      userId: "cand9",
      createdAt: TODAY_TS,
      terminal: null,
    })

    // marketplace state: cand3 employer_visible today -> moved to client
    await mfs.collection("pa-candidate-job-states").doc("st-1").set({
      candidateId: "cand3",
      jobId: "job-1",
      state: "employer_visible",
      stateUpdatedAt: TODAY_TS,
    })

    const result = await runAdminOpsMetrics({ rangeDays: 30, includeTest: false }, { db: asFirestore(mfs), now: () => NOW })

    const today = result.days.find((d) => d.date === TODAY_KEY)
    assert.ok(today)
    // conducted distinct: cand1, cand2
    assert.equal(today.interviewsConducted, 2)
    // client distinct: cand1 (recruiter), cand3 (marketplace)
    assert.equal(today.movedToClient, 2)
    assert.equal(result.totals.interviewsConducted, 2)
    assert.equal(result.totals.movedToClient, 2)
  })

  it("excludes test-mode prescreen + recruiter events", async () => {
    const mfs = new MockFirestore()
    await mfs.collection("pa-prescreen-sessions").doc("ps-1").set({
      userId: "cand2",
      createdAt: TODAY_TS,
      terminal: "PASS",
      testMode: true,
    })
    const result = await runAdminOpsMetrics({ rangeDays: 30, includeTest: false }, { db: asFirestore(mfs), now: () => NOW })
    assert.equal(result.totals.interviewsConducted, 0)
  })
})

describe("runAdminOpsMetrics — series shape", () => {
  it("emits a continuous zero-filled daily series sized to the range", async () => {
    const mfs = new MockFirestore()
    await seedUser(mfs, "user-alpha", { createdAt: TODAY_TS })
    const result = await runAdminOpsMetrics({ rangeDays: 30, includeTest: false }, { db: asFirestore(mfs), now: () => NOW })
    assert.equal(result.days.length, 30)
    assert.equal(result.days[result.days.length - 1]!.date, TODAY_KEY)
    // every day present and ascending
    for (let i = 1; i < result.days.length; i += 1) {
      assert.ok(result.days[i]!.date > result.days[i - 1]!.date)
    }
  })
})
