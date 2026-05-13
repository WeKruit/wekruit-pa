/**
 * v1.7 Phase 70 — paAdminMatchDebug schema + admin-auth tests.
 *
 * The CF itself is a thin shim around `queryMatchingJobsV16` (already
 * covered by apps/job-rec/src/__tests__/tools/query-matching-jobs-v16.test.ts).
 * Here we exercise the input-schema parser + the shared admin-auth gate to
 * confirm Phase 70's contract:
 *  - userId required, min length 8
 *  - weightOverrides each clamped 0..1, all keys optional
 *  - limit clamped 1..50, defaults 10
 *  - admin claim accepted; missing claim + missing token → permission-denied
 *
 * Run via:
 *   node --import tsx --test apps/functions/src/__tests__/admin-match-debug.test.ts
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import { MockFirestore, asFirestore } from "../job-rec/__tests__/mock-firestore.js"
import {
  AdminJobMatchDebugInputSchema,
  AdminMatchDebugInputSchema,
  runAdminJobMatchDebug,
  type JobCandidateDebugMatch,
} from "../admin-match-debug.js"
import { authorizeAdminCallable } from "../promote-sandbox-tag.js"

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe("AdminMatchDebugInputSchema", () => {
  it("accepts a minimal payload — userId only, defaults limit=10", () => {
    const out = AdminMatchDebugInputSchema.safeParse({ userId: "u_abcdef12" })
    assert.equal(out.success, true)
    if (out.success) {
      assert.equal(out.data.userId, "u_abcdef12")
      assert.equal(out.data.limit, 10)
      assert.equal(out.data.weightOverrides, undefined)
    }
  })

  it("rejects userId shorter than 8 chars", () => {
    const out = AdminMatchDebugInputSchema.safeParse({ userId: "short" })
    assert.equal(out.success, false)
  })

  it("accepts partial weight overrides — missing keys allowed", () => {
    const out = AdminMatchDebugInputSchema.safeParse({
      userId: "u_abcdef12",
      weightOverrides: { llmMatch: 0.6, salaryFit: 0.0 },
    })
    assert.equal(out.success, true)
    if (out.success) {
      assert.equal(out.data.weightOverrides?.llmMatch, 0.6)
      assert.equal(out.data.weightOverrides?.salaryFit, 0.0)
      assert.equal(out.data.weightOverrides?.skillJaccard, undefined)
    }
  })

  it("rejects weight override outside 0..1", () => {
    const high = AdminMatchDebugInputSchema.safeParse({
      userId: "u_abcdef12",
      weightOverrides: { llmMatch: 1.5 },
    })
    assert.equal(high.success, false)
    const low = AdminMatchDebugInputSchema.safeParse({
      userId: "u_abcdef12",
      weightOverrides: { llmMatch: -0.1 },
    })
    assert.equal(low.success, false)
  })

  it("clamps limit to 1..50 and accepts defaults", () => {
    assert.equal(
      AdminMatchDebugInputSchema.safeParse({ userId: "u_abcdef12", limit: 0 }).success,
      false,
    )
    assert.equal(
      AdminMatchDebugInputSchema.safeParse({ userId: "u_abcdef12", limit: 51 }).success,
      false,
    )
    const ok = AdminMatchDebugInputSchema.safeParse({ userId: "u_abcdef12", limit: 25 })
    assert.equal(ok.success, true)
    if (ok.success) assert.equal(ok.data.limit, 25)
  })

  it("rejects non-integer limit", () => {
    const out = AdminMatchDebugInputSchema.safeParse({ userId: "u_abcdef12", limit: 5.5 })
    assert.equal(out.success, false)
  })
})

// ---------------------------------------------------------------------------
// Admin gate — paAdminMatchDebug shares the same authorizer as
// paPromoteSandboxTag, so a smoke test on the gate is sufficient.
// ---------------------------------------------------------------------------

describe("paAdminMatchDebug auth gate (via authorizeAdminCallable)", () => {
  it("accepts auth.token.admin === true", () => {
    const got = authorizeAdminCallable({
      auth: { token: { admin: true }, uid: "u-admin" } as never,
      data: { userId: "u_abcdef12" },
    })
    assert.equal(got.uid, "u-admin")
  })

  it("rejects when neither claim nor token", () => {
    const original = process.env.PA_ADMIN_TOKEN
    delete process.env.PA_ADMIN_TOKEN
    try {
      assert.throws(
        () =>
          authorizeAdminCallable({
            auth: { token: {} } as never,
            data: { userId: "u_abcdef12" },
          }),
        /admin only/,
      )
    } finally {
      if (original !== undefined) process.env.PA_ADMIN_TOKEN = original
    }
  })

  it("accepts admin token fallback for scripted callers", () => {
    const original = process.env.PA_ADMIN_TOKEN
    process.env.PA_ADMIN_TOKEN = "secret-tok-70"
    try {
      const got = authorizeAdminCallable({
        auth: { token: {} } as never,
        data: { userId: "u_abcdef12", adminToken: "secret-tok-70" },
      })
      assert.equal(typeof got.uid, "string")
    } finally {
      if (original !== undefined) process.env.PA_ADMIN_TOKEN = original
      else delete process.env.PA_ADMIN_TOKEN
    }
  })
})

describe("AdminJobMatchDebugInputSchema", () => {
  it("accepts jobId and defaults limit", () => {
    const out = AdminJobMatchDebugInputSchema.safeParse({ jobId: "job-123456" })
    assert.equal(out.success, true)
    if (out.success) {
      assert.equal(out.data.jobId, "job-123456")
      assert.equal(out.data.limit, 20)
    }
  })

  it("rejects empty jobId and out-of-range limit", () => {
    assert.equal(AdminJobMatchDebugInputSchema.safeParse({ jobId: "" }).success, false)
    assert.equal(AdminJobMatchDebugInputSchema.safeParse({ jobId: "job-123456", limit: 0 }).success, false)
    assert.equal(AdminJobMatchDebugInputSchema.safeParse({ jobId: "job-123456", limit: 51 }).success, false)
    assert.equal(AdminJobMatchDebugInputSchema.safeParse({ jobId: "job-123456", limit: 1.2 }).success, false)
  })
})

describe("paAdminJobMatchDebug auth gate (via authorizeAdminCallable)", () => {
  it("accepts auth.token.admin === true", () => {
    const got = authorizeAdminCallable({
      auth: { uid: "u-admin", token: { admin: true } } as never,
      data: { jobId: "job-123456" },
    })
    assert.equal(got.uid, "u-admin")
  })

  it("rejects non-admin callers", () => {
    const original = process.env.PA_ADMIN_TOKEN
    delete process.env.PA_ADMIN_TOKEN
    try {
      assert.throws(
        () =>
          authorizeAdminCallable({
            auth: { uid: "u1", token: {} } as never,
            data: { jobId: "job-123456" },
          }),
        /admin only/,
      )
    } finally {
      if (original !== undefined) process.env.PA_ADMIN_TOKEN = original
    }
  })
})

describe("runAdminJobMatchDebug", () => {
  it("throws not-found when matching job is missing", async () => {
    const mfs = new MockFirestore()
    await assert.rejects(
      () =>
        runAdminJobMatchDebug(
          { jobId: "missing-job", limit: 10 },
          {
            db: asFirestore(mfs),
            rankCandidatesForJob: async () => [],
          },
        ),
      (err) => err instanceof Error && "code" in err && err.code === "not-found",
    )
  })

  it("returns ranked retained/profile-ready candidates with debug projection", async () => {
    const mfs = new MockFirestore()
    await mfs.collection("matching-jobs").doc("job-1").set({
      title: "Frontend Engineer",
      companyName: "Acme",
      globalTags: { skills: ["react"], industrySector: ["software_and_saas"] },
    })
    await mfs.collection("pa-users").doc("cand-ready").set({
      candidateLifecycleState: "profile_ready",
      globalTags: { skills: ["react"], industrySector: ["software_and_saas"] },
    })
    await mfs.collection("pa-users").doc("cand-retained").set({
      candidateLifecycleState: "retained",
      tags: { skills: ["typescript"], industrySector: ["software_and_saas"] },
    })
    await mfs.collection("pa-users").doc("cand-prospect").set({
      candidateLifecycleState: "prospect",
      globalTags: { skills: ["react"] },
    })

    const seenCandidates: string[] = []
    const result = await runAdminJobMatchDebug(
      { jobId: "job-1", limit: 1 },
      {
        db: asFirestore(mfs),
        rankCandidatesForJob: async ({ candidates }): Promise<JobCandidateDebugMatch[]> => {
          seenCandidates.push(...candidates.map((candidate) => candidate.userId))
          return [
            {
              candidateId: "cand-ready",
              finalScore: 0.91,
              scoreBreakdown: {
                skills: { score: 0.95, weight: 0.5, summary: "React match" },
              },
              hardFilterResult: "pass",
              reasons: ["React-heavy profile matches job"],
              risks: ["Needs salary confirmation"],
              missingInfo: ["target compensation"],
              recommendedAction: "auto_outbound",
            },
            {
              candidateId: "cand-retained",
              finalScore: 0.42,
              scoreBreakdown: {
                skills: { score: 0.4, weight: 0.5 },
              },
              hardFilterResult: "soft_block",
              reasons: ["Some TypeScript overlap"],
              risks: [],
              missingInfo: [],
              recommendedAction: "hitl_review",
            },
          ]
        },
      },
    )

    assert.deepEqual(seenCandidates.sort(), ["cand-ready", "cand-retained"])
    assert.equal(result.jobId, "job-1")
    assert.equal(result.candidatePool.totalLoaded, 2)
    assert.equal(result.candidates.length, 1)
    assert.equal(result.candidates[0]?.candidateId, "cand-ready")
    assert.equal(result.candidates[0]?.finalScore, 0.91)
    assert.equal(result.candidates[0]?.hardFilterResult, "pass")
    assert.deepEqual(result.candidates[0]?.candidateTagSnapshot, {
      skills: ["react"],
      industrySector: ["software_and_saas"],
    })
    assert.deepEqual(result.candidates[0]?.reasons, ["React-heavy profile matches job"])
    assert.deepEqual(result.candidates[0]?.risks, ["Needs salary confirmation"])
    assert.deepEqual(result.candidates[0]?.missingInfo, ["target compensation"])
    assert.equal(result.candidates[0]?.recommendedAction, "auto_outbound")
    assert.equal(mfs.writeLog.some((write) => write.path === "pa-outbound"), false)
  })
})

describe("S5 admin match debug import safety", () => {
  it("does not import sender or legacy notify paths", () => {
    const source = readFileSync(new URL("../admin-match-debug.ts", import.meta.url), "utf8")
    assert.doesNotMatch(source, /paReverseMatch|sendImessage|enqueueReverseMatchNotify|bulkNotify|pa-outbound/)
  })
})
