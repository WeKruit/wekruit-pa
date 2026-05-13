/**
 * Wave C Block D2 — `runEvaluation` callable tests.
 *
 * Drives the handler against the same in-memory Firestore fake style as
 * C's `resolve-identity.test.ts` + B's `import.test.ts`.
 *
 * Covers:
 *  - Auth gate (unauthenticated, non-wekruit, admin pass).
 *  - Happy path: 3 in-scope records → 3 evaluations + tier breakdown.
 *  - Skipped: record with missing `resolvedUserId` → no evaluation.
 *  - Out-of-scope record (needs_review) → skipped.
 *  - Hard-block tier mapping (visa mismatch → `blocked`).
 *  - Tier 1 with competitor adjacency boost.
 *  - Idempotency: same `runId` overwrites cleanly.
 *  - Missing pa-companies doc gracefully falls back.
 *  - Missing pa-jobs doc gracefully falls back.
 *  - Explicit `recordIds[]` overrides batchId scope.
 */

import assert from "node:assert/strict"
import test from "node:test"
import { HttpsError } from "firebase-functions/v2/https"
import type { Firestore } from "firebase-admin/firestore"
import {
  PA_COLLECTIONS,
  createExternalEvaluationId,
  type CandidateProfile,
  type ExternalCandidateRecord,
} from "@pa/core-types"
import { runEvaluation } from "./evaluate.js"

// ---------------------------------------------------------------------------
// In-memory Firestore fake (matches resolve-identity.test.ts style)
// ---------------------------------------------------------------------------

type Store = Map<string, Map<string, Record<string, unknown>>>

const NOW = "2026-05-13T12:00:00.000Z"

const ADMIN_AUTH = {
  uid: "operator-1",
  token: { email: "admin@wekruit.com", email_verified: true },
}

function ensureCol(store: Store, name: string): Map<string, Record<string, unknown>> {
  if (!store.has(name)) store.set(name, new Map())
  return store.get(name)!
}

function makeStore(): Store {
  const map: Store = new Map()
  for (const name of Object.values(PA_COLLECTIONS)) {
    map.set(name, new Map())
  }
  // Job/Company collections are NOT in PA_COLLECTIONS — seed eagerly so
  // the fake handles them naturally.
  map.set("pa-jobs", new Map())
  map.set("pa-companies", new Map())
  return map
}

function makeFakeFirestore(store: Store = makeStore()): { db: Firestore; store: Store } {
  function docRef(collectionName: string, id: string) {
    return {
      id,
      async get() {
        const data = ensureCol(store, collectionName).get(id)
        return { exists: data !== undefined, id, data: () => data }
      },
      async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
        const col = ensureCol(store, collectionName)
        const current = col.get(id)
        col.set(id, opts?.merge && current ? { ...current, ...data } : { ...data })
      },
    }
  }

  function collection(collectionName: string) {
    return {
      doc(id: string) {
        return docRef(collectionName, id)
      },
      where(field: string, _op: string, value: unknown) {
        const entries = Array.from(ensureCol(store, collectionName).entries()).filter(
          ([, data]) => data[field] === value,
        )
        return {
          async get() {
            return {
              empty: entries.length === 0,
              docs: entries.map(([id, data]) => ({ id, data: () => data })),
            }
          },
        }
      },
    }
  }

  const db = { collection } as unknown as Firestore
  return { db, store }
}

// ---------------------------------------------------------------------------
// Fixture seeders
// ---------------------------------------------------------------------------

function seedJob(store: Store, jobId: string, over: Record<string, unknown> = {}) {
  ensureCol(store, "pa-jobs").set(jobId, {
    title: "Senior Software Engineer",
    roleFunction: ["software_engineering"],
    requiredSkills: ["typescript", "react", "node_js", "postgresql"],
    seniorityLevel: "senior",
    locationBuckets: ["san_francisco_bay_area"],
    sponsorship: true,
    jobType: "full_time",
    industrySector: ["financial_technology"],
    firstSeenAt: NOW,
    salaryMin: 180000,
    salaryMax: 250000,
    ...over,
  })
}

function seedCompany(store: Store, companyId: string, over: Record<string, unknown> = {}) {
  ensureCol(store, "pa-companies").set(companyId, {
    name: "Acme Fintech",
    industrySector: ["financial_technology"],
    size: "scale_up",
    competitorCompanies: ["Stripe", "Plaid"],
    schoolPreferences: ["Harvard"],
    ...over,
  })
}

function seedProfile(store: Store, candidateId: string, over: Partial<CandidateProfile> = {}) {
  const profile: Record<string, unknown> = {
    candidateLifecycleState: "profile_ready",
    createdAt: NOW,
    latestResumeArtifactId: "resume-1",
    linkedinUrl: "https://linkedin.com/in/test",
    globalTags: {
      roleFunction: ["software_engineering"],
      skills: [
        { name: "typescript", bucket: "language_or_runtime", proficiency: "expert", evidenceCount: 5, baseWeight: 0.9 },
        { name: "react", bucket: "framework_or_library", proficiency: "expert", evidenceCount: 4, baseWeight: 0.9 },
        { name: "node_js", bucket: "language_or_runtime", proficiency: "expert", evidenceCount: 3, baseWeight: 0.8 },
        { name: "postgresql", bucket: "infrastructure_tool", proficiency: "intermediate", evidenceCount: 2, baseWeight: 0.7 },
        { name: "graphql", bucket: "domain_concept", proficiency: "intermediate", evidenceCount: 2, baseWeight: 0.7 },
      ],
      careerStage: "senior",
      yoeRange: [6, 10],
      industrySector: ["financial_technology"],
      targetLocations: ["san_francisco_bay_area"],
      visaStatus: "citizen",
      targetJobType: ["full_time"],
      relevantTags: [],
      minSalaryUsd: 180000,
      maxSalaryUsd: 250000,
      companySizePreference: ["scale_up"],
    },
    ...over,
  }
  ensureCol(store, PA_COLLECTIONS.users).set(candidateId, profile)
}

function seedRecord(
  store: Store,
  args: Partial<ExternalCandidateRecord> & { recordId: string; batchId: string },
) {
  const base: ExternalCandidateRecord = {
    source: "juicebox",
    rawPayload: {},
    canonicalLinkedInUrl: "https://linkedin.com/in/test",
    linkedinProfileHash: "h".repeat(64),
    emails: [],
    name: "Candidate",
    currentCompany: "Stripe",
    experience: [{ company: "Stripe", title: "Senior Engineer" }],
    education: [{ school: "Harvard" }],
    sourceTags: [],
    normalizationStatus: "ok",
    identityResolutionStatus: "merge_existing",
    evidence: [],
    createdAt: NOW,
    ...args,
  }
  ensureCol(store, PA_COLLECTIONS.externalCandidateRecords).set(args.recordId, base)
}

// ---------------------------------------------------------------------------
// Auth-gate tests
// ---------------------------------------------------------------------------

test("runEvaluation — rejects unauthenticated callers", async () => {
  const { db } = makeFakeFirestore()
  await assert.rejects(
    () =>
      runEvaluation(
        { batchId: "b-1", companyId: "co-1", jobId: "job-1" },
        undefined,
        { db, now: () => NOW },
      ),
    (err) => err instanceof HttpsError && err.code === "unauthenticated",
  )
})

test("runEvaluation — rejects non-wekruit email", async () => {
  const { db } = makeFakeFirestore()
  await assert.rejects(
    () =>
      runEvaluation(
        { batchId: "b-1", companyId: "co-1", jobId: "job-1" },
        { uid: "x", token: { email: "outsider@gmail.com", email_verified: true } },
        { db, now: () => NOW },
      ),
    (err) => err instanceof HttpsError && err.code === "permission-denied",
  )
})

test("runEvaluation — admin claim short-circuits domain check", async () => {
  const { db, store } = makeFakeFirestore()
  const batchId = "batch-admin"
  seedJob(store, "job-1")
  seedCompany(store, "co-1")
  // No records to process — just verify auth path.
  const result = await runEvaluation(
    { batchId, companyId: "co-1", jobId: "job-1", runId: "run-admin" },
    { uid: "svc-1", token: { admin: true } },
    { db, now: () => NOW },
  )
  assert.equal(result.ok, true)
  assert.equal(result.processed, 0)
})

test("runEvaluation — invalid argument when neither batchId nor recordIds", async () => {
  const { db } = makeFakeFirestore()
  await assert.rejects(
    () =>
      runEvaluation(
        { companyId: "co-1", jobId: "job-1" },
        ADMIN_AUTH,
        { db, now: () => NOW },
      ),
    (err) => err instanceof HttpsError && err.code === "invalid-argument",
  )
})

test("runEvaluation — invalid argument when companyId missing", async () => {
  const { db } = makeFakeFirestore()
  await assert.rejects(
    () =>
      runEvaluation(
        { batchId: "b-1", jobId: "job-1" },
        ADMIN_AUTH,
        { db, now: () => NOW },
      ),
    (err) => err instanceof HttpsError && err.code === "invalid-argument",
  )
})

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test("runEvaluation — happy path: 3 records → 3 evaluations + run doc updated", async () => {
  const { db, store } = makeFakeFirestore()
  const batchId = "batch-happy"
  const jobId = "job-1"
  const companyId = "co-1"
  const runId = "run-happy"
  seedJob(store, jobId)
  seedCompany(store, companyId)
  for (const i of [1, 2, 3]) {
    const candId = `cand-${i}`
    seedProfile(store, candId)
    seedRecord(store, {
      recordId: `r${i}`,
      batchId,
      resolvedUserId: candId,
      identityResolutionStatus: i === 1 ? "create_new" : "merge_existing",
    })
  }

  const result = await runEvaluation(
    { batchId, companyId, jobId, runId },
    ADMIN_AUTH,
    { db, now: () => NOW },
  )

  assert.equal(result.ok, true)
  assert.equal(result.runId, runId)
  assert.equal(result.processed, 3)
  assert.equal(result.completed, 3)
  assert.equal(result.skipped, 0)
  // All 3 land in the same tier — strong-fit profiles.
  assert.equal(result.tierBreakdown.tier_1_personal_linkedin_and_email, 3)
  assert.equal(result.tierBreakdown.tier_2_personal_email, 0)
  assert.equal(result.tierBreakdown.blocked, 0)

  // Each evaluation persisted with deterministic doc id.
  for (const i of [1, 2, 3]) {
    const evalId = createExternalEvaluationId(`cand-${i}`, jobId, runId)
    const evalDoc = ensureCol(store, PA_COLLECTIONS.candidateCompanyJobEvaluations).get(evalId)
    assert.ok(evalDoc, `evaluation doc ${evalId} should be written`)
    assert.equal(evalDoc!.candidateId, `cand-${i}`)
    assert.equal(evalDoc!.evaluationRunId, runId)
    assert.equal(evalDoc!.proposedTier, "tier_1_personal_linkedin_and_email")
  }

  // Run doc reflects status.
  const runDoc = ensureCol(store, PA_COLLECTIONS.candidateEvaluationRuns).get(runId)
  assert.ok(runDoc)
  assert.equal(runDoc!.status, "completed")
  assert.equal(runDoc!.candidateCount, 3)
  assert.equal(runDoc!.completedCount, 3)
  assert.equal(runDoc!.triggeredBy, "operator-1")
})

// ---------------------------------------------------------------------------
// Skip cases
// ---------------------------------------------------------------------------

test("runEvaluation — record without resolvedUserId is skipped", async () => {
  const { db, store } = makeFakeFirestore()
  const batchId = "batch-skip"
  const runId = "run-skip"
  seedJob(store, "job-1")
  seedCompany(store, "co-1")
  seedRecord(store, {
    recordId: "r1",
    batchId,
    identityResolutionStatus: "create_new",
    // No resolvedUserId.
  })

  const result = await runEvaluation(
    { batchId, companyId: "co-1", jobId: "job-1", runId },
    ADMIN_AUTH,
    { db, now: () => NOW },
  )

  assert.equal(result.processed, 1)
  assert.equal(result.completed, 0)
  assert.equal(result.skipped, 1)
  assert.equal(
    ensureCol(store, PA_COLLECTIONS.candidateCompanyJobEvaluations).size,
    0,
  )
})

test("runEvaluation — needs_review records are excluded from scope", async () => {
  const { db, store } = makeFakeFirestore()
  const batchId = "batch-out-of-scope"
  const runId = "run-oos"
  seedJob(store, "job-1")
  seedCompany(store, "co-1")
  // Profile in store but the record status is needs_review.
  seedProfile(store, "cand-1")
  seedRecord(store, {
    recordId: "r1",
    batchId,
    resolvedUserId: "cand-1",
    identityResolutionStatus: "needs_review",
  })

  const result = await runEvaluation(
    { batchId, companyId: "co-1", jobId: "job-1", runId },
    ADMIN_AUTH,
    { db, now: () => NOW },
  )

  assert.equal(result.processed, 0)
  assert.equal(result.completed, 0)
})

test("runEvaluation — missing pa-users profile is skipped", async () => {
  const { db, store } = makeFakeFirestore()
  const batchId = "batch-no-prof"
  const runId = "run-noprof"
  seedJob(store, "job-1")
  seedCompany(store, "co-1")
  // resolvedUserId points to nothing.
  seedRecord(store, {
    recordId: "r1",
    batchId,
    resolvedUserId: "cand-missing",
    identityResolutionStatus: "merge_existing",
  })

  const result = await runEvaluation(
    { batchId, companyId: "co-1", jobId: "job-1", runId },
    ADMIN_AUTH,
    { db, now: () => NOW },
  )

  assert.equal(result.skipped, 1)
  assert.equal(result.completed, 0)
})

// ---------------------------------------------------------------------------
// Hard-block tier mapping
// ---------------------------------------------------------------------------

test("runEvaluation — visa mismatch → hard_block → blocked tier", async () => {
  const { db, store } = makeFakeFirestore()
  const batchId = "batch-visa"
  const runId = "run-visa"
  const candId = "cand-visa"
  seedJob(store, "job-1", { sponsorship: false })
  seedCompany(store, "co-1")
  seedProfile(store, candId)
  // Mutate the profile we just seeded so visa is sponsor_needed.
  const profDoc = ensureCol(store, PA_COLLECTIONS.users).get(candId)! as Record<
    string,
    unknown
  >
  const globalTags = profDoc.globalTags as Record<string, unknown>
  globalTags.visaStatus = "sponsor_needed"
  ensureCol(store, PA_COLLECTIONS.users).set(candId, profDoc)
  seedRecord(store, {
    recordId: "r1",
    batchId,
    resolvedUserId: candId,
    identityResolutionStatus: "merge_existing",
  })

  const result = await runEvaluation(
    { batchId, companyId: "co-1", jobId: "job-1", runId },
    ADMIN_AUTH,
    { db, now: () => NOW },
  )

  assert.equal(result.tierBreakdown.blocked, 1)
  assert.equal(result.tierBreakdown.tier_1_personal_linkedin_and_email, 0)

  const evalId = createExternalEvaluationId(candId, "job-1", runId)
  const evalDoc = ensureCol(store, PA_COLLECTIONS.candidateCompanyJobEvaluations).get(evalId)!
  assert.equal(evalDoc.hardGateResult, "hard_block")
  assert.equal(evalDoc.proposedTier, "blocked")
  const reasons = evalDoc.hardGateReasons as string[]
  assert.ok(reasons.includes("visa_blocks_sponsorship"))
})

// ---------------------------------------------------------------------------
// Tier 1 competitor adjacency boost
// ---------------------------------------------------------------------------

test("runEvaluation — competitor adjacency lands tier 1", async () => {
  const { db, store } = makeFakeFirestore()
  const batchId = "batch-comp"
  const runId = "run-comp"
  const candId = "cand-comp"
  seedJob(store, "job-1")
  seedCompany(store, "co-1") // competitorCompanies includes Stripe
  seedProfile(store, candId)
  seedRecord(store, {
    recordId: "r1",
    batchId,
    resolvedUserId: candId,
    identityResolutionStatus: "merge_existing",
    currentCompany: "Stripe",
    experience: [{ company: "Stripe", title: "Senior Engineer" }],
  })

  const result = await runEvaluation(
    { batchId, companyId: "co-1", jobId: "job-1", runId },
    ADMIN_AUTH,
    { db, now: () => NOW },
  )

  assert.equal(result.tierBreakdown.tier_1_personal_linkedin_and_email, 1)
  const evalId = createExternalEvaluationId(candId, "job-1", runId)
  const evalDoc = ensureCol(store, PA_COLLECTIONS.candidateCompanyJobEvaluations).get(evalId)!
  const competitor = evalDoc.competitorAdjacency as { matched: boolean }
  assert.equal(competitor?.matched, true)
})

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test("runEvaluation — same runId overwrites evaluation doc cleanly", async () => {
  const { db, store } = makeFakeFirestore()
  const batchId = "batch-idem"
  const runId = "run-idem"
  const candId = "cand-idem"
  seedJob(store, "job-1")
  seedCompany(store, "co-1")
  seedProfile(store, candId)
  seedRecord(store, {
    recordId: "r1",
    batchId,
    resolvedUserId: candId,
    identityResolutionStatus: "merge_existing",
  })

  const r1 = await runEvaluation(
    { batchId, companyId: "co-1", jobId: "job-1", runId },
    ADMIN_AUTH,
    { db, now: () => NOW },
  )
  assert.equal(r1.completed, 1)
  assert.equal(
    ensureCol(store, PA_COLLECTIONS.candidateCompanyJobEvaluations).size,
    1,
  )

  // Second invocation — same runId — should overwrite, not duplicate.
  const r2 = await runEvaluation(
    { batchId, companyId: "co-1", jobId: "job-1", runId },
    ADMIN_AUTH,
    { db, now: () => NOW },
  )
  assert.equal(r2.completed, 1)
  // Still exactly one evaluation doc.
  assert.equal(
    ensureCol(store, PA_COLLECTIONS.candidateCompanyJobEvaluations).size,
    1,
  )
})

// ---------------------------------------------------------------------------
// Missing company / job docs
// ---------------------------------------------------------------------------

test("runEvaluation — missing pa-companies still produces evaluations", async () => {
  const { db, store } = makeFakeFirestore()
  const batchId = "batch-no-co"
  const runId = "run-noco"
  const candId = "cand-noco"
  seedJob(store, "job-1")
  // NO seedCompany — should fall back to stub.
  seedProfile(store, candId)
  seedRecord(store, {
    recordId: "r1",
    batchId,
    resolvedUserId: candId,
    identityResolutionStatus: "merge_existing",
  })

  const result = await runEvaluation(
    { batchId, companyId: "co-missing", jobId: "job-1", runId },
    ADMIN_AUTH,
    { db, now: () => NOW },
  )

  assert.equal(result.completed, 1)
  const evalId = createExternalEvaluationId(candId, "job-1", runId)
  const evalDoc = ensureCol(store, PA_COLLECTIONS.candidateCompanyJobEvaluations).get(evalId)!
  // missingInfo should mention competitor / industry being unknown.
  const mi = evalDoc.missingInfo as string[]
  assert.ok(mi.some((m) => m.includes("company_industry_unknown") || m.includes("competitor_list_unknown")))
})

test("runEvaluation — missing pa-jobs degrades to soft_block at most", async () => {
  const { db, store } = makeFakeFirestore()
  const batchId = "batch-no-job"
  const runId = "run-nojob"
  const candId = "cand-nojob"
  // NO seedJob.
  seedCompany(store, "co-1")
  seedProfile(store, candId)
  seedRecord(store, {
    recordId: "r1",
    batchId,
    resolvedUserId: candId,
    identityResolutionStatus: "merge_existing",
  })

  const result = await runEvaluation(
    { batchId, companyId: "co-1", jobId: "job-missing", runId },
    ADMIN_AUTH,
    { db, now: () => NOW },
  )

  // Should produce an evaluation rather than crash.
  assert.equal(result.completed, 1)
  const evalId = createExternalEvaluationId(candId, "job-missing", runId)
  const evalDoc = ensureCol(store, PA_COLLECTIONS.candidateCompanyJobEvaluations).get(evalId)!
  // Hard-gate degrades to soft_block (job context is empty) — never crashes.
  assert.notEqual(evalDoc.hardGateResult, "pass")
})

// ---------------------------------------------------------------------------
// Explicit recordIds[]
// ---------------------------------------------------------------------------

test("runEvaluation — recordIds[] overrides batchId scope", async () => {
  const { db, store } = makeFakeFirestore()
  const batchId = "batch-scope"
  const runId = "run-scope"
  seedJob(store, "job-1")
  seedCompany(store, "co-1")
  for (const i of [1, 2, 3]) {
    const candId = `cand-${i}`
    seedProfile(store, candId)
    seedRecord(store, {
      recordId: `r${i}`,
      batchId,
      resolvedUserId: candId,
      identityResolutionStatus: "merge_existing",
    })
  }

  // Only process r1 + r3.
  const result = await runEvaluation(
    {
      recordIds: ["r1", "r3"],
      companyId: "co-1",
      jobId: "job-1",
      runId,
    },
    ADMIN_AUTH,
    { db, now: () => NOW },
  )

  assert.equal(result.processed, 2)
  assert.equal(result.completed, 2)
  // The cand-2 evaluation was NOT written.
  const cand2EvalId = createExternalEvaluationId("cand-2", "job-1", runId)
  assert.equal(
    ensureCol(store, PA_COLLECTIONS.candidateCompanyJobEvaluations).has(cand2EvalId),
    false,
  )
})

// ---------------------------------------------------------------------------
// Auto-generated runId
// ---------------------------------------------------------------------------

test("runEvaluation — generates runId when caller omits it", async () => {
  const { db, store } = makeFakeFirestore()
  seedJob(store, "job-1")
  seedCompany(store, "co-1")

  const result = await runEvaluation(
    { batchId: "no-such-batch", companyId: "co-1", jobId: "job-1" },
    ADMIN_AUTH,
    { db, now: () => NOW, newId: () => "fixed-run-id" },
  )

  assert.equal(result.runId, "fixed-run-id")
  // Run doc lands.
  const runDoc = ensureCol(store, PA_COLLECTIONS.candidateEvaluationRuns).get("fixed-run-id")
  assert.ok(runDoc)
})
