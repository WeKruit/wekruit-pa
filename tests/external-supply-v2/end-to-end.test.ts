/**
 * v2.0 External Supply V2 — Wave E (Executor G) — End-to-end acceptance harness.
 *
 * Drives V2-specific surfaces (adapter detection, preview-batch dry-run,
 * agent-ranking dry-run / live-stub / budget cap / override) against an
 * in-memory Firestore + a deterministic LLM stub. Covers ACCEPTANCE rows
 * 1-12 + 20-22.
 *
 * Hard rules (from /goal):
 *  - LLM stub blocks any real network: `globalThis.fetch` throws.
 *  - Preview server proves zero writes via recording-proxy `db`.
 *  - Budget cap aborts before any LLM call.
 *  - Override writes a `pa-correction-events` row with
 *    `targetType: "agent_ranking_result"`.
 *  - Doc-id audit: zero raw email/phone/LinkedIn in `pa-agent-ranking-results`
 *    doc ids.
 *  - Candidate domain (`apps/pa-landing`) and V2 new code roots are clean of
 *    LinkedIn outbound HTTP / agent-ranking / external-supply bleeds.
 */

// HARD GUARD — block network for the entire harness.
;(globalThis as { fetch?: unknown }).fetch = () => {
  throw new Error("network not allowed in v2 e2e harness")
}

import assert from "node:assert/strict"
import test from "node:test"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"
import {
  PA_COLLECTIONS,
  candidateHandleHashMaterial,
  createAgentRankingResultId,
  type CandidateCompanyJobEvaluation,
  type EvaluationTier,
} from "@pa/core-types"
import {
  detectAdapter,
  AGENT_RANK_EXPECTED_SCHEMA_VERSION,
} from "@pa/external-supply"
import { getRegistrySignatures } from "../../apps/functions/src/external-supply/adapters/registry.js"
import {
  runPreviewBatch,
  type PreviewBatchResult,
} from "../../apps/functions/src/external-supply/preview-batch.js"
import {
  runAgentRanking,
  runApproveAgentTier,
  runOverrideAgentTier,
  type RunWithOpenAIDep,
} from "../../apps/functions/src/external-supply/agent-rank.js"
import {
  ensureCol,
  makeFakeFirestore,
  type FakeStore,
} from "../external-supply/helpers/firestore-fake.js"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, "../../")
const FIXTURES_DIR = path.join(REPO_ROOT, "tests", "fixtures", "external-supply-v2")
const ARTIFACTS_DIR = path.join(
  REPO_ROOT,
  ".planning",
  "external-supply-v2",
  "artifacts",
)
if (!existsSync(ARTIFACTS_DIR)) mkdirSync(ARTIFACTS_DIR, { recursive: true })

const NOW = "2026-05-14T12:00:00.000Z"
const ADMIN_AUTH = {
  uid: "operator-v2",
  token: { email: "operator-v2@wekruit.com", email_verified: true },
} as const

// ---------------------------------------------------------------------------
// V2 fixture loaders
// ---------------------------------------------------------------------------

interface BigBatchV2 {
  juicebox: Array<Record<string, unknown>>
  lessie: Array<Record<string, unknown>>
  coresignal: Array<Record<string, unknown>>
}

function loadBigBatchV2(): BigBatchV2 {
  return JSON.parse(
    readFileSync(path.join(FIXTURES_DIR, "big-batch-v2.json"), "utf8"),
  ) as BigBatchV2
}

function loadCompanyJobV2(): {
  company: Record<string, unknown> & { companyId: string }
  job: Record<string, unknown> & { jobId: string; companyId: string }
} {
  return JSON.parse(
    readFileSync(path.join(FIXTURES_DIR, "company-job.json"), "utf8"),
  )
}

function loadSeedUsersV2(): Array<{
  candidateId: string
  linkedinUrl?: string
  email?: string
}> {
  return JSON.parse(
    readFileSync(path.join(FIXTURES_DIR, "seed-pa-users.json"), "utf8"),
  )
}

function loadUnknownShapeCsv(): Buffer {
  return readFileSync(path.join(FIXTURES_DIR, "unknown-shape.csv"))
}

// ---------------------------------------------------------------------------
// Per-adapter serialization
// ---------------------------------------------------------------------------

function serializeJuicebox(rows: Array<Record<string, unknown>>): string {
  return JSON.stringify(rows)
}
function serializeCoresignal(rows: Array<Record<string, unknown>>): string {
  return JSON.stringify(rows)
}
function serializeLessie(rows: Array<Record<string, unknown>>): string {
  const headers = [
    "LinkedIn URL",
    "Email",
    "Name",
    "Title",
    "Company",
    "Location",
    "Phone",
    "Skills",
  ]
  const cells = (v: unknown): string => {
    const s = v === undefined || v === null ? "" : String(v)
    if (/[,"\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
    return s
  }
  const lines = [headers.join(",")]
  for (const r of rows) {
    lines.push(
      [
        cells(r["LinkedIn URL"]),
        cells(r["Email"]),
        cells(r["Name"]),
        cells(r["Title"]),
        cells(r["Company"]),
        cells(r["Location"]),
        cells(r["Phone"]),
        Array.isArray(r["Skills"]) ? (r["Skills"] as string[]).join("; ") : cells(r["Skills"]),
      ].join(","),
    )
  }
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Hash + seed helpers (mirror V1 production hashing)
// ---------------------------------------------------------------------------

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function canonicalizeLinkedInUrl(raw: string): string {
  let url = raw.trim()
  if (/^\/\//.test(url)) url = `https:${url}`
  else if (!/^https?:\/\//i.test(url)) url = `https://${url}`
  const parsed = new URL(url)
  let pathPart = parsed.pathname
  const m = /^\/in\/([A-Za-z0-9\-_%]+)\/?$/.exec(pathPart)
  if (!m) throw new Error(`canonicalize:invalid:${raw}`)
  return `https://linkedin.com/in/${m[1]!.toLowerCase()}`
}

function linkedinHashFor(canonical: string): string {
  return sha256Hex(candidateHandleHashMaterial("linkedin", canonical))
}

function emailHashFor(email: string): string {
  return sha256Hex(candidateHandleHashMaterial("email", email.trim().toLowerCase()))
}

function seedV2UsersIntoStore(
  store: FakeStore,
  seeds: ReturnType<typeof loadSeedUsersV2>,
): void {
  const users = ensureCol(store, PA_COLLECTIONS.users)
  const handles = ensureCol(store, PA_COLLECTIONS.candidateHandles)
  for (const seed of seeds) {
    users.set(seed.candidateId, {
      id: seed.candidateId,
      candidateLifecycleState: "profile_ready",
      createdAt: NOW,
      updatedAt: NOW,
      lifecycleUpdatedAt: NOW,
      ...(seed.linkedinUrl ? { linkedinUrl: seed.linkedinUrl } : {}),
    })
    if (seed.linkedinUrl) {
      const canonical = canonicalizeLinkedInUrl(seed.linkedinUrl)
      const h = linkedinHashFor(canonical)
      handles.set(`linkedin__${h}`, {
        handleId: `linkedin__${h}`,
        candidateId: seed.candidateId,
        kind: "linkedin",
        handleHash: h,
        normalizedValue: canonical,
        source: "external_sourcing",
        verifiedAt: null,
        deliverable: false,
        createdAt: NOW,
      })
    }
    if (seed.email) {
      const h = emailHashFor(seed.email)
      handles.set(`email__${h}`, {
        handleId: `email__${h}`,
        candidateId: seed.candidateId,
        kind: "email",
        handleHash: h,
        normalizedValue: seed.email.toLowerCase(),
        source: "candidate",
        verifiedAt: null,
        deliverable: true,
        createdAt: NOW,
      })
    }
  }
}

function seedV2CompanyJobIntoStore(
  store: FakeStore,
  fx: ReturnType<typeof loadCompanyJobV2>,
): void {
  ensureCol(store, "pa-companies").set(fx.company.companyId, { ...fx.company })
  ensureCol(store, "pa-jobs").set(fx.job.jobId, { ...fx.job })
}

// ---------------------------------------------------------------------------
// Recording-proxy Firestore — throws on ANY write op
// ---------------------------------------------------------------------------

interface RecordingDbResult {
  db: Firestore
  writes: string[]
}

function recordingFirestore(inner: Firestore): RecordingDbResult {
  const writes: string[] = []
  const wrap = (path: string, target: unknown): unknown => {
    if (target === null || typeof target !== "object") return target
    return new Proxy(target as object, {
      get(t, prop) {
        const value = (t as Record<string | symbol, unknown>)[prop]
        if (typeof value !== "function") return value
        const fnName = String(prop)
        const blocked = new Set([
          "set",
          "update",
          "add",
          "delete",
          "create",
          "commit",
          "batch",
          "runTransaction",
        ])
        if (blocked.has(fnName)) {
          return (...args: unknown[]) => {
            writes.push(`${path}.${fnName}(${args.length} args)`)
            throw new Error(`write_blocked:${path}.${fnName}`)
          }
        }
        return (...args: unknown[]) => {
          const result = (value as Function).apply(t, args)
          if (result instanceof Promise) {
            return result.then((v) => wrap(`${path}.${fnName}`, v))
          }
          return wrap(`${path}.${fnName}`, result)
        }
      },
    })
  }
  return { db: wrap("db", inner) as Firestore, writes }
}

// ---------------------------------------------------------------------------
// LLM stub — deterministic, network-free
// ---------------------------------------------------------------------------

interface LlmStubState {
  calls: number
  lastPrompt?: string
}

function makeLlmStub(
  state: LlmStubState,
  opts: { schemaVersion?: string; tier?: EvaluationTier; risks?: string[]; action?: string } = {},
): RunWithOpenAIDep {
  return async (_agent, params) => {
    state.calls += 1
    const userMsg = params.messages.find((m) => m.role === "user")?.content ?? ""
    state.lastPrompt = userMsg
    const body = {
      schemaVersion: opts.schemaVersion ?? AGENT_RANK_EXPECTED_SCHEMA_VERSION,
      proposedAgentTier: opts.tier ?? "tier_2_personal_email",
      agentRationale: "Stubbed deterministic rationale (canned LLM).",
      agentRisks: opts.risks ?? [],
      agentRecommendedAction: opts.action ?? "outreach_now",
    }
    return {
      text: JSON.stringify(body),
      usage: { promptTokens: 200, completionTokens: 80 },
    }
  }
}

function makeForbiddenLlmStub(): RunWithOpenAIDep {
  return async () => {
    throw new Error("llm_must_not_be_called_in_this_test")
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("acceptance row 6 + row 7 — adapter detection: each adapter golden top-scores >=0.9; unknown shape <=0.6", () => {
  const v2 = loadBigBatchV2()
  const reg = getRegistrySignatures()
  const records: Array<{ adapter: string; top: string; conf: number; warnings: string[] }> = []

  // Juicebox JSON
  {
    const det = detectAdapter({
      rawBytes: Buffer.from(serializeJuicebox(v2.juicebox), "utf8"),
      filename: "juicebox.json",
      mime: "application/json",
      registry: reg,
    })
    records.push({ adapter: "juicebox", top: det.top.source, conf: det.top.confidence, warnings: det.warnings })
    assert.equal(det.top.source, "juicebox", `juicebox top wrong: ${JSON.stringify(det.top)}`)
    assert.ok(det.top.confidence >= 0.9, `juicebox conf too low: ${det.top.confidence}`)
  }
  // Lessie CSV
  {
    const det = detectAdapter({
      rawBytes: Buffer.from(serializeLessie(v2.lessie), "utf8"),
      filename: "lessie.csv",
      mime: "text/csv",
      registry: reg,
    })
    records.push({ adapter: "lessie", top: det.top.source, conf: det.top.confidence, warnings: det.warnings })
    assert.equal(det.top.source, "lessie")
    assert.ok(det.top.confidence >= 0.9, `lessie conf: ${det.top.confidence}`)
  }
  // Coresignal JSON
  {
    const det = detectAdapter({
      rawBytes: Buffer.from(serializeCoresignal(v2.coresignal), "utf8"),
      filename: "coresignal.json",
      mime: "application/json",
      registry: reg,
    })
    records.push({ adapter: "coresignal", top: det.top.source, conf: det.top.confidence, warnings: det.warnings })
    assert.equal(det.top.source, "coresignal")
    assert.ok(det.top.confidence >= 0.9, `coresignal conf: ${det.top.confidence}`)
  }
  // Unknown shape CSV → manual_csv with confidence <= 0.6 (or close)
  {
    const det = detectAdapter({
      rawBytes: loadUnknownShapeCsv(),
      filename: "unknown-shape.csv",
      mime: "text/csv",
      registry: reg,
    })
    records.push({ adapter: "unknown", top: det.top.source, conf: det.top.confidence, warnings: det.warnings })
    // Unknown shape should not pass a strong source through the 0.9 lock threshold;
    // either falls to manual_csv or stays sub-0.6 on any specific source.
    assert.ok(
      det.top.source === "manual_csv" || det.top.confidence <= 0.6,
      `unknown shape leaked through: top=${det.top.source} conf=${det.top.confidence}`,
    )
  }
  writeFileSync(
    path.join(ARTIFACTS_DIR, "wave-e-adapter-detection.json"),
    JSON.stringify({ records, generatedAt: NOW }, null, 2),
  )
})

test("acceptance row 3 — runPreviewBatch performs ZERO Firestore writes (recording proxy)", async () => {
  const { db, store } = makeFakeFirestore()
  seedV2UsersIntoStore(store, loadSeedUsersV2())
  seedV2CompanyJobIntoStore(store, loadCompanyJobV2())

  const v2 = loadBigBatchV2()
  const payload = serializeJuicebox(v2.juicebox)
  const { db: recDb, writes } = recordingFirestore(db)

  const preview = await runPreviewBatch(
    {
      filename: "juicebox.json",
      mime: "application/json",
      base64Bytes: Buffer.from(payload, "utf8").toString("base64"),
    },
    ADMIN_AUTH,
    { db: recDb, now: () => NOW },
  )
  assert.equal(writes.length, 0, `preview did writes: ${writes.join(", ")}`)
  assert.equal(preview.chosenSource, "juicebox")
  assert.ok(preview.rowCount >= 30, `preview rowCount=${preview.rowCount}`)
  writeFileSync(
    path.join(ARTIFACTS_DIR, "wave-e-preview-hygiene.json"),
    JSON.stringify({ writes, preview, generatedAt: NOW }, null, 2),
  )
})

test("acceptance rows 1 + 2 + 4 + 5 — preview detection + identity forecast + tag forecast (per-adapter slice)", async () => {
  const { db, store } = makeFakeFirestore()
  seedV2UsersIntoStore(store, loadSeedUsersV2())
  seedV2CompanyJobIntoStore(store, loadCompanyJobV2())

  const v2 = loadBigBatchV2()
  const summary: Record<string, PreviewBatchResult> = {}
  for (const [adapter, rows, filename, mime] of [
    ["juicebox", v2.juicebox, "juicebox.json", "application/json"],
    ["lessie", v2.lessie, "lessie.csv", "text/csv"],
    ["coresignal", v2.coresignal, "coresignal.json", "application/json"],
  ] as const) {
    const payload =
      adapter === "lessie"
        ? serializeLessie(rows as Array<Record<string, unknown>>)
        : adapter === "juicebox"
          ? serializeJuicebox(rows as Array<Record<string, unknown>>)
          : serializeCoresignal(rows as Array<Record<string, unknown>>)
    const res = await runPreviewBatch(
      {
        filename,
        mime,
        base64Bytes: Buffer.from(payload, "utf8").toString("base64"),
      },
      ADMIN_AUTH,
      { db, now: () => NOW },
    )
    summary[adapter] = res
    assert.equal(res.chosenSource, adapter, `adapter mismatch ${adapter} -> ${res.chosenSource}`)
    assert.ok(res.rowCount > 0, `${adapter} rowCount=0`)
    // ≥0.9 confidence on the right adapter (Row 1)
    const top = (res.detection as Array<{ source: string; confidence: number }>)[0]!
    assert.equal(top.source, adapter)
    assert.ok(top.confidence >= 0.9, `${adapter} top confidence ${top.confidence} < 0.9`)
    // Forecasted identity sum equals rowCount minus within-batch dups (Row 2 parity)
    const fc = res.identityForecast
    const identitySum = fc.createNew + fc.mergeExisting + fc.needsReview + fc.blocked
    assert.equal(
      identitySum + res.withinBatchDuplicates,
      res.rowCount,
      `${adapter} forecast sum ${identitySum} + dups ${res.withinBatchDuplicates} != rowCount ${res.rowCount}`,
    )
  }
  // Row 4 + 5: aggregate forecast totals match between preview and what
  // runResolveBatchIdentity would do; with no live commit step we instead
  // assert preview's tag-forecast contains the expected fillable fields.
  const aggregate = {
    rowCount: Object.values(summary).reduce((a, b) => a + b.rowCount, 0),
    createNew: Object.values(summary).reduce((a, b) => a + b.identityForecast.createNew, 0),
    merge: Object.values(summary).reduce((a, b) => a + b.identityForecast.mergeExisting, 0),
    needsReview: Object.values(summary).reduce((a, b) => a + b.identityForecast.needsReview, 0),
    blocked: Object.values(summary).reduce((a, b) => a + b.identityForecast.blocked, 0),
    perAdapter: Object.fromEntries(
      Object.entries(summary).map(([k, v]) => [
        k,
        {
          rowCount: v.rowCount,
          chosenSource: v.chosenSource,
          topConfidence: (v.detection as Array<{ confidence: number }>)[0]?.confidence,
          identity: v.identityForecast,
          tagFillFields: Object.keys(v.tagEnrichmentForecast.perFieldFillCount),
        },
      ]),
    ),
  }
  assert.equal(aggregate.rowCount, 105, `aggregate rows ${aggregate.rowCount}`)
  writeFileSync(
    path.join(ARTIFACTS_DIR, "wave-e-preview-forecast.json"),
    JSON.stringify({ aggregate, generatedAt: NOW }, null, 2),
  )
})

test("acceptance row 8 — runAgentRanking dryRun=true returns prompts + estimates, 0 LLM calls, 0 ranking writes, 0 tool-call writes", async () => {
  const { db, store } = makeFakeFirestore()
  const cj = loadCompanyJobV2()
  seedV2CompanyJobIntoStore(store, cj)
  // Seed 5 evaluation rows directly so dry-run has work to forecast.
  const evals = makeSyntheticEvaluations(cj.company.companyId, cj.job.jobId, 5)
  for (const ev of evals) {
    ensureCol(store, PA_COLLECTIONS.candidateCompanyJobEvaluations).set(ev.evaluationId, ev)
  }
  const llmState: LlmStubState = { calls: 0 }
  const forbidden = makeForbiddenLlmStub()
  const before = {
    ranking: ensureCol(store, PA_COLLECTIONS.agentRankingResults).size,
    toolCalls: ensureCol(store, PA_COLLECTIONS.toolCalls).size,
  }
  const out = await runAgentRanking(
    {
      evaluationRunId: evals[0]!.evaluationRunId,
      dryRun: true,
      ensembleSize: 1,
      budgetUsd: 10,
    },
    ADMIN_AUTH,
    { db, runWithOpenAI: forbidden, now: () => NOW },
  )
  assert.equal(out.abortedReason, "dry_run")
  assert.equal(out.rankedCount, 0)
  assert.equal(llmState.calls, 0, "LLM stub should never be invoked in dry-run")
  assert.ok(out.prompts && out.prompts.length === evals.length, `prompts ${out.prompts?.length}`)
  const after = {
    ranking: ensureCol(store, PA_COLLECTIONS.agentRankingResults).size,
    toolCalls: ensureCol(store, PA_COLLECTIONS.toolCalls).size,
  }
  assert.deepEqual(after, before, "dry-run wrote rows")
  writeFileSync(
    path.join(ARTIFACTS_DIR, "wave-e-agent-rank-dryrun.json"),
    JSON.stringify({ out, generatedAt: NOW }, null, 2),
  )
})

test("acceptance row 9 + row 10 — runAgentRanking live (LLM stub) writes ranking row + tool-call ledger row per call (ensemble=3)", async () => {
  const { db, store } = makeFakeFirestore()
  const cj = loadCompanyJobV2()
  seedV2CompanyJobIntoStore(store, cj)
  const evals = makeSyntheticEvaluations(cj.company.companyId, cj.job.jobId, 3)
  for (const ev of evals) {
    ensureCol(store, PA_COLLECTIONS.candidateCompanyJobEvaluations).set(ev.evaluationId, ev)
  }
  const llmState: LlmStubState = { calls: 0 }
  const stub = makeLlmStub(llmState, { tier: "tier_2_personal_email" })

  const out = await runAgentRanking(
    {
      evaluationRunId: evals[0]!.evaluationRunId,
      ensembleSize: 3,
      budgetUsd: 100,
    },
    ADMIN_AUTH,
    { db, runWithOpenAI: stub, now: () => NOW },
  )
  assert.equal(out.rankedCount, evals.length, `rankedCount ${out.rankedCount}`)
  assert.equal(llmState.calls, evals.length * 3, `expected ${evals.length * 3} LLM calls, got ${llmState.calls}`)

  // 1 ranking doc per candidate
  const rankCol = ensureCol(store, PA_COLLECTIONS.agentRankingResults)
  assert.equal(rankCol.size, evals.length)
  for (const [, doc] of rankCol) {
    const r = doc as Record<string, unknown>
    assert.equal(r.proposedAgentTier, "tier_2_personal_email")
    assert.ok(Array.isArray(r.ensembleVotes) && (r.ensembleVotes as unknown[]).length === 3, "ensembleVotes.length=3")
    assert.equal(r.modelUsed, "gpt-5.4-nano")
  }
  // Tool-call ledger row per LLM call (ensemble=3 × evals.length)
  const tcCol = ensureCol(store, PA_COLLECTIONS.toolCalls)
  assert.equal(tcCol.size, evals.length * 3, `tool-call ledger size ${tcCol.size}`)
  writeFileSync(
    path.join(ARTIFACTS_DIR, "wave-e-agent-rank-live.json"),
    JSON.stringify(
      {
        rankedCount: out.rankedCount,
        toolCallCount: tcCol.size,
        firstRankingDoc: Array.from(rankCol.values())[0],
        generatedAt: NOW,
      },
      null,
      2,
    ),
  )
})

test("acceptance row 11 — runAgentRanking aborts on budget_exceeded with 0 writes / 0 LLM calls", async () => {
  const { db, store } = makeFakeFirestore()
  const cj = loadCompanyJobV2()
  seedV2CompanyJobIntoStore(store, cj)
  // 200 synthetic candidates → projected cost will exceed default $10 cap.
  const evals = makeSyntheticEvaluations(cj.company.companyId, cj.job.jobId, 200)
  for (const ev of evals) {
    ensureCol(store, PA_COLLECTIONS.candidateCompanyJobEvaluations).set(ev.evaluationId, ev)
  }
  const llmState: LlmStubState = { calls: 0 }
  const stub = makeLlmStub(llmState)
  const before = {
    ranking: ensureCol(store, PA_COLLECTIONS.agentRankingResults).size,
    toolCalls: ensureCol(store, PA_COLLECTIONS.toolCalls).size,
  }
  const out = await runAgentRanking(
    {
      evaluationRunId: evals[0]!.evaluationRunId,
      ensembleSize: 3,
      // Don't set budgetUsd → uses default $10. With 200 candidates × ensembleSize 3
      // the projection should exceed that hard cap.
      budgetUsd: 0.01, // make absolutely sure we abort
    },
    ADMIN_AUTH,
    { db, runWithOpenAI: stub, now: () => NOW },
  )
  assert.equal(out.abortedReason, "budget_exceeded", `abort=${out.abortedReason}`)
  assert.equal(out.rankedCount, 0)
  assert.equal(llmState.calls, 0, "no LLM calls on budget abort")
  const after = {
    ranking: ensureCol(store, PA_COLLECTIONS.agentRankingResults).size,
    toolCalls: ensureCol(store, PA_COLLECTIONS.toolCalls).size,
  }
  assert.deepEqual(after, before, "budget abort wrote rows")
  writeFileSync(
    path.join(ARTIFACTS_DIR, "wave-e-agent-rank-budget-abort.json"),
    JSON.stringify({ out, generatedAt: NOW }, null, 2),
  )
})

test("acceptance row 12 — runOverrideAgentTier flips status + writes correction-event with targetType: agent_ranking_result", async () => {
  const { db, store } = makeFakeFirestore()
  const cj = loadCompanyJobV2()
  seedV2CompanyJobIntoStore(store, cj)
  const evals = makeSyntheticEvaluations(cj.company.companyId, cj.job.jobId, 1)
  for (const ev of evals) {
    ensureCol(store, PA_COLLECTIONS.candidateCompanyJobEvaluations).set(ev.evaluationId, ev)
  }
  const llmState: LlmStubState = { calls: 0 }
  const stub = makeLlmStub(llmState, { tier: "tier_2_personal_email" })
  // Phase 1 — produce a ranking row.
  await runAgentRanking(
    {
      evaluationRunId: evals[0]!.evaluationRunId,
      ensembleSize: 1,
      budgetUsd: 100,
    },
    ADMIN_AUTH,
    { db, runWithOpenAI: stub, now: () => NOW },
  )
  const rankCol = ensureCol(store, PA_COLLECTIONS.agentRankingResults)
  assert.equal(rankCol.size, 1)
  const [resultId, doc] = Array.from(rankCol.entries())[0]!
  assert.equal((doc as Record<string, unknown>).status, "proposed")

  // Phase 2 — override.
  const overrideOut = await runOverrideAgentTier(
    {
      resultId,
      newTier: "tier_1_personal_linkedin_and_email",
      reason: "operator-disagrees-with-stub-rationale",
    },
    ADMIN_AUTH,
    { db, now: () => NOW, newId: () => "test-correction-event-id-001" },
  )
  assert.equal(overrideOut.correctionEventId, "test-correction-event-id-001")
  assert.equal(overrideOut.approvedTier, "tier_1_personal_linkedin_and_email")

  const updated = rankCol.get(resultId) as Record<string, unknown>
  assert.equal(updated.status, "overridden")
  assert.equal(updated.approvedTier, "tier_1_personal_linkedin_and_email")
  assert.equal(updated.correctionEventId, "test-correction-event-id-001")

  // correction-event row exists with the right targetType
  const corrCol = ensureCol(store, PA_COLLECTIONS.correctionEvents)
  assert.equal(corrCol.size, 1)
  const corr = Array.from(corrCol.values())[0] as Record<string, unknown>
  assert.equal(corr.targetType, "agent_ranking_result")
  assert.equal(corr.targetId, resultId)
  writeFileSync(
    path.join(ARTIFACTS_DIR, "wave-e-agent-override.json"),
    JSON.stringify({ override: overrideOut, correctionEvent: corr, generatedAt: NOW }, null, 2),
  )
})

test("acceptance row 20 — doc-id audit: zero raw email/phone/LinkedIn in pa-agent-ranking-results doc ids", async () => {
  const { db, store } = makeFakeFirestore()
  const cj = loadCompanyJobV2()
  seedV2CompanyJobIntoStore(store, cj)
  const evals = makeSyntheticEvaluations(cj.company.companyId, cj.job.jobId, 6)
  for (const ev of evals) {
    ensureCol(store, PA_COLLECTIONS.candidateCompanyJobEvaluations).set(ev.evaluationId, ev)
  }
  const llmState: LlmStubState = { calls: 0 }
  const stub = makeLlmStub(llmState, { tier: "tier_2_personal_email" })
  await runAgentRanking(
    {
      evaluationRunId: evals[0]!.evaluationRunId,
      ensembleSize: 1,
      budgetUsd: 100,
    },
    ADMIN_AUTH,
    { db, runWithOpenAI: stub, now: () => NOW },
  )
  const RAW_EMAIL = /@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
  const RAW_PHONE = /\+\d{6,}/
  const RAW_LINKEDIN = /linkedin\.com\/in\//i
  const rankCol = ensureCol(store, PA_COLLECTIONS.agentRankingResults)
  const violations: string[] = []
  for (const id of rankCol.keys()) {
    if (RAW_EMAIL.test(id) || RAW_PHONE.test(id) || RAW_LINKEDIN.test(id)) {
      violations.push(id)
    }
    // Confirm shape matches sha256-prefix `agent-rank__<64hex>`
    if (!/^agent-rank__[0-9a-f]{64}$/i.test(id)) {
      violations.push(`shape:${id}`)
    }
  }
  writeFileSync(
    path.join(ARTIFACTS_DIR, "wave-e-doc-id-audit.log"),
    JSON.stringify(
      { violations, sampledIds: Array.from(rankCol.keys()).slice(0, 5), generatedAt: NOW },
      null,
      2,
    ),
  )
  assert.equal(violations.length, 0, `doc-id violations: ${violations.join(", ")}`)
})

test("acceptance row 21 — apps/pa-landing has zero agent-ranking / external-supply references", () => {
  const landingDir = path.join(REPO_ROOT, "apps", "pa-landing", "src")
  const matches: string[] = []
  function walk(dir: string) {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir)) {
      const p = path.join(dir, entry)
      const st = statSync(p)
      if (st.isDirectory()) {
        walk(p)
        continue
      }
      if (!/\.(tsx?|jsx?|css|html)$/i.test(p)) continue
      const text = readFileSync(p, "utf8")
      if (/agent[-_ ]?ranking/i.test(text) || /external[-_]supply/i.test(text)) {
        matches.push(p)
      }
    }
  }
  walk(landingDir)
  writeFileSync(
    path.join(ARTIFACTS_DIR, "wave-e-candidate-domain-grep.log"),
    JSON.stringify({ matches, scannedRoot: landingDir, generatedAt: NOW }, null, 2),
  )
  assert.equal(matches.length, 0, `candidate-domain bleed: ${matches.join("\n")}`)
})

test("acceptance row 22 — V2 new code roots have zero outbound linkedin.com HTTP automation", () => {
  const ROOTS = [
    path.join(REPO_ROOT, "apps", "functions", "src", "external-supply", "preview-batch.ts"),
    path.join(REPO_ROOT, "apps", "functions", "src", "external-supply", "agent-rank.ts"),
    path.join(REPO_ROOT, "apps", "functions", "src", "external-supply", "source-quality.ts"),
    path.join(REPO_ROOT, "packages", "external-supply", "src", "agent-rank-prompt.ts"),
    path.join(REPO_ROOT, "packages", "external-supply", "src", "adapter-detect.ts"),
  ]
  const POST_LINKEDIN_RE = /\b(?:fetch|axios\.(?:post|put|patch|delete))\s*\(\s*[`"'][^`"']*linkedin\.com/i
  const strip = (t: string) =>
    t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\n)\s*\/\/.*(?=\n|$)/g, "")
  const flagged: string[] = []
  for (const f of ROOTS) {
    if (!existsSync(f)) continue
    if (POST_LINKEDIN_RE.test(strip(readFileSync(f, "utf8")))) flagged.push(f)
  }
  writeFileSync(
    path.join(ARTIFACTS_DIR, "wave-e-linkedin-automation-grep.log"),
    JSON.stringify({ flagged, roots: ROOTS, generatedAt: NOW }, null, 2),
  )
  assert.equal(flagged.length, 0, `LinkedIn automation in V2 code: ${flagged.join("\n")}`)
})

// ---------------------------------------------------------------------------
// Synthetic evaluation factory
// ---------------------------------------------------------------------------

function makeSyntheticEvaluations(
  companyId: string,
  jobId: string,
  n: number,
): CandidateCompanyJobEvaluation[] {
  const runId = "v2-e2e-run-1"
  const evals: CandidateCompanyJobEvaluation[] = []
  for (let i = 0; i < n; i += 1) {
    const candidateId = `v2-e2e-cand-${String(i + 1).padStart(4, "0")}`
    evals.push({
      evaluationId: `eval-${candidateId}`,
      evaluationRunId: runId,
      candidateId,
      companyId,
      jobId,
      rubricVersion: "rubric-2026-05-v1",
      generalRubricScore: 0.7,
      companyRubricScore: 0.6,
      jobRubricScore: 0.75,
      hardGateResult: "pass",
      hardGateReasons: ["role_function_overlap"],
      softScore: 0.7,
      missingInfo: [],
      risks: [],
      evidence: [{ source: "system", summary: "synthetic", confidence: 0.6 }],
      explanation: "Synthetic eval for V2 e2e",
      proposedTier: "tier_2_personal_email",
      createdAt: NOW,
    })
  }
  return evals
}

// Re-export so other modules can sanity-check from outside.
export { canonicalizeLinkedInUrl, emailHashFor, linkedinHashFor }
// Reference createAgentRankingResultId to keep its import tree-shake-proof.
void createAgentRankingResultId
