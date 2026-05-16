/**
 * Wave C Block E3 — `agent-task.ts` callable tests.
 *
 * Drives the three handlers against an in-memory Firestore fake (mirrors
 * the style used by B's `import.test.ts`, C's `resolve-identity.test.ts`,
 * and D's `evaluate.test.ts`).
 *
 * Covers:
 *  - Auth gate: unauthenticated and non-wekruit emails rejected on every
 *    callable. Admin-claim token short-circuits.
 *  - generate: missing inputs error; not-found when records absent;
 *    happy path persists task doc with `draft_prompt` reviewStatus.
 *  - import: malformed status precondition; parses valid JSON; tolerates
 *    partial errors; re-import overwrites parsedFindings/parseErrors.
 *  - approve: single finding flip flips `approved`; partial-approve leaves
 *    `result_imported`; all-approved → `approved`; all-rejected → `rejected`.
 *  - approve appends an `agent_research` evidence entry on approve=true,
 *    leaves evidence alone on approve=false.
 */

import assert from "node:assert/strict"
import test from "node:test"
import { HttpsError } from "firebase-functions/v2/https"
import type { Firestore } from "firebase-admin/firestore"
import {
  PA_COLLECTIONS,
  type AgentResearchFinding,
  type AgentResearchTask,
  type ExternalCandidateRecord,
} from "@pa/core-types"
import {
  runApproveAgentResearchFinding,
  runGenerateAgentResearchPrompt,
  runImportAgentResearchResult,
} from "./agent-task.js"
import { AGENT_RESULT_SCHEMA_VERSION } from "@pa/external-supply"

// ---------------------------------------------------------------------------
// Firestore fake — borrowed shape from evaluate.test.ts
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

function seedRecord(
  store: Store,
  args: Partial<ExternalCandidateRecord> & { recordId: string },
) {
  const base: ExternalCandidateRecord = {
    batchId: "batch-1",
    source: "juicebox",
    rawPayload: {},
    canonicalLinkedInUrl: "https://linkedin.com/in/example",
    linkedinProfileHash: "h".repeat(64),
    emails: [],
    name: "Pat Example",
    currentTitle: "Senior Engineer",
    currentCompany: "Acme",
    experience: [{ company: "Acme", title: "Engineer" }],
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

function seedTaskWithFindings(
  store: Store,
  taskId: string,
  findings: AgentResearchFinding[],
  reviewStatus: AgentResearchTask["reviewStatus"] = "result_imported",
): AgentResearchTask {
  const task: AgentResearchTask = {
    taskId,
    evaluationRunId: "run-1",
    candidateIds: ["cand-1"],
    promptVersion: "agent-prompt-test",
    prompt: "stub prompt",
    expectedJsonSchemaVersion: AGENT_RESULT_SCHEMA_VERSION,
    reviewStatus,
    parsedFindings: findings,
    parseErrors: [],
    evidence: [],
    createdAt: NOW,
  }
  ensureCol(store, PA_COLLECTIONS.agentResearchTasks).set(taskId, { ...task })
  return task
}

// ---------------------------------------------------------------------------
// Auth-gate tests (cover all three callables via one representative each)
// ---------------------------------------------------------------------------

test("runGenerateAgentResearchPrompt — unauthenticated rejected", async () => {
  const { db } = makeFakeFirestore()
  await assert.rejects(
    () =>
      runGenerateAgentResearchPrompt(
        { recordIds: ["r1"] },
        undefined,
        { db, now: () => NOW },
      ),
    (err) => err instanceof HttpsError && err.code === "unauthenticated",
  )
})

test("runImportAgentResearchResult — non-wekruit email rejected", async () => {
  const { db } = makeFakeFirestore()
  await assert.rejects(
    () =>
      runImportAgentResearchResult(
        { taskId: "t1", rawResult: "{}" },
        { uid: "x", token: { email: "outsider@gmail.com", email_verified: true } },
        { db, now: () => NOW },
      ),
    (err) => err instanceof HttpsError && err.code === "permission-denied",
  )
})

test("runApproveAgentResearchFinding — admin claim short-circuits", async () => {
  const { db, store } = makeFakeFirestore()
  const findings: AgentResearchFinding[] = [
    {
      findingId: "f-1",
      candidateId: "cand-1",
      field: "yoe",
      value: 5,
      confidence: 0.7,
      evidenceUrls: ["https://example.com/a"],
      approved: false,
    },
  ]
  seedTaskWithFindings(store, "t-admin", findings)
  const result = await runApproveAgentResearchFinding(
    { taskId: "t-admin", findingId: "f-1", approved: true },
    { uid: "svc-1", token: { admin: true } },
    { db, now: () => NOW },
  )
  assert.equal(result.ok, true)
  assert.equal(result.approved, true)
})

// ---------------------------------------------------------------------------
// generate — input validation
// ---------------------------------------------------------------------------

test("runGenerateAgentResearchPrompt — missing recordIds and candidateIds rejects", async () => {
  const { db } = makeFakeFirestore()
  await assert.rejects(
    () =>
      runGenerateAgentResearchPrompt(
        {},
        ADMIN_AUTH,
        { db, now: () => NOW },
      ),
    (err) => err instanceof HttpsError && err.code === "invalid-argument",
  )
})

test("runGenerateAgentResearchPrompt — recordIds resolve to absent records → not-found", async () => {
  const { db } = makeFakeFirestore()
  await assert.rejects(
    () =>
      runGenerateAgentResearchPrompt(
        { recordIds: ["does-not-exist"] },
        ADMIN_AUTH,
        { db, now: () => NOW },
      ),
    (err) => err instanceof HttpsError && err.code === "not-found",
  )
})

// ---------------------------------------------------------------------------
// generate — happy path
// ---------------------------------------------------------------------------

test("runGenerateAgentResearchPrompt — happy path persists task in draft_prompt", async () => {
  const { db, store } = makeFakeFirestore()
  seedRecord(store, { recordId: "rec-1", resolvedUserId: "cand-1" })
  // Seed company and job context.
  ensureCol(store, "pa-companies").set("co-1", {
    name: "Acme",
    industrySector: ["financial_technology"],
    competitorCompanies: ["Stripe", "Plaid"],
  })
  ensureCol(store, "pa-jobs").set("job-1", {
    title: "Senior Engineer",
    roleFunction: ["software_engineering"],
    seniorityLevel: "senior",
  })

  let counter = 0
  const out = await runGenerateAgentResearchPrompt(
    {
      recordIds: ["rec-1"],
      companyId: "co-1",
      jobId: "job-1",
      missingInfoOverride: { "rec-1": ["yearsExperience", "currentSalary"] },
      evaluationRunId: "run-1",
    },
    ADMIN_AUTH,
    { db, now: () => NOW, newId: () => `task_${++counter}` },
  )

  assert.equal(out.ok, true)
  assert.equal(out.taskId, "task_1")
  assert.ok(out.prompt.includes("Acme"))
  assert.ok(out.prompt.includes("Senior Engineer"))
  assert.ok(out.prompt.includes("yearsExperience"))
  // Task doc persisted.
  const task = ensureCol(store, PA_COLLECTIONS.agentResearchTasks).get("task_1")
  assert.ok(task)
  assert.equal(task!.reviewStatus, "draft_prompt")
  assert.equal((task!.prompt as string).length, out.prompt.length)
  assert.equal((task!.promptVersion as string), out.promptVersion)
  assert.equal((task!.expectedJsonSchemaVersion as string), out.expectedJsonSchemaVersion)
  assert.deepEqual(task!.candidateIds, ["cand-1"])
})

test("runGenerateAgentResearchPrompt — production-shaped nullable record still renders prompt", async () => {
  const { db, store } = makeFakeFirestore()
  const rawRecord: Record<string, unknown> = {
    batchId: "batch-1",
    source: "manual_csv",
    rawPayload: {},
    canonicalLinkedInUrl: "https://linkedin.com/in/prod-nullable-agent",
    linkedinProfileHash: "a".repeat(64),
    emails: [],
    name: "Production Nullable",
    currentTitle: "Senior Engineer",
    currentCompany: "Acme",
    experience: [{ company: "Acme", title: "Engineer" }],
    education: [{ school: "Harvard" }],
    sourceTags: [],
    normalizationStatus: "ok",
    identityResolutionStatus: "merge_existing",
    resolvedUserId: "cand-prod-nullable-agent",
    resolutionConflictId: null,
    reviewReasons: null,
    evidence: [],
    createdAt: NOW,
    recordId: "rec-prod-nullable-agent",
  }
  ensureCol(store, PA_COLLECTIONS.externalCandidateRecords).set("rec-prod-nullable-agent", rawRecord)

  const out = await runGenerateAgentResearchPrompt(
    {
      recordIds: ["rec-prod-nullable-agent"],
      companyId: "co-1",
      jobId: "job-1",
    },
    ADMIN_AUTH,
    { db, now: () => NOW, newId: () => "task_prod_nullable" },
  )

  assert.equal(out.ok, true)
  assert.ok(out.prompt.includes("rec-prod-nullable-agent"))
  const task = ensureCol(store, PA_COLLECTIONS.agentResearchTasks).get("task_prod_nullable")
  assert.deepEqual(task!.candidateIds, ["cand-prod-nullable-agent"])
})

test("runGenerateAgentResearchPrompt — candidateIds path resolves records by resolvedUserId", async () => {
  const { db, store } = makeFakeFirestore()
  seedRecord(store, { recordId: "rec-c1", resolvedUserId: "cand-1" })
  seedRecord(store, { recordId: "rec-c2", resolvedUserId: "cand-1" })  // same candidate, two records
  seedRecord(store, { recordId: "rec-c3", resolvedUserId: "cand-2" })

  const out = await runGenerateAgentResearchPrompt(
    {
      candidateIds: ["cand-1"],
      companyId: "co-1",
      jobId: "job-1",
    },
    ADMIN_AUTH,
    { db, now: () => NOW, newId: () => "task_X" },
  )

  // 2 records for cand-1 — both rendered, deduped only by recordId.
  assert.equal(out.ok, true)
  assert.ok(out.prompt.includes("rec-c1"))
  assert.ok(out.prompt.includes("rec-c2"))
  assert.equal(out.prompt.includes("rec-c3"), false)
})

// ---------------------------------------------------------------------------
// import — input validation + preconditions
// ---------------------------------------------------------------------------

test("runImportAgentResearchResult — missing taskId rejects", async () => {
  const { db } = makeFakeFirestore()
  await assert.rejects(
    () => runImportAgentResearchResult({ rawResult: "{}" }, ADMIN_AUTH, { db, now: () => NOW }),
    (err) => err instanceof HttpsError && err.code === "invalid-argument",
  )
})

test("runImportAgentResearchResult — missing rawResult rejects", async () => {
  const { db } = makeFakeFirestore()
  await assert.rejects(
    () => runImportAgentResearchResult({ taskId: "t1" }, ADMIN_AUTH, { db, now: () => NOW }),
    (err) => err instanceof HttpsError && err.code === "invalid-argument",
  )
})

test("runImportAgentResearchResult — not-found when taskId absent", async () => {
  const { db } = makeFakeFirestore()
  await assert.rejects(
    () =>
      runImportAgentResearchResult(
        { taskId: "missing", rawResult: "{}" },
        ADMIN_AUTH,
        { db, now: () => NOW },
      ),
    (err) => err instanceof HttpsError && err.code === "not-found",
  )
})

test("runImportAgentResearchResult — failed-precondition when status=approved", async () => {
  const { db, store } = makeFakeFirestore()
  seedTaskWithFindings(store, "t-approved", [], "approved")
  await assert.rejects(
    () =>
      runImportAgentResearchResult(
        { taskId: "t-approved", rawResult: "{}" },
        ADMIN_AUTH,
        { db, now: () => NOW },
      ),
    (err) => err instanceof HttpsError && err.code === "failed-precondition",
  )
})

// ---------------------------------------------------------------------------
// import — happy path + partial errors + re-import overwrite
// ---------------------------------------------------------------------------

test("runImportAgentResearchResult — happy path persists parsedFindings + flips status", async () => {
  const { db, store } = makeFakeFirestore()
  seedTaskWithFindings(store, "t-1", [], "draft_prompt")
  const raw = "```json\n" + JSON.stringify({
    schemaVersion: AGENT_RESULT_SCHEMA_VERSION,
    findings: [
      {
        candidateId: "cand-1",
        field: "yoe",
        value: 7,
        confidence: 0.85,
        evidenceUrls: ["https://example.com/a"],
      },
    ],
  }) + "\n```"

  const out = await runImportAgentResearchResult(
    { taskId: "t-1", rawResult: raw },
    ADMIN_AUTH,
    { db, now: () => NOW },
  )

  assert.equal(out.ok, true)
  assert.equal(out.parsedCount, 1)
  assert.equal(out.parseErrorCount, 0)
  assert.equal(out.schemaVersionMismatch, false)

  const taskDoc = ensureCol(store, PA_COLLECTIONS.agentResearchTasks).get("t-1")!
  assert.equal(taskDoc.reviewStatus, "result_imported")
  assert.equal(taskDoc.rawResult, raw)
  const findings = taskDoc.parsedFindings as AgentResearchFinding[]
  assert.equal(findings.length, 1)
  assert.equal(findings[0]!.field, "yoe")
  assert.equal(findings[0]!.approved, false)
})

test("runImportAgentResearchResult — partial findings: valid persist + errors collected", async () => {
  const { db, store } = makeFakeFirestore()
  seedTaskWithFindings(store, "t-partial", [], "draft_prompt")
  const raw = JSON.stringify({
    schemaVersion: AGENT_RESULT_SCHEMA_VERSION,
    findings: [
      // valid
      {
        candidateId: "cand-1",
        field: "yoe",
        value: 7,
        confidence: 0.85,
        evidenceUrls: ["https://example.com/a"],
      },
      // bad — confidence out of range
      {
        candidateId: "cand-2",
        field: "yoe",
        value: 5,
        confidence: 2.0,
        evidenceUrls: ["https://example.com/b"],
      },
    ],
  })

  const out = await runImportAgentResearchResult(
    { taskId: "t-partial", rawResult: raw },
    ADMIN_AUTH,
    { db, now: () => NOW },
  )

  assert.equal(out.parsedCount, 1)
  assert.equal(out.parseErrorCount, 1)
  const taskDoc = ensureCol(store, PA_COLLECTIONS.agentResearchTasks).get("t-partial")!
  const errs = taskDoc.parseErrors as string[]
  assert.equal(errs.length, 1)
})

test("runImportAgentResearchResult — re-import overwrites parsedFindings", async () => {
  const { db, store } = makeFakeFirestore()
  seedTaskWithFindings(store, "t-reimp", [], "draft_prompt")
  const raw1 = JSON.stringify({
    schemaVersion: AGENT_RESULT_SCHEMA_VERSION,
    findings: [
      {
        candidateId: "cand-1",
        field: "field-A",
        value: 1,
        confidence: 0.5,
        evidenceUrls: ["https://example.com/1"],
      },
    ],
  })
  await runImportAgentResearchResult(
    { taskId: "t-reimp", rawResult: raw1 },
    ADMIN_AUTH,
    { db, now: () => NOW },
  )

  const raw2 = JSON.stringify({
    schemaVersion: AGENT_RESULT_SCHEMA_VERSION,
    findings: [
      {
        candidateId: "cand-2",
        field: "field-B",
        value: 2,
        confidence: 0.6,
        evidenceUrls: ["https://example.com/2"],
      },
      {
        candidateId: "cand-3",
        field: "field-C",
        value: 3,
        confidence: 0.7,
        evidenceUrls: ["https://example.com/3"],
      },
    ],
  })
  await runImportAgentResearchResult(
    { taskId: "t-reimp", rawResult: raw2 },
    ADMIN_AUTH,
    { db, now: () => NOW },
  )

  const taskDoc = ensureCol(store, PA_COLLECTIONS.agentResearchTasks).get("t-reimp")!
  const findings = taskDoc.parsedFindings as AgentResearchFinding[]
  // Overwrite, not append.
  assert.equal(findings.length, 2)
  assert.equal(findings[0]!.field, "field-B")
  assert.equal(findings[1]!.field, "field-C")
})

// ---------------------------------------------------------------------------
// approve — input validation + finding not found
// ---------------------------------------------------------------------------

test("runApproveAgentResearchFinding — missing approved (boolean) rejects", async () => {
  const { db } = makeFakeFirestore()
  await assert.rejects(
    () =>
      runApproveAgentResearchFinding(
        { taskId: "t-1", findingId: "f-1" },
        ADMIN_AUTH,
        { db, now: () => NOW },
      ),
    (err) => err instanceof HttpsError && err.code === "invalid-argument",
  )
})

test("runApproveAgentResearchFinding — not-found when finding absent", async () => {
  const { db, store } = makeFakeFirestore()
  seedTaskWithFindings(store, "t-noFinding", [
    {
      findingId: "f-1",
      candidateId: "cand-1",
      field: "yoe",
      value: 5,
      confidence: 0.5,
      evidenceUrls: [],
      approved: false,
    },
  ])
  await assert.rejects(
    () =>
      runApproveAgentResearchFinding(
        { taskId: "t-noFinding", findingId: "missing-finding", approved: true },
        ADMIN_AUTH,
        { db, now: () => NOW },
      ),
    (err) => err instanceof HttpsError && err.code === "not-found",
  )
})

// ---------------------------------------------------------------------------
// approve — happy path + evidence append on approve=true
// ---------------------------------------------------------------------------

test("runApproveAgentResearchFinding — approve flips flag + appends agent_research evidence", async () => {
  const { db, store } = makeFakeFirestore()
  const findings: AgentResearchFinding[] = [
    {
      findingId: "f-A",
      candidateId: "cand-1",
      field: "yoe",
      value: 7,
      confidence: 0.8,
      evidenceUrls: ["https://linkedin.com/in/foo"],
      approved: false,
    },
    {
      findingId: "f-B",
      candidateId: "cand-1",
      field: "currentCompany",
      value: "Acme",
      confidence: 0.6,
      evidenceUrls: ["https://example.com"],
      approved: false,
    },
  ]
  seedTaskWithFindings(store, "t-approve", findings)

  const result = await runApproveAgentResearchFinding(
    { taskId: "t-approve", findingId: "f-A", approved: true, note: "looks good" },
    ADMIN_AUTH,
    { db, now: () => NOW },
  )

  assert.equal(result.approved, true)
  // Only 1 of 2 is reviewed -> status stays result_imported.
  assert.equal(result.reviewStatus, "result_imported")

  const taskDoc = ensureCol(store, PA_COLLECTIONS.agentResearchTasks).get("t-approve")!
  const persisted = taskDoc.parsedFindings as AgentResearchFinding[]
  const f = persisted.find((x) => x.findingId === "f-A")!
  assert.equal(f.approved, true)
  assert.equal(f.approvedBy, "operator-1")
  assert.equal(f.approvedAt, NOW)
  // Untouched finding stays unreviewed.
  const fB = persisted.find((x) => x.findingId === "f-B")!
  assert.equal(fB.approved, false)
  assert.equal(fB.approvedBy, undefined)

  // Evidence appended with agent_research source.
  const evidence = taskDoc.evidence as { source: string; summary: string; meta: Record<string, unknown> }[]
  assert.equal(evidence.length, 1)
  assert.equal(evidence[0]!.source, "agent_research")
  assert.ok(evidence[0]!.summary.startsWith("yoe:"))
  assert.deepEqual(evidence[0]!.meta.evidenceUrls, ["https://linkedin.com/in/foo"])
  assert.equal(evidence[0]!.meta.note, "looks good")
  assert.equal(evidence[0]!.meta.findingId, "f-A")
})

test("runApproveAgentResearchFinding — reject does NOT append evidence", async () => {
  const { db, store } = makeFakeFirestore()
  seedTaskWithFindings(store, "t-reject", [
    {
      findingId: "f-X",
      candidateId: "cand-1",
      field: "yoe",
      value: 7,
      confidence: 0.5,
      evidenceUrls: ["https://example.com"],
      approved: false,
    },
  ])

  const result = await runApproveAgentResearchFinding(
    { taskId: "t-reject", findingId: "f-X", approved: false },
    ADMIN_AUTH,
    { db, now: () => NOW },
  )

  assert.equal(result.approved, false)
  const taskDoc = ensureCol(store, PA_COLLECTIONS.agentResearchTasks).get("t-reject")!
  const evidence = taskDoc.evidence as unknown[]
  assert.equal(evidence.length, 0)
})

// ---------------------------------------------------------------------------
// approve — full disposition status transitions
// ---------------------------------------------------------------------------

test("runApproveAgentResearchFinding — all approved → reviewStatus=approved", async () => {
  const { db, store } = makeFakeFirestore()
  const findings: AgentResearchFinding[] = [
    {
      findingId: "f-1",
      candidateId: "cand-1",
      field: "yoe",
      value: 7,
      confidence: 0.8,
      evidenceUrls: ["https://example.com/a"],
      approved: false,
    },
    {
      findingId: "f-2",
      candidateId: "cand-1",
      field: "currentCompany",
      value: "Acme",
      confidence: 0.7,
      evidenceUrls: ["https://example.com/b"],
      approved: false,
    },
  ]
  seedTaskWithFindings(store, "t-all-approved", findings)

  await runApproveAgentResearchFinding(
    { taskId: "t-all-approved", findingId: "f-1", approved: true },
    ADMIN_AUTH,
    { db, now: () => NOW },
  )
  const r2 = await runApproveAgentResearchFinding(
    { taskId: "t-all-approved", findingId: "f-2", approved: true },
    ADMIN_AUTH,
    { db, now: () => NOW },
  )

  assert.equal(r2.reviewStatus, "approved")
  const taskDoc = ensureCol(store, PA_COLLECTIONS.agentResearchTasks).get("t-all-approved")!
  assert.equal(taskDoc.reviewStatus, "approved")
  const evidence = taskDoc.evidence as unknown[]
  assert.equal(evidence.length, 2)
})

test("runApproveAgentResearchFinding — all rejected → reviewStatus=rejected", async () => {
  const { db, store } = makeFakeFirestore()
  const findings: AgentResearchFinding[] = [
    {
      findingId: "f-r1",
      candidateId: "cand-1",
      field: "yoe",
      value: 7,
      confidence: 0.4,
      evidenceUrls: [],
      approved: false,
    },
    {
      findingId: "f-r2",
      candidateId: "cand-1",
      field: "currentCompany",
      value: "Acme",
      confidence: 0.3,
      evidenceUrls: [],
      approved: false,
    },
  ]
  seedTaskWithFindings(store, "t-all-rej", findings)

  await runApproveAgentResearchFinding(
    { taskId: "t-all-rej", findingId: "f-r1", approved: false },
    ADMIN_AUTH,
    { db, now: () => NOW },
  )
  const r2 = await runApproveAgentResearchFinding(
    { taskId: "t-all-rej", findingId: "f-r2", approved: false },
    ADMIN_AUTH,
    { db, now: () => NOW },
  )

  assert.equal(r2.reviewStatus, "rejected")
  const taskDoc = ensureCol(store, PA_COLLECTIONS.agentResearchTasks).get("t-all-rej")!
  assert.equal(taskDoc.reviewStatus, "rejected")
  // No evidence appended on rejection.
  assert.equal((taskDoc.evidence as unknown[]).length, 0)
})

test("runApproveAgentResearchFinding — mixed approve+reject → reviewStatus=approved (at least one approved)", async () => {
  const { db, store } = makeFakeFirestore()
  const findings: AgentResearchFinding[] = [
    {
      findingId: "f-x",
      candidateId: "cand-1",
      field: "yoe",
      value: 7,
      confidence: 0.8,
      evidenceUrls: [],
      approved: false,
    },
    {
      findingId: "f-y",
      candidateId: "cand-1",
      field: "currentCompany",
      value: "Acme",
      confidence: 0.3,
      evidenceUrls: [],
      approved: false,
    },
  ]
  seedTaskWithFindings(store, "t-mixed", findings)

  await runApproveAgentResearchFinding(
    { taskId: "t-mixed", findingId: "f-x", approved: true },
    ADMIN_AUTH,
    { db, now: () => NOW },
  )
  const r2 = await runApproveAgentResearchFinding(
    { taskId: "t-mixed", findingId: "f-y", approved: false },
    ADMIN_AUTH,
    { db, now: () => NOW },
  )

  assert.equal(r2.reviewStatus, "approved")
  const taskDoc = ensureCol(store, PA_COLLECTIONS.agentResearchTasks).get("t-mixed")!
  // Only one finding produced evidence (the approved one).
  const evidence = taskDoc.evidence as unknown[]
  assert.equal(evidence.length, 1)
})
