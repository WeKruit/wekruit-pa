/**
 * v2.0 External Supply V2 — Wave E (F) — source-quality.ts tests.
 *
 * Covers:
 *  - computeMonthlyRollup math (acceptance / override rates).
 *  - Zero approvals + nonzero overrides → row still emitted.
 *  - Zero ranking rows for a source → null (not emitted).
 *  - Missing batch lookup → row skipped + warning logged.
 *  - Idempotent overwrite — same input produces same body.
 *  - createSourceQualityMetricId determinism.
 */

import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"

import {
  createSourceQualityMetricId,
  type AgentRankingResult,
  type ExternalSource,
} from "@pa/core-types"

import {
  ROLLUP_SOURCES,
  computeMonthlyRollup,
  priorMonthWindow,
  writeMonthlyRollup,
  type MonthlyRollupBySource,
} from "./source-quality.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW_ISO = "2026-05-13T08:00:00.000Z"

function mkRow(
  partial: Partial<AgentRankingResult> & {
    candidateRecordId: string
    status: AgentRankingResult["status"]
  }
): AgentRankingResult {
  const base: AgentRankingResult = {
    resultId: `result-${partial.candidateRecordId}-${partial.status}`,
    evaluationRunId: "run-1",
    candidateRecordId: partial.candidateRecordId,
    candidateUserId: undefined,
    companyId: "co-1",
    jobId: "job-1",
    deterministicTier: "tier_2_personal_email",
    proposedAgentTier: "tier_2_personal_email",
    agentRationale: "rationale",
    agentRisks: [],
    agentRecommendedAction: "retain_warm",
    ensembleVotes: [],
    modelUsed: "stub-model",
    ensembleSize: 1,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
    dryRun: false,
    promptVersion: "prompt-test",
    status: partial.status,
    createdAt: NOW_ISO,
  }
  return { ...base, ...partial } as AgentRankingResult
}

// ---------------------------------------------------------------------------
// computeMonthlyRollup
// ---------------------------------------------------------------------------

test("computeMonthlyRollup — 8 approved + 2 overridden for juicebox", () => {
  const rows: AgentRankingResult[] = []
  for (let i = 0; i < 8; i++) {
    rows.push(mkRow({ candidateRecordId: `rec-app-${i}`, status: "approved" }))
  }
  for (let i = 0; i < 2; i++) {
    rows.push(mkRow({ candidateRecordId: `rec-over-${i}`, status: "overridden" }))
  }
  const recordToBatch = new Map<string, string>()
  for (const r of rows) recordToBatch.set(r.candidateRecordId, "batch-A")
  const batchToSource = new Map<string, ExternalSource>([["batch-A", "juicebox"]])

  const out = computeMonthlyRollup({
    agentRankingRows: rows,
    batchIdToSource: batchToSource,
    candidateRecordIdToBatchId: recordToBatch,
    yyyyMm: "2026-04",
  })

  const juicebox = out.juicebox
  assert.ok(juicebox, "juicebox row must be emitted")
  assert.equal(juicebox.agentRankedTotal, 10)
  assert.equal(juicebox.agentApprovedUnchangedTotal, 8)
  assert.equal(juicebox.agentOverriddenTotal, 2)
  assert.equal(juicebox.agentTierAcceptanceRate, 0.8)
  assert.equal(juicebox.agentOperatorOverrideRate, 0.2)

  // Other sources stay null.
  for (const src of ROLLUP_SOURCES) {
    if (src === "juicebox") continue
    assert.equal(out[src], null, `${src} should be null`)
  }
})

test("computeMonthlyRollup — zero approvals + 3 overrides → row still emitted", () => {
  const rows: AgentRankingResult[] = [
    mkRow({ candidateRecordId: "rec-1", status: "overridden" }),
    mkRow({ candidateRecordId: "rec-2", status: "overridden" }),
    mkRow({ candidateRecordId: "rec-3", status: "overridden" }),
  ]
  const recordToBatch = new Map<string, string>(
    rows.map((r) => [r.candidateRecordId, "batch-L"])
  )
  const batchToSource = new Map<string, ExternalSource>([["batch-L", "lessie"]])

  const out = computeMonthlyRollup({
    agentRankingRows: rows,
    batchIdToSource: batchToSource,
    candidateRecordIdToBatchId: recordToBatch,
    yyyyMm: "2026-04",
  })

  const lessie = out.lessie
  assert.ok(lessie, "lessie row must be emitted")
  assert.equal(lessie.agentRankedTotal, 3)
  assert.equal(lessie.agentApprovedUnchangedTotal, 0)
  assert.equal(lessie.agentOverriddenTotal, 3)
  assert.equal(lessie.agentTierAcceptanceRate, 0)
  assert.equal(lessie.agentOperatorOverrideRate, 1)
})

test("computeMonthlyRollup — zero ranking rows for a source → row not emitted", () => {
  const out = computeMonthlyRollup({
    agentRankingRows: [],
    batchIdToSource: new Map(),
    candidateRecordIdToBatchId: new Map(),
    yyyyMm: "2026-04",
  })
  for (const src of ROLLUP_SOURCES) {
    assert.equal(out[src], null, `${src} should be null`)
  }
})

test("computeMonthlyRollup — missing batch lookup → row skipped", () => {
  // Two ranking rows; only one has a resolvable record→batch→source chain.
  const rows: AgentRankingResult[] = [
    mkRow({ candidateRecordId: "rec-known", status: "approved" }),
    mkRow({ candidateRecordId: "rec-orphan", status: "overridden" }),
  ]
  const recordToBatch = new Map<string, string>([["rec-known", "batch-K"]])
  const batchToSource = new Map<string, ExternalSource>([
    ["batch-K", "coresignal"],
  ])

  const out = computeMonthlyRollup({
    agentRankingRows: rows,
    batchIdToSource: batchToSource,
    candidateRecordIdToBatchId: recordToBatch,
    yyyyMm: "2026-04",
  })
  const coresignal = out.coresignal
  assert.ok(coresignal)
  // Orphan row excluded from the bucket entirely.
  assert.equal(coresignal.agentRankedTotal, 1)
  assert.equal(coresignal.agentApprovedUnchangedTotal, 1)
  assert.equal(coresignal.agentOverriddenTotal, 0)
})

test("computeMonthlyRollup — costTableVersion copied from first stamped row", () => {
  const rows: AgentRankingResult[] = [
    mkRow({ candidateRecordId: "rec-1", status: "approved" }),
    {
      ...mkRow({ candidateRecordId: "rec-2", status: "overridden" }),
      // Stamp costTableVersion as a passthrough field (Wave D writes it onto
      // the doc body alongside the schema-validated AgentRankingResult).
      costTableVersion: "pricing-2026-05-A",
    } as AgentRankingResult & { costTableVersion: string },
  ]
  const recordToBatch = new Map<string, string>(
    rows.map((r) => [r.candidateRecordId, "batch-M"])
  )
  const batchToSource = new Map<string, ExternalSource>([
    ["batch-M", "manual_csv"],
  ])
  const out = computeMonthlyRollup({
    agentRankingRows: rows,
    batchIdToSource: batchToSource,
    candidateRecordIdToBatchId: recordToBatch,
    yyyyMm: "2026-04",
  })
  assert.equal(out.manual_csv?.costTableVersion, "pricing-2026-05-A")
})

// ---------------------------------------------------------------------------
// createSourceQualityMetricId
// ---------------------------------------------------------------------------

test("createSourceQualityMetricId — deterministic doc id", () => {
  assert.equal(createSourceQualityMetricId("juicebox", "2026-05"), "juicebox__2026-05")
  assert.equal(
    createSourceQualityMetricId("juicebox", "2026-05"),
    createSourceQualityMetricId("juicebox", "2026-05"),
    "repeat calls match",
  )
  assert.notEqual(
    createSourceQualityMetricId("juicebox", "2026-05"),
    createSourceQualityMetricId("lessie", "2026-05"),
  )
})

// ---------------------------------------------------------------------------
// priorMonthWindow
// ---------------------------------------------------------------------------

test("priorMonthWindow — May 1 → April window", () => {
  const w = priorMonthWindow(new Date("2026-05-01T08:00:00.000Z"))
  assert.equal(w.yyyyMm, "2026-04")
  assert.equal(w.startIso, "2026-04-01T00:00:00.000Z")
  assert.equal(w.endIso, "2026-05-01T00:00:00.000Z")
})

test("priorMonthWindow — January wraps to prior December", () => {
  const w = priorMonthWindow(new Date("2026-01-01T08:00:00.000Z"))
  assert.equal(w.yyyyMm, "2025-12")
  assert.equal(w.startIso, "2025-12-01T00:00:00.000Z")
  assert.equal(w.endIso, "2026-01-01T00:00:00.000Z")
})

// ---------------------------------------------------------------------------
// writeMonthlyRollup — idempotent overwrite via fake Firestore
// ---------------------------------------------------------------------------

type FakeStore = Map<string, Map<string, Record<string, unknown>>>

function ensureCol(store: FakeStore, name: string) {
  if (!store.has(name)) store.set(name, new Map())
  return store.get(name)!
}

function makeFakeFirestore(): { db: Firestore; store: FakeStore; setCalls: number } {
  const store: FakeStore = new Map()
  const ctx = { setCalls: 0 }
  function collection(name: string) {
    return {
      doc(id: string) {
        return {
          id,
          async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
            ctx.setCalls++
            const col = ensureCol(store, name)
            const current = col.get(id)
            col.set(
              id,
              opts?.merge && current ? { ...current, ...data } : { ...data }
            )
          },
        }
      },
    }
  }
  return {
    db: { collection } as unknown as Firestore,
    store,
    get setCalls() {
      return ctx.setCalls
    },
  } as unknown as { db: Firestore; store: FakeStore; setCalls: number }
}

test("writeMonthlyRollup — idempotent overwrite preserves V1 fields", async () => {
  const fake = makeFakeFirestore()
  // Seed a V1 row to simulate existing replyRate/bounceRate.
  ensureCol(fake.store, "pa-source-quality-metrics").set(
    createSourceQualityMetricId("juicebox", "2026-04"),
    { replyRate: 0.42, bounceRate: 0.03, validRate: 0.95 }
  )

  const rollup: MonthlyRollupBySource = {
    juicebox: {
      source: "juicebox",
      yyyyMm: "2026-04",
      agentRankedTotal: 10,
      agentApprovedUnchangedTotal: 8,
      agentOverriddenTotal: 2,
      agentTierAcceptanceRate: 0.8,
      agentOperatorOverrideRate: 0.2,
      costTableVersion: "pricing-2026-05-A",
    },
    lessie: null,
    coresignal: null,
    manual_csv: null,
  }

  const first = await writeMonthlyRollup(fake.db, "2026-04", rollup, {
    now: () => NOW_ISO,
  })
  assert.equal(first.written, 1)
  assert.equal(first.skipped, 3)

  const docId = createSourceQualityMetricId("juicebox", "2026-04")
  const merged = ensureCol(fake.store, "pa-source-quality-metrics").get(docId)!
  // V1 fields preserved.
  assert.equal(merged.replyRate, 0.42)
  assert.equal(merged.bounceRate, 0.03)
  assert.equal(merged.validRate, 0.95)
  // V2 fields written.
  assert.equal(merged.agentRankedTotal, 10)
  assert.equal(merged.agentTierAcceptanceRate, 0.8)
  assert.equal(merged.agentOperatorOverrideRate, 0.2)
  assert.equal(merged.costTableVersion, "pricing-2026-05-A")

  // Re-run produces identical V2 body.
  const second = await writeMonthlyRollup(fake.db, "2026-04", rollup, {
    now: () => NOW_ISO,
  })
  assert.equal(second.written, 1)
  const reread = ensureCol(fake.store, "pa-source-quality-metrics").get(docId)!
  assert.equal(reread.agentRankedTotal, 10)
  assert.equal(reread.replyRate, 0.42, "V1 fields still preserved on re-run")
})
