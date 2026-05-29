#!/usr/bin/env node
/**
 * Offline BOTH-DIRECTION ranking eval — precision@k / recall@k / NDCG@k.
 *
 * Closes the "ranking metrics, both directions" eval gap: the only prior
 * quantitative match signal was the weekly QA's binary `top3Acceptable`
 * (candidate→jobs only). This runner computes p@k / r@k / NDCG@k at k∈{3,5,10}
 * for BOTH directions against a versioned golden dataset:
 *
 *   - candidate → jobs:  drives the REAL `queryMatchingJobsV16` against an
 *                        in-memory Firestore seeded with the mock job corpus.
 *   - job → candidates:  drives the REAL `rankCandidatesForJob` (two-way-match)
 *                        over the mock candidate pool.
 *
 * Cost: $0. Deterministic. No LLM, no network — the rerank/jdrel caches are
 * simply absent (the matchers degrade gracefully: llmMatch=0, jdRel=1.0), so
 * the score is driven entirely by the deterministic hard filters + weighted
 * skill/industry/relevant-tag/salary blend.
 *
 * Usage:
 *   node apps/eval/ranking/run-ranking-eval.mjs            # report + pass/fail (informational, exit 0)
 *   node apps/eval/ranking/run-ranking-eval.mjs --strict   # exit 1 if any threshold fails (local gate)
 *   node apps/eval/ranking/run-ranking-eval.mjs --json     # machine-readable JSON report to stdout
 *
 * Grow the dataset: see apps/eval/ranking/README.md.
 *
 * @module run-ranking-eval
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { queryMatchingJobsV16, rankCandidatesForJob } from "@pa/job-rec"
import { MockFirestore, asFirestore } from "./mock-firestore.mjs"
import { metricsForQuery, aggregateMetrics, round4 } from "./metrics.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const GOLDENS = join(HERE, "goldens")

// Pinned "now" so the freshness window (firstSeenAt < 20d) is deterministic.
const NOW_MS = Date.parse("2026-05-29T12:00:00.000Z")
const FRESH_ISO = new Date(NOW_MS - 3 * 24 * 3600 * 1000).toISOString() // 3d old → fresh
const STALE_ISO = new Date(NOW_MS - 25 * 24 * 3600 * 1000).toISOString() // 25d old → stale

const KS = [3, 5, 10]

// Configurable pass/fail thresholds (macro-averaged over queries, per
// direction). Tuned to the current golden dataset + V16 behaviour with the
// caches absent. Override via env (e.g. PA_RANKING_MIN_PRECISION_3=0.5).
const THRESHOLDS = {
  precision: {
    3: numEnv("PA_RANKING_MIN_PRECISION_3", 0.45),
  },
  recall: {
    5: numEnv("PA_RANKING_MIN_RECALL_5", 0.9),
    10: numEnv("PA_RANKING_MIN_RECALL_10", 0.9),
  },
  ndcg: {
    3: numEnv("PA_RANKING_MIN_NDCG_3", 0.9),
    10: numEnv("PA_RANKING_MIN_NDCG_10", 0.9),
  },
}

function numEnv(key, fallback) {
  const raw = process.env[key]
  if (raw === undefined) return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

function loadJson(name) {
  return JSON.parse(readFileSync(join(GOLDENS, name), "utf8"))
}

function substituteFirstSeen(value) {
  if (value === "{{FRESH}}") return FRESH_ISO
  if (value === "{{STALE}}") return STALE_ISO
  return value
}

function hydrateJob(job) {
  return { ...job, firstSeenAt: substituteFirstSeen(job.firstSeenAt) }
}

// ---------------------------------------------------------------------------
// candidate → jobs (queryMatchingJobsV16 against in-memory corpus)
// ---------------------------------------------------------------------------

async function runCandidateToJobs() {
  const corpus = loadJson("corpus-jobs.json")
  const golden = loadJson("candidate-to-jobs.json")

  const perQuery = []
  const detail = []
  for (const q of golden.queries) {
    // Fresh store per query so previous-recommendation state never leaks.
    const mfs = new MockFirestore()
    for (const rawJob of corpus.jobs) {
      const job = hydrateJob(rawJob)
      await mfs.collection("matching-jobs").doc(job.id).set(job)
    }
    await mfs.collection("pa-users").doc(q.queryId).set({ tags: q.tags })

    const result = await queryMatchingJobsV16(
      { userId: q.queryId, nowMs: NOW_MS, limit: 10, lang: "en" },
      { db: asFirestore(mfs), includeEmbedding: false },
    )
    const ranked = result.jobs.map((j) => j.id)
    const m = metricsForQuery(ranked, q.relevantIds, KS)
    perQuery.push(m)
    detail.push({ queryId: q.queryId, displayName: q.displayName, ranked, relevantIds: q.relevantIds, metrics: m })
  }
  return { agg: aggregateMetrics(perQuery, KS), detail }
}

// ---------------------------------------------------------------------------
// job → candidates (rankCandidatesForJob over mock candidate pool)
// ---------------------------------------------------------------------------

function runJobToCandidates() {
  const corpus = loadJson("corpus-candidates.json")
  const golden = loadJson("job-to-candidates.json")
  const candidates = corpus.candidates

  const perQuery = []
  const detail = []
  for (const q of golden.queries) {
    const job = hydrateJob(q.job)
    const ranked = rankCandidatesForJob(job, candidates, { nowMs: NOW_MS })
    // The RETRIEVAL set = candidates that survive the deterministic hard
    // filters (`hardFilterResult !== "hard_block"`). Hard-blocked candidates
    // (role / location / visa mismatch, opted-out) are correctly suppressed
    // and must never count as a hit. We rank the survivors by `finalScore`
    // (the ranking signal `rankCandidatesForJob` already sorted on) rather
    // than by `recommendedAction`: the auto_outbound / hitl_review / do_not_
    // contact thresholds are calibrated for the LLM-PRESENT production path
    // (llmMatch carries 0.40 weight). In this offline $0 eval the LLM rerank
    // cache is absent (llmMatch=0), so an action-based cut would understate
    // recall — the *ordering* of survivors is what we measure here.
    const rankedIds = ranked
      .filter((r) => r.hardFilterResult !== "hard_block")
      .map((r) => r.candidateId)
    const m = metricsForQuery(rankedIds, q.relevantIds, KS)
    perQuery.push(m)
    detail.push({ queryId: q.queryId, ranked: rankedIds, relevantIds: q.relevantIds, metrics: m })
  }
  return { agg: aggregateMetrics(perQuery, KS), detail }
}

// ---------------------------------------------------------------------------
// thresholds + report
// ---------------------------------------------------------------------------

function checkThresholds(agg) {
  const failures = []
  for (const [metric, byK] of Object.entries(THRESHOLDS)) {
    for (const [k, min] of Object.entries(byK)) {
      const got = agg[metric]?.[k]
      if (typeof got !== "number") continue
      if (got + 1e-9 < min) {
        failures.push({ metric, k: Number(k), got: round4(got), min })
      }
    }
  }
  return failures
}

function fmtRow(label, byK) {
  const cells = KS.map((k) => `${label}@${k}=${round4(byK[k]).toFixed(4)}`)
  return "    " + cells.join("  ")
}

function printDirection(name, { agg, detail }) {
  console.log(`\n── ${name} ──  (${agg.queries} golden queries)`)
  console.log(fmtRow("P", agg.precision))
  console.log(fmtRow("R", agg.recall))
  console.log(fmtRow("NDCG", agg.ndcg))
  for (const d of detail) {
    const hits = d.ranked.filter((id) => d.relevantIds.includes(id))
    console.log(
      `    · ${d.queryId}: ranked[${d.ranked.length}] hits=${hits.length}/${d.relevantIds.length} ` +
        `NDCG@3=${round4(d.metrics.ndcg[3]).toFixed(3)}`,
    )
  }
}

async function main() {
  const args = new Set(process.argv.slice(2))
  const strict = args.has("--strict")
  const asJson = args.has("--json")

  const c2j = await runCandidateToJobs()
  const j2c = runJobToCandidates()

  const c2jFail = checkThresholds(c2j.agg)
  const j2cFail = checkThresholds(j2c.agg)
  const allFail = [
    ...c2jFail.map((f) => ({ direction: "candidate_to_jobs", ...f })),
    ...j2cFail.map((f) => ({ direction: "job_to_candidates", ...f })),
  ]

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          datasetVersion: "ranking-golden-2026-05-29",
          ks: KS,
          thresholds: THRESHOLDS,
          candidateToJobs: c2j.agg,
          jobToCandidates: j2c.agg,
          failures: allFail,
          pass: allFail.length === 0,
        },
        null,
        2,
      ),
    )
  } else {
    console.log("════════════════════════════════════════════════════════════")
    console.log("  Ranking eval — precision@k / recall@k / NDCG@k (both dirs)")
    console.log("  dataset: ranking-golden-2026-05-29   cost: $0   k ∈ {3,5,10}")
    console.log("════════════════════════════════════════════════════════════")
    printDirection("candidate → jobs  (queryMatchingJobsV16)", c2j)
    printDirection("job → candidates  (rankCandidatesForJob)", j2c)
    console.log("\n── thresholds ──")
    if (allFail.length === 0) {
      console.log("    ✔ all configured thresholds met")
    } else {
      for (const f of allFail) {
        console.log(`    ✗ ${f.direction} ${f.metric}@${f.k}: ${f.got} < min ${f.min}`)
      }
    }
    console.log(
      `\nRESULT: ${allFail.length === 0 ? "PASS" : "FAIL"}  ` +
        `(${allFail.length} threshold violation${allFail.length === 1 ? "" : "s"})` +
        `${strict ? "" : "  [informational — exit 0 unless --strict]"}`,
    )
  }

  if (strict && allFail.length > 0) process.exit(1)
}

main().catch((err) => {
  console.error("ranking-eval crashed:", err)
  process.exit(2)
})
