/**
 * Wave C Block F2 — outreach callables tests.
 *
 * Covers each callable's auth gate + happy path + a representative error
 * path. Uses the same in-memory Firestore fake style as evaluate.test.ts.
 */

import assert from "node:assert/strict"
import test from "node:test"
import { HttpsError } from "firebase-functions/v2/https"
import type { Firestore } from "firebase-admin/firestore"
import {
  PA_COLLECTIONS,
  type CandidateCompanyJobEvaluation,
  type CandidateProfile,
  type OutreachPlan,
} from "@pa/core-types"
import {
  emailLookupHash,
  runApproveOutreachPlan,
  runAssignManualLinkedInTask,
  runDraftOutreachPlan,
  runMarkManualLinkedInTaskStatus,
  runRejectOutreachPlan,
} from "./outreach.js"

const NOW = "2026-05-13T12:00:00.000Z"
const ADMIN_AUTH = {
  uid: "operator-1",
  token: { email: "admin@wekruit.com", email_verified: true },
}

// ---------------------------------------------------------------------------
// Firestore fake — supports add(), set/get(), where(...).get()
// ---------------------------------------------------------------------------

type Store = Map<string, Map<string, Record<string, unknown>>>

function ensureCol(store: Store, name: string): Map<string, Record<string, unknown>> {
  if (!store.has(name)) store.set(name, new Map())
  return store.get(name)!
}

function makeStore(): Store {
  const map: Store = new Map()
  for (const name of Object.values(PA_COLLECTIONS)) map.set(name, new Map())
  map.set("pa-jobs", new Map())
  map.set("pa-companies", new Map())
  return map
}

function makeFakeFirestore(store: Store = makeStore()): { db: Firestore; store: Store } {
  let autoId = 0
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
      async add(data: Record<string, unknown>) {
        autoId += 1
        const id = `auto-${autoId}`
        ensureCol(store, collectionName).set(id, { ...data })
        return { id }
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
// Seeders
// ---------------------------------------------------------------------------

function seedEvaluation(
  store: Store,
  args: Partial<CandidateCompanyJobEvaluation> & {
    evaluationId: string
    candidateId: string
    jobId: string
    companyId: string
  },
) {
  const doc: CandidateCompanyJobEvaluation = {
    evaluationId: args.evaluationId,
    evaluationRunId: "run-1",
    candidateId: args.candidateId,
    companyId: args.companyId,
    jobId: args.jobId,
    rubricVersion: "rubric-2026-05-v1",
    generalRubricScore: 0.7,
    companyRubricScore: 0.6,
    jobRubricScore: 0.8,
    hardGateResult: "pass",
    hardGateReasons: ["role_function_overlap", "visa_ok"],
    softScore: 0.75,
    missingInfo: [],
    risks: [],
    evidence: [],
    explanation: "Strong fit.",
    proposedTier: "tier_2_personal_email",
    createdAt: NOW,
    ...args,
  }
  ensureCol(store, PA_COLLECTIONS.candidateCompanyJobEvaluations).set(args.evaluationId, doc)
}

function seedProfile(
  store: Store,
  candidateId: string,
  over: Partial<CandidateProfile> = {},
) {
  ensureCol(store, PA_COLLECTIONS.users).set(candidateId, {
    candidateId,
    candidateLifecycleState: "profile_ready",
    createdAt: NOW,
    linkedinUrl: "https://linkedin.com/in/test",
    outreach: { status: "allowed" },
    ...over,
  })
}

function seedJob(store: Store, jobId: string, over: Record<string, unknown> = {}) {
  ensureCol(store, "pa-jobs").set(jobId, {
    title: "Senior Engineer",
    ...over,
  })
}

function seedCompany(store: Store, companyId: string, over: Record<string, unknown> = {}) {
  ensureCol(store, "pa-companies").set(companyId, {
    name: "Acme",
    ...over,
  })
}

function seedCandidateHandle(
  store: Store,
  candidateId: string,
  email: string,
  handleId = `handle-${candidateId}`,
) {
  ensureCol(store, PA_COLLECTIONS.candidateHandles).set(handleId, {
    handleId,
    candidateId,
    kind: "email",
    handleHash: "h".repeat(32),
    normalizedValue: email.toLowerCase(),
    source: "external_sourcing",
    createdAt: NOW,
  })
}

// ---------------------------------------------------------------------------
// draftOutreachPlan
// ---------------------------------------------------------------------------

test("draftOutreachPlan — rejects unauthenticated", async () => {
  const { db } = makeFakeFirestore()
  await assert.rejects(
    () =>
      runDraftOutreachPlan({ evaluationId: "e1" }, undefined, { db, now: () => NOW }),
    (err) => err instanceof HttpsError && err.code === "unauthenticated",
  )
})

test("draftOutreachPlan — rejects non-wekruit", async () => {
  const { db } = makeFakeFirestore()
  await assert.rejects(
    () =>
      runDraftOutreachPlan(
        { evaluationId: "e1" },
        { uid: "x", token: { email: "outsider@gmail.com", email_verified: true } },
        { db, now: () => NOW },
      ),
    (err) => err instanceof HttpsError && err.code === "permission-denied",
  )
})

test("draftOutreachPlan — happy path writes plan with draft status + tier", async () => {
  const { db, store } = makeFakeFirestore()
  seedEvaluation(store, {
    evaluationId: "e1",
    candidateId: "c1",
    jobId: "j1",
    companyId: "co1",
    proposedTier: "tier_2_personal_email",
  })
  seedProfile(store, "c1")
  seedJob(store, "j1")
  seedCompany(store, "co1")
  seedCandidateHandle(store, "c1", "ada@example.com")

  let planId = ""
  const result = await runDraftOutreachPlan(
    { evaluationId: "e1" },
    ADMIN_AUTH,
    { db, now: () => NOW, newId: () => (planId = "plan-1") },
  )

  assert.equal(result.ok, true)
  assert.equal(result.planId, "plan-1")
  assert.equal(result.tier, "tier_2_personal_email")
  assert.equal(result.channelDecision, "personal_email")
  assert.equal(result.suppression.allow, true)
  const persisted = ensureCol(store, PA_COLLECTIONS.outreachPlans).get(planId)
  assert.ok(persisted, "plan persisted")
  assert.equal(persisted!.approvalStatus, "draft")
  // email hash stamped on the doc (not in the Zod schema, but a top-level property).
  assert.equal(persisted!.emailHash, emailLookupHash("ada@example.com"))
})

test("draftOutreachPlan — suppression block path still produces draft (for operator review)", async () => {
  const { db, store } = makeFakeFirestore()
  seedEvaluation(store, {
    evaluationId: "e1",
    candidateId: "c1",
    jobId: "j1",
    companyId: "co1",
    proposedTier: "tier_2_personal_email",
  })
  seedProfile(store, "c1", { outreach: { status: "opted_out" } })
  seedJob(store, "j1")
  seedCompany(store, "co1")

  const result = await runDraftOutreachPlan(
    { evaluationId: "e1" },
    ADMIN_AUTH,
    { db, now: () => NOW, newId: () => "plan-blocked" },
  )
  assert.equal(result.suppression.allow, false)
  assert.ok(result.suppression.blockedReasons.includes("opted_out"))
  // Draft is still persisted.
  assert.ok(ensureCol(store, PA_COLLECTIONS.outreachPlans).get("plan-blocked"))
})

test("draftOutreachPlan — missing evaluation throws not-found", async () => {
  const { db } = makeFakeFirestore()
  await assert.rejects(
    () => runDraftOutreachPlan({ evaluationId: "missing" }, ADMIN_AUTH, { db, now: () => NOW }),
    (err) => err instanceof HttpsError && err.code === "not-found",
  )
})

test("draftOutreachPlan — generateCopy override is honored", async () => {
  const { db, store } = makeFakeFirestore()
  seedEvaluation(store, {
    evaluationId: "e1",
    candidateId: "c1",
    jobId: "j1",
    companyId: "co1",
  })
  seedProfile(store, "c1")
  seedJob(store, "j1")
  seedCompany(store, "co1")

  await runDraftOutreachPlan(
    { evaluationId: "e1", copyOverrides: { personalizedHook: "Operator override hook." } },
    ADMIN_AUTH,
    {
      db,
      now: () => NOW,
      newId: () => "plan-override",
      generateCopy: async () => ({
        personalizedHook: "LLM hook",
        emailBody: "LLM body",
      }),
    },
  )
  const persisted = ensureCol(store, PA_COLLECTIONS.outreachPlans).get("plan-override")
  // Override beats LLM-generated copy.
  assert.equal(persisted!.personalizedHook, "Operator override hook.")
  // Non-overridden field still uses LLM output.
  assert.equal(persisted!.emailBody, "LLM body")
})

// ---------------------------------------------------------------------------
// approveOutreachPlan
// ---------------------------------------------------------------------------

async function makeDraftPlan(
  db: Firestore,
  store: Store,
  planId: string,
  over: Partial<OutreachPlan> = {},
): Promise<void> {
  seedEvaluation(store, {
    evaluationId: "e1",
    candidateId: "c1",
    jobId: "j1",
    companyId: "co1",
    proposedTier: "tier_2_personal_email",
  })
  seedProfile(store, "c1")
  seedJob(store, "j1")
  seedCompany(store, "co1")
  seedCandidateHandle(store, "c1", "ada@example.com")
  await runDraftOutreachPlan(
    { evaluationId: "e1" },
    ADMIN_AUTH,
    { db, now: () => NOW, newId: () => planId },
  )
  if (Object.keys(over).length > 0) {
    const persisted = ensureCol(store, PA_COLLECTIONS.outreachPlans).get(planId)!
    ensureCol(store, PA_COLLECTIONS.outreachPlans).set(planId, { ...persisted, ...over })
  }
}

test("approveOutreachPlan — admin gate", async () => {
  const { db } = makeFakeFirestore()
  await assert.rejects(
    () => runApproveOutreachPlan({ planId: "p" }, undefined, { db, now: () => NOW }),
    (err) => err instanceof HttpsError && err.code === "unauthenticated",
  )
})

test("approveOutreachPlan — happy path sets approved + writes correction event when edits present", async () => {
  const { db, store } = makeFakeFirestore()
  await makeDraftPlan(db, store, "plan-A")
  let correctionId = ""
  const out = await runApproveOutreachPlan(
    {
      planId: "plan-A",
      edits: { personalizedHook: "Edited hook copy." },
    },
    ADMIN_AUTH,
    { db, now: () => NOW, newId: () => (correctionId = "corr-1") },
  )
  assert.equal(out.approvalStatus, "approved")
  assert.equal(out.correctionEventId, correctionId)
  const persisted = ensureCol(store, PA_COLLECTIONS.outreachPlans).get("plan-A")!
  assert.equal(persisted.approvalStatus, "approved")
  assert.equal(persisted.personalizedHook, "Edited hook copy.")
  // Correction event persisted.
  const corr = ensureCol(store, PA_COLLECTIONS.correctionEvents).get(correctionId)
  assert.ok(corr)
  assert.equal(corr!.targetType, "feedback_event")
  assert.equal(corr!.candidateId, "c1")
})

test("approveOutreachPlan — no correction event when no edits change", async () => {
  const { db, store } = makeFakeFirestore()
  await makeDraftPlan(db, store, "plan-A")
  const out = await runApproveOutreachPlan(
    { planId: "plan-A" },
    ADMIN_AUTH,
    { db, now: () => NOW, newId: () => "should-not-write" },
  )
  assert.equal(out.correctionEventId, undefined)
})

test("approveOutreachPlan — rejects plan already sent", async () => {
  const { db, store } = makeFakeFirestore()
  await makeDraftPlan(db, store, "plan-A", { approvalStatus: "sent" })
  await assert.rejects(
    () => runApproveOutreachPlan({ planId: "plan-A" }, ADMIN_AUTH, { db, now: () => NOW }),
    (err) => err instanceof HttpsError && err.code === "failed-precondition",
  )
})

// ---------------------------------------------------------------------------
// rejectOutreachPlan
// ---------------------------------------------------------------------------

test("rejectOutreachPlan — happy path sets rejected + reason", async () => {
  const { db, store } = makeFakeFirestore()
  await makeDraftPlan(db, store, "plan-A")
  await runRejectOutreachPlan(
    { planId: "plan-A", reason: "low_confidence_match" },
    ADMIN_AUTH,
    { db, now: () => NOW },
  )
  const persisted = ensureCol(store, PA_COLLECTIONS.outreachPlans).get("plan-A")!
  assert.equal(persisted.approvalStatus, "rejected")
  assert.equal(persisted.rejectionReason, "low_confidence_match")
})

test("rejectOutreachPlan — invalid args", async () => {
  const { db } = makeFakeFirestore()
  await assert.rejects(
    () => runRejectOutreachPlan({ planId: "" }, ADMIN_AUTH, { db, now: () => NOW }),
    (err) => err instanceof HttpsError && err.code === "invalid-argument",
  )
})

// ---------------------------------------------------------------------------
// assignManualLinkedInTask + markManualLinkedInTaskStatus
// ---------------------------------------------------------------------------

test("assignManualLinkedInTask — only valid on tier_1 approved plans", async () => {
  const { db, store } = makeFakeFirestore()
  await makeDraftPlan(db, store, "plan-A")
  // Plan is tier_2 → reject assignment.
  await assert.rejects(
    () =>
      runAssignManualLinkedInTask(
        { planId: "plan-A", assignee: "rev-1" },
        ADMIN_AUTH,
        { db, now: () => NOW },
      ),
    (err) => err instanceof HttpsError && err.code === "failed-precondition",
  )
})

test("assignManualLinkedInTask — happy path on tier_1 approved plan", async () => {
  const { db, store } = makeFakeFirestore()
  // Tier 1 requires personalization which the template does provide.
  seedEvaluation(store, {
    evaluationId: "e1",
    candidateId: "c1",
    jobId: "j1",
    companyId: "co1",
    proposedTier: "tier_1_personal_linkedin_and_email",
  })
  seedProfile(store, "c1")
  seedJob(store, "j1")
  seedCompany(store, "co1")
  seedCandidateHandle(store, "c1", "ada@example.com")
  await runDraftOutreachPlan(
    { evaluationId: "e1" },
    ADMIN_AUTH,
    { db, now: () => NOW, newId: () => "plan-tier1" },
  )
  await runApproveOutreachPlan({ planId: "plan-tier1" }, ADMIN_AUTH, {
    db,
    now: () => NOW,
    newId: () => "ignore",
  })
  await runAssignManualLinkedInTask(
    { planId: "plan-tier1", assignee: "reviewer-uid" },
    ADMIN_AUTH,
    { db, now: () => NOW },
  )
  const persisted = ensureCol(store, PA_COLLECTIONS.outreachPlans).get("plan-tier1")!
  assert.equal(persisted.manualLinkedInTaskAssignee, "reviewer-uid")
  assert.equal(persisted.manualLinkedInTaskStatus, "todo")
})

test("markManualLinkedInTaskStatus — validates enum", async () => {
  const { db, store } = makeFakeFirestore()
  await makeDraftPlan(db, store, "plan-A", {
    tier: "tier_1_personal_linkedin_and_email",
    channelDecision: "personal_linkedin",
  })
  await assert.rejects(
    () =>
      runMarkManualLinkedInTaskStatus(
        { planId: "plan-A", status: "completed-but-invalid" },
        ADMIN_AUTH,
        { db, now: () => NOW },
      ),
    (err) => err instanceof HttpsError && err.code === "invalid-argument",
  )
})

test("markManualLinkedInTaskStatus — happy path", async () => {
  const { db, store } = makeFakeFirestore()
  await makeDraftPlan(db, store, "plan-A", {
    tier: "tier_1_personal_linkedin_and_email",
    channelDecision: "personal_linkedin",
  })
  await runMarkManualLinkedInTaskStatus(
    { planId: "plan-A", status: "sent" },
    ADMIN_AUTH,
    { db, now: () => NOW },
  )
  const persisted = ensureCol(store, PA_COLLECTIONS.outreachPlans).get("plan-A")!
  assert.equal(persisted.manualLinkedInTaskStatus, "sent")
})

// ---------------------------------------------------------------------------
// emailLookupHash
// ---------------------------------------------------------------------------

test("emailLookupHash — case + whitespace insensitive deterministic sha256 hex", () => {
  const a = emailLookupHash("ADA@example.com")
  const b = emailLookupHash("  ada@example.COM  ")
  assert.equal(a, b)
  assert.equal(a.length, 64)
})
