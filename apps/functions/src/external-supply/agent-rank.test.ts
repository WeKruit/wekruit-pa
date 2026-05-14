/**
 * Wave C (Executor D) — `agent-rank.ts` callable tests.
 *
 * Drives the three callables against an in-memory Firestore fake + a
 * deterministic `runWithOpenAI` stub. Mirrors the style used by
 * `agent-task.test.ts` and `evaluate.test.ts`.
 */

import assert from "node:assert/strict"
import test from "node:test"
import { HttpsError } from "firebase-functions/v2/https"
import type { Firestore } from "firebase-admin/firestore"
import {
  AGENT_RANK_EXPECTED_SCHEMA_VERSION,
  AGENT_RANK_PROMPT_VERSION,
  COST_TABLE_VERSION,
} from "@pa/external-supply"
import {
  PA_COLLECTIONS,
  createAgentRankingResultId,
  type CandidateCompanyJobEvaluation,
  type EvaluationTier,
} from "@pa/core-types"
import {
  runAgentRanking,
  runApproveAgentTier,
  runOverrideAgentTier,
  type AgentRankingDeps,
  type RunWithOpenAIDep,
} from "./agent-rank.js"

// ---------------------------------------------------------------------------
// Firestore fake
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
    const where = (field: string, _op: string, value: unknown) => {
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
    }
    return {
      doc(id: string) {
        return docRef(collectionName, id)
      },
      where,
      async add(data: Record<string, unknown>) {
        const id = `auto-${Math.random().toString(36).slice(2, 10)}`
        ensureCol(store, collectionName).set(id, data)
        return { id }
      },
    }
  }
  const db = { collection } as unknown as Firestore
  return { db, store }
}

// ---------------------------------------------------------------------------
// Seeders
// ---------------------------------------------------------------------------

function mkEvaluation(args: {
  candidateId: string
  jobId?: string
  companyId?: string
  evaluationRunId?: string
  proposedTier?: EvaluationTier
}): CandidateCompanyJobEvaluation {
  return {
    evaluationId: `eval-${args.candidateId}`,
    candidateId: args.candidateId,
    companyId: args.companyId ?? "co-1",
    jobId: args.jobId ?? "job-1",
    evaluationRunId: args.evaluationRunId ?? "run-1",
    rubricVersion: "v1",
    generalRubricScore: 0.7,
    companyRubricScore: 0.6,
    jobRubricScore: 0.6,
    hardGateResult: "pass",
    hardGateReasons: [],
    softScore: 0.65,
    missingInfo: [],
    risks: [],
    evidence: [],
    explanation: "test fixture",
    proposedTier: args.proposedTier ?? "tier_2_personal_email",
    createdAt: NOW,
  }
}

function seedEvaluation(store: Store, ev: CandidateCompanyJobEvaluation) {
  ensureCol(store, PA_COLLECTIONS.candidateCompanyJobEvaluations).set(ev.evaluationId, ev)
}

function seedUser(store: Store, candidateId: string) {
  ensureCol(store, PA_COLLECTIONS.users).set(candidateId, {
    name: "Test User",
    linkedinUrl: "https://linkedin.com/in/test",
    experience: [{ company: "Acme", title: "Engineer", startDate: "2022-01" }],
    skills: ["typescript", "react"],
  })
}

function makeLlmStub(
  reply: { tier: EvaluationTier; action?: string; risks?: string[] } | string,
  callsRef?: { count: number },
): RunWithOpenAIDep {
  return async () => {
    if (callsRef) callsRef.count += 1
    const text =
      typeof reply === "string"
        ? reply
        : JSON.stringify({
            schemaVersion: AGENT_RANK_EXPECTED_SCHEMA_VERSION,
            proposedAgentTier: reply.tier,
            agentRationale: `agent rationale for ${reply.tier}`,
            agentRisks: reply.risks ?? [],
            agentRecommendedAction: reply.action ?? "outreach_now",
          })
    return {
      text,
      usage: { promptTokens: 200, completionTokens: 80 },
    }
  }
}

function deps(
  db: Firestore,
  llm: RunWithOpenAIDep,
  ids?: () => string,
): AgentRankingDeps {
  return {
    db,
    runWithOpenAI: llm,
    now: () => NOW,
    newId: ids ?? (() => "uuid-fixed"),
  }
}

// ---------------------------------------------------------------------------
// Auth gate
// ---------------------------------------------------------------------------

test("runAgentRanking — non-admin rejected with permission-denied", async () => {
  const { db } = makeFakeFirestore()
  await assert.rejects(
    () =>
      runAgentRanking(
        { evaluationRunId: "run-1" },
        { uid: "x", token: { email: "outsider@gmail.com", email_verified: true } },
        deps(db, makeLlmStub({ tier: "tier_2_personal_email" })),
      ),
    (err) => err instanceof HttpsError && err.code === "permission-denied",
  )
})

test("runApproveAgentTier — unauthenticated rejected", async () => {
  const { db } = makeFakeFirestore()
  await assert.rejects(
    () =>
      runApproveAgentTier(
        { resultId: "r-1" },
        undefined,
        deps(db, makeLlmStub({ tier: "tier_2_personal_email" })),
      ),
    (err) => err instanceof HttpsError && err.code === "unauthenticated",
  )
})

// ---------------------------------------------------------------------------
// Happy path ensembleSize=1
// ---------------------------------------------------------------------------

test("runAgentRanking — happy path writes one ranking row + one ledger row (ensembleSize=1)", async () => {
  const { db, store } = makeFakeFirestore()
  const ev = mkEvaluation({ candidateId: "cand-1" })
  seedEvaluation(store, ev)
  seedUser(store, "cand-1")
  const callsRef = { count: 0 }
  const llm = makeLlmStub({ tier: "tier_1_personal_linkedin_and_email" }, callsRef)

  const result = await runAgentRanking(
    { evaluationRunId: "run-1", ensembleSize: 1 },
    ADMIN_AUTH,
    deps(db, llm),
  )

  assert.equal(result.ok, true)
  assert.equal(result.rankedCount, 1)
  assert.equal(result.skippedCount, 0)
  assert.equal(callsRef.count, 1)
  assert.ok(result.totalCostUsd > 0)
  assert.equal(result.costTableVersion, COST_TABLE_VERSION)
  assert.equal(result.promptVersion, AGENT_RANK_PROMPT_VERSION)

  const expectedId = createAgentRankingResultId({
    evaluationRunId: "run-1",
    candidateRecordId: "cand-1",
  })
  const rankingRow = ensureCol(store, PA_COLLECTIONS.agentRankingResults).get(expectedId)
  assert.ok(rankingRow)
  assert.equal(rankingRow!.proposedAgentTier, "tier_1_personal_linkedin_and_email")
  assert.equal(rankingRow!.deterministicTier, "tier_2_personal_email")
  assert.equal(rankingRow!.status, "proposed")
  assert.equal(rankingRow!.ensembleSize, 1)
  assert.equal((rankingRow as { ensembleVotes: unknown[] }).ensembleVotes.length, 1)
  assert.equal(rankingRow!.costTableVersion, COST_TABLE_VERSION)

  const toolCalls = Array.from(ensureCol(store, PA_COLLECTIONS.toolCalls).values())
  assert.equal(toolCalls.length, 1)
  assert.equal(toolCalls[0]!.callable, "runAgentRanking")
  assert.equal(toolCalls[0]!.candidateId, "cand-1")
  assert.equal(toolCalls[0]!.costTableVersion, COST_TABLE_VERSION)
})

// ---------------------------------------------------------------------------
// dry-run
// ---------------------------------------------------------------------------

test("runAgentRanking — dryRun=true populates projectedCostUsd and writes nothing", async () => {
  const { db, store } = makeFakeFirestore()
  seedEvaluation(store, mkEvaluation({ candidateId: "cand-1" }))
  seedUser(store, "cand-1")
  const callsRef = { count: 0 }
  const llm = makeLlmStub({ tier: "tier_2_personal_email" }, callsRef)
  const result = await runAgentRanking(
    { evaluationRunId: "run-1", dryRun: true },
    ADMIN_AUTH,
    deps(db, llm),
  )
  assert.equal(result.abortedReason, "dry_run")
  assert.ok(result.projectedCostUsd > 0)
  assert.equal(result.rankedCount, 0)
  assert.equal(callsRef.count, 0)
  assert.equal(ensureCol(store, PA_COLLECTIONS.agentRankingResults).size, 0)
  assert.equal(ensureCol(store, PA_COLLECTIONS.toolCalls).size, 0)
})

// ---------------------------------------------------------------------------
// budget_exceeded
// ---------------------------------------------------------------------------

test("runAgentRanking — budget_exceeded aborts with zero writes", async () => {
  const { db, store } = makeFakeFirestore()
  // Seed enough candidates to easily blow past $10 default budget on the
  // expensive Sonnet pricing row × ensembleSize=3.
  for (let i = 0; i < 200; i += 1) {
    const id = `cand-${i}`
    seedEvaluation(store, mkEvaluation({ candidateId: id }))
    seedUser(store, id)
  }
  const callsRef = { count: 0 }
  const llm = makeLlmStub({ tier: "tier_2_personal_email" }, callsRef)
  // Force expensive model + lower budget to make projection exceed.
  const result = await runAgentRanking(
    {
      evaluationRunId: "run-1",
      model: "claude-sonnet-4-6",
      ensembleSize: 3,
      budgetUsd: 0.01,
    },
    ADMIN_AUTH,
    deps(db, llm),
  )
  assert.equal(result.abortedReason, "budget_exceeded")
  assert.equal(result.rankedCount, 0)
  assert.equal(callsRef.count, 0)
  assert.equal(ensureCol(store, PA_COLLECTIONS.agentRankingResults).size, 0)
  assert.equal(ensureCol(store, PA_COLLECTIONS.toolCalls).size, 0)
})

test("runAgentRanking — budgetUsd override allows previously-aborted run", async () => {
  const { db, store } = makeFakeFirestore()
  for (let i = 0; i < 5; i += 1) {
    const id = `cand-${i}`
    seedEvaluation(store, mkEvaluation({ candidateId: id }))
    seedUser(store, id)
  }
  const llm = makeLlmStub({ tier: "tier_2_personal_email" })
  // First aborts.
  const r1 = await runAgentRanking(
    { evaluationRunId: "run-1", model: "claude-sonnet-4-6", budgetUsd: 0.00001 },
    ADMIN_AUTH,
    deps(db, llm),
  )
  assert.equal(r1.abortedReason, "budget_exceeded")
  // Now lift budget.
  const r2 = await runAgentRanking(
    { evaluationRunId: "run-1", model: "claude-sonnet-4-6", budgetUsd: 1000 },
    ADMIN_AUTH,
    deps(db, llm),
  )
  assert.equal(r2.abortedReason, undefined)
  assert.equal(r2.rankedCount, 5)
})

// ---------------------------------------------------------------------------
// Ensemble majority + tie
// ---------------------------------------------------------------------------

test("runAgentRanking — ensemble majority 2-of-3 wins", async () => {
  const { db, store } = makeFakeFirestore()
  seedEvaluation(store, mkEvaluation({ candidateId: "cand-1" }))
  seedUser(store, "cand-1")
  const replies = [
    { tier: "tier_2_personal_email" as EvaluationTier },
    { tier: "tier_2_personal_email" as EvaluationTier },
    { tier: "tier_1_personal_linkedin_and_email" as EvaluationTier },
  ]
  let idx = 0
  const llm: RunWithOpenAIDep = async () => {
    const r = replies[idx++]!
    return {
      text: JSON.stringify({
        schemaVersion: AGENT_RANK_EXPECTED_SCHEMA_VERSION,
        proposedAgentTier: r.tier,
        agentRationale: `r-${idx}`,
        agentRisks: [],
        agentRecommendedAction: "outreach_now",
      }),
      usage: { promptTokens: 100, completionTokens: 50 },
    }
  }
  const result = await runAgentRanking(
    { evaluationRunId: "run-1", ensembleSize: 3 },
    ADMIN_AUTH,
    deps(db, llm),
  )
  assert.equal(result.rankedCount, 1)
  const rid = createAgentRankingResultId({
    evaluationRunId: "run-1",
    candidateRecordId: "cand-1",
  })
  const row = ensureCol(store, PA_COLLECTIONS.agentRankingResults).get(rid)!
  assert.equal(row.proposedAgentTier, "tier_2_personal_email")
})

test("runAgentRanking — ensemble tie falls back to deterministic + outreach_after_research", async () => {
  const { db, store } = makeFakeFirestore()
  seedEvaluation(store, mkEvaluation({ candidateId: "cand-1", proposedTier: "retain_only" }))
  seedUser(store, "cand-1")
  const replies = [
    "tier_2_personal_email",
    "tier_1_personal_linkedin_and_email",
    "tier_3_general_email",
  ] as EvaluationTier[]
  let idx = 0
  const llm: RunWithOpenAIDep = async () => {
    const tier = replies[idx++]!
    return {
      text: JSON.stringify({
        schemaVersion: AGENT_RANK_EXPECTED_SCHEMA_VERSION,
        proposedAgentTier: tier,
        agentRationale: `r-${idx}`,
        agentRisks: [],
        agentRecommendedAction: "outreach_now",
      }),
      usage: { promptTokens: 100, completionTokens: 50 },
    }
  }
  await runAgentRanking(
    { evaluationRunId: "run-1", ensembleSize: 3 },
    ADMIN_AUTH,
    deps(db, llm),
  )
  const rid = createAgentRankingResultId({
    evaluationRunId: "run-1",
    candidateRecordId: "cand-1",
  })
  const row = ensureCol(store, PA_COLLECTIONS.agentRankingResults).get(rid)!
  assert.equal(row.proposedAgentTier, "retain_only")
  assert.equal(row.agentRecommendedAction, "outreach_after_research")
})

// ---------------------------------------------------------------------------
// Hard-gate clamp
// ---------------------------------------------------------------------------

test("runAgentRanking — deterministicTier=blocked clamps proposedAgentTier to blocked", async () => {
  const { db, store } = makeFakeFirestore()
  seedEvaluation(
    store,
    mkEvaluation({ candidateId: "cand-1", proposedTier: "blocked" }),
  )
  seedUser(store, "cand-1")
  const llm = makeLlmStub({ tier: "tier_1_personal_linkedin_and_email" })
  await runAgentRanking({ evaluationRunId: "run-1" }, ADMIN_AUTH, deps(db, llm))
  const rid = createAgentRankingResultId({
    evaluationRunId: "run-1",
    candidateRecordId: "cand-1",
  })
  const row = ensureCol(store, PA_COLLECTIONS.agentRankingResults).get(rid)!
  assert.equal(row.proposedAgentTier, "blocked")
  assert.ok((row.agentRisks as string[]).includes("hard_gate_blocked"))
})

// ---------------------------------------------------------------------------
// candidateRecordIds filter
// ---------------------------------------------------------------------------

test("runAgentRanking — candidateRecordIds scopes the run", async () => {
  const { db, store } = makeFakeFirestore()
  seedEvaluation(store, mkEvaluation({ candidateId: "cand-1" }))
  seedEvaluation(store, mkEvaluation({ candidateId: "cand-2" }))
  seedUser(store, "cand-1")
  seedUser(store, "cand-2")
  const llm = makeLlmStub({ tier: "tier_2_personal_email" })
  const result = await runAgentRanking(
    { evaluationRunId: "run-1", candidateRecordIds: ["cand-2"] },
    ADMIN_AUTH,
    deps(db, llm),
  )
  assert.equal(result.processedCount, 1)
  assert.equal(result.rankedCount, 1)
  assert.equal(ensureCol(store, PA_COLLECTIONS.agentRankingResults).size, 1)
})

// ---------------------------------------------------------------------------
// Approve
// ---------------------------------------------------------------------------

async function seedProposedRanking(
  store: Store,
  candidateId = "cand-1",
  evaluationRunId = "run-1",
  proposedAgentTier: EvaluationTier = "tier_2_personal_email",
): Promise<string> {
  const resultId = createAgentRankingResultId({
    evaluationRunId,
    candidateRecordId: candidateId,
  })
  ensureCol(store, PA_COLLECTIONS.agentRankingResults).set(resultId, {
    resultId,
    evaluationRunId,
    candidateRecordId: candidateId,
    candidateUserId: candidateId,
    companyId: "co-1",
    jobId: "job-1",
    deterministicTier: "tier_2_personal_email",
    proposedAgentTier,
    agentRationale: "stub rationale",
    agentRisks: [],
    agentRecommendedAction: "outreach_now",
    ensembleVotes: [],
    modelUsed: "gpt-5.4-nano",
    ensembleSize: 1,
    totalInputTokens: 100,
    totalOutputTokens: 50,
    totalCostUsd: 0.0001,
    dryRun: false,
    promptVersion: AGENT_RANK_PROMPT_VERSION,
    status: "proposed",
    createdAt: NOW,
  })
  return resultId
}

test("runApproveAgentTier — approves and stamps approvedTier from proposedAgentTier", async () => {
  const { db, store } = makeFakeFirestore()
  const rid = await seedProposedRanking(store)
  const result = await runApproveAgentTier(
    { resultId: rid },
    ADMIN_AUTH,
    deps(db, makeLlmStub({ tier: "tier_2_personal_email" })),
  )
  assert.equal(result.ok, true)
  assert.equal(result.approvedTier, "tier_2_personal_email")
  const row = ensureCol(store, PA_COLLECTIONS.agentRankingResults).get(rid)!
  assert.equal(row.status, "approved")
  assert.equal(row.approvedTier, "tier_2_personal_email")
  assert.equal(row.approvedBy, "operator-1")
  // No correction event from approve.
  assert.equal(ensureCol(store, PA_COLLECTIONS.correctionEvents).size, 0)
})

test("runApproveAgentTier — idempotent on already-approved", async () => {
  const { db, store } = makeFakeFirestore()
  const rid = await seedProposedRanking(store)
  await runApproveAgentTier(
    { resultId: rid },
    ADMIN_AUTH,
    deps(db, makeLlmStub({ tier: "tier_2_personal_email" })),
  )
  const second = await runApproveAgentTier(
    { resultId: rid },
    ADMIN_AUTH,
    deps(db, makeLlmStub({ tier: "tier_2_personal_email" })),
  )
  assert.equal(second.ok, true)
  assert.equal(second.approvedTier, "tier_2_personal_email")
})

// ---------------------------------------------------------------------------
// Override
// ---------------------------------------------------------------------------

test("runOverrideAgentTier — writes status + correctionEventId + correction-event doc", async () => {
  const { db, store } = makeFakeFirestore()
  const rid = await seedProposedRanking(store)
  let nonce = 0
  const result = await runOverrideAgentTier(
    {
      resultId: rid,
      newTier: "tier_1_personal_linkedin_and_email",
      reason: "operator believes candidate is top-tier",
    },
    ADMIN_AUTH,
    deps(db, makeLlmStub({ tier: "x" as EvaluationTier }), () => `uuid-${++nonce}`),
  )
  assert.equal(result.ok, true)
  assert.equal(result.approvedTier, "tier_1_personal_linkedin_and_email")
  assert.equal(result.correctionEventId, "uuid-1")
  const row = ensureCol(store, PA_COLLECTIONS.agentRankingResults).get(rid)!
  assert.equal(row.status, "overridden")
  assert.equal(row.approvedTier, "tier_1_personal_linkedin_and_email")
  assert.equal(row.correctionEventId, "uuid-1")
  const corr = ensureCol(store, PA_COLLECTIONS.correctionEvents).get("uuid-1")!
  assert.equal(corr.targetType, "agent_ranking_result")
  assert.equal(corr.targetId, rid)
  assert.equal(corr.actor, "operator")
  assert.equal(corr.candidateId, "cand-1")
  assert.equal(corr.jobId, "job-1")
  assert.deepEqual(corr.beforeRedacted, {
    proposedAgentTier: "tier_2_personal_email",
    deterministicTier: "tier_2_personal_email",
  })
  assert.deepEqual(corr.afterRedacted, {
    approvedTier: "tier_1_personal_linkedin_and_email",
  })
})

test("runOverrideAgentTier — already-approved throws failed-precondition", async () => {
  const { db, store } = makeFakeFirestore()
  const rid = await seedProposedRanking(store)
  await runApproveAgentTier(
    { resultId: rid },
    ADMIN_AUTH,
    deps(db, makeLlmStub({ tier: "x" as EvaluationTier })),
  )
  await assert.rejects(
    () =>
      runOverrideAgentTier(
        { resultId: rid, newTier: "blocked", reason: "test" },
        ADMIN_AUTH,
        deps(db, makeLlmStub({ tier: "x" as EvaluationTier })),
      ),
    (err) => err instanceof HttpsError && err.code === "failed-precondition",
  )
})

test("runOverrideAgentTier — idempotent on already-overridden row", async () => {
  const { db, store } = makeFakeFirestore()
  const rid = await seedProposedRanking(store)
  let nonce = 0
  const first = await runOverrideAgentTier(
    { resultId: rid, newTier: "blocked", reason: "test" },
    ADMIN_AUTH,
    deps(db, makeLlmStub({ tier: "x" as EvaluationTier }), () => `uuid-${++nonce}`),
  )
  const second = await runOverrideAgentTier(
    {
      resultId: rid,
      newTier: "tier_1_personal_linkedin_and_email",
      reason: "test2",
    },
    ADMIN_AUTH,
    deps(db, makeLlmStub({ tier: "x" as EvaluationTier }), () => `uuid-${++nonce}`),
  )
  assert.equal(second.correctionEventId, first.correctionEventId)
})

// ---------------------------------------------------------------------------
// Re-run on terminal row = SKIP
// ---------------------------------------------------------------------------

test("runAgentRanking — re-run on approved row is SKIP, not overwrite", async () => {
  const { db, store } = makeFakeFirestore()
  seedEvaluation(store, mkEvaluation({ candidateId: "cand-1" }))
  seedUser(store, "cand-1")
  const rid = await seedProposedRanking(store)
  // Approve first.
  await runApproveAgentTier(
    { resultId: rid },
    ADMIN_AUTH,
    deps(db, makeLlmStub({ tier: "x" as EvaluationTier })),
  )
  const callsRef = { count: 0 }
  const llm = makeLlmStub({ tier: "tier_3_general_email" }, callsRef)
  const result = await runAgentRanking(
    { evaluationRunId: "run-1" },
    ADMIN_AUTH,
    deps(db, llm),
  )
  assert.equal(result.skippedCount, 1)
  assert.equal(result.rankedCount, 0)
  assert.equal(callsRef.count, 0)
  const row = ensureCol(store, PA_COLLECTIONS.agentRankingResults).get(rid)!
  // Still approved with original tier (not overwritten).
  assert.equal(row.status, "approved")
  assert.equal(row.proposedAgentTier, "tier_2_personal_email")
})

// ---------------------------------------------------------------------------
// Parse failure on one candidate doesn't kill the batch
// ---------------------------------------------------------------------------

test("runAgentRanking — parse failure writes ledger row with error + skips candidate", async () => {
  const { db, store } = makeFakeFirestore()
  seedEvaluation(store, mkEvaluation({ candidateId: "cand-bad" }))
  seedEvaluation(store, mkEvaluation({ candidateId: "cand-good" }))
  seedUser(store, "cand-bad")
  seedUser(store, "cand-good")
  let call = 0
  const llm: RunWithOpenAIDep = async () => {
    call += 1
    if (call === 1) {
      return { text: "not valid json", usage: { promptTokens: 100, completionTokens: 5 } }
    }
    return {
      text: JSON.stringify({
        schemaVersion: AGENT_RANK_EXPECTED_SCHEMA_VERSION,
        proposedAgentTier: "tier_2_personal_email",
        agentRationale: "ok",
        agentRisks: [],
        agentRecommendedAction: "outreach_now",
      }),
      usage: { promptTokens: 100, completionTokens: 50 },
    }
  }
  const result = await runAgentRanking(
    { evaluationRunId: "run-1" },
    ADMIN_AUTH,
    deps(db, llm),
  )
  // One ranked, one skipped due to parse failure.
  assert.equal(result.rankedCount, 1)
  assert.ok(result.skippedCount >= 1)
  const toolCalls = Array.from(ensureCol(store, PA_COLLECTIONS.toolCalls).values())
  assert.equal(toolCalls.length, 2)
  // One ledger row has an error field.
  const errored = toolCalls.find(
    (t) => ((t.responseRedacted as Record<string, unknown>).error ?? null) !== null,
  )
  assert.ok(errored, "expected one ledger row with error")
  // And only the good candidate has a ranking row.
  assert.equal(ensureCol(store, PA_COLLECTIONS.agentRankingResults).size, 1)
})
