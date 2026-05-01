// Phase 34 T4 follow-up — metric 3 (tone shift hit rate) baseline.
//
// Runs runVoiceJudge with VOICE_AXES_V2 on smoke fixtures + synthetic
// 50-turn corpus to lock metric 3 baseline.
//
// Metric 3 surrogate: strategy_fit axis ≥ 2 (on-set + stage-appropriate)
// = "Claire's strategy chosen matches user's emotional state". This is
// the closest V2 axis to "tone shift hit rate" per Phase 34 deferral note.
//
// Usage:
//   OPENAI_API_KEY=sk-... node .planning/phases/34-baseline-measurement/metric-3-baseline.mjs
//
// Cost: ~9 nano calls (3 smoke + 3 synthetic last-turn snapshots × 1 judge each).
// Estimated $0.05-$0.15 — well under $0.50-$2 ceiling per Adam approval.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { runVoiceJudge } from "../../../tests/scenarios/judge.mjs"
import { buildSyntheticCorpus } from "./synthetic-corpus.mjs"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..")
const SMOKE_FIXTURES = path.join(REPO_ROOT, "tests", "scenarios", "lib", "voice-axes-smoke-fixtures.json")
const RAW_RUNS_DIR = path.join(__dirname, "raw-runs")

function loadSmokeReplies() {
  const raw = JSON.parse(fs.readFileSync(SMOKE_FIXTURES, "utf-8"))
  return raw.fixtures.map((f) => {
    const lastTurn = f.turns[f.turns.length - 1]
    const transcript = f.turns
      .map((t) => `User: ${t.user}\nClaire: ${t.assistant}`)
      .join("\n\n")
    return {
      id: f.id,
      source: "smoke",
      reply: lastTurn.assistant,
      transcript,
    }
  })
}

function loadSyntheticReplies() {
  const corpus = buildSyntheticCorpus()
  return corpus.map((p) => {
    const lastTurn = p.turns[p.turns.length - 1]
    const transcript = p.turns
      .slice(-5)
      .map((t) => `User: ${t.user}\nClaire: ${t.assistant}`)
      .join("\n\n")
    return {
      id: p.id,
      source: "synthetic_50turn_lastN",
      reply: lastTurn.assistant,
      transcript,
    }
  })
}

async function scoreOne(item) {
  const result = await runVoiceJudge({
    reply: item.reply,
    transcript: item.transcript,
    useV2Axes: true,
    skipAutofail: false,
    metadata: { source: item.source, id: item.id },
  })
  return {
    id: item.id,
    source: item.source,
    axes: result.axes,
    average: result.average,
    pass: result.pass,
    autoFail: result.autoFail ?? null,
    costUsd: result.costUsd,
    axesVersion: result.axesVersion,
  }
}

function aggregate(rows) {
  const valid = rows.filter((r) => r.axes && !r.autoFail)
  const strategy_fit_scores = valid
    .map((r) => r.axes.strategy_fit)
    .filter((v) => typeof v === "number")
  const hitRate =
    strategy_fit_scores.length > 0
      ? strategy_fit_scores.filter((s) => s >= 2).length / strategy_fit_scores.length
      : null
  return {
    n_total: rows.length,
    n_valid: valid.length,
    strategy_fit_scores,
    hit_rate_at_2: hitRate,
    target_70pct: hitRate !== null ? hitRate >= 0.7 : null,
    total_cost_usd: rows.reduce((s, r) => s + (r.costUsd ?? 0), 0),
    sample_axes: valid.slice(0, 3).map((r) => ({ id: r.id, axes: r.axes })),
  }
}

async function main() {
  if (!process.env.OPENAI_API_KEY && !process.env.PA_OPENAI_AGENT_API_KEY) {
    console.error("ERROR: OPENAI_API_KEY (or PA_OPENAI_AGENT_API_KEY) required for V2 judge.")
    process.exit(1)
  }
  const items = [...loadSmokeReplies(), ...loadSyntheticReplies()]
  console.log(`Scoring ${items.length} samples (smoke=${items.filter((i) => i.source === "smoke").length}, synthetic=${items.filter((i) => i.source !== "smoke").length})...`)

  const rows = []
  for (const item of items) {
    process.stderr.write(`▶ ${item.id} ... `)
    try {
      const r = await scoreOne(item)
      rows.push(r)
      process.stderr.write(`strat=${r.axes?.strategy_fit ?? "n/a"} avg=${r.average?.toFixed(2) ?? "n/a"}${r.autoFail ? " AUTOFAIL:" + r.autoFail : ""}\n`)
    } catch (err) {
      process.stderr.write(`ERROR: ${err.message ?? err}\n`)
      rows.push({ id: item.id, source: item.source, error: String(err.message ?? err) })
    }
  }

  const agg = aggregate(rows)

  if (!fs.existsSync(RAW_RUNS_DIR)) fs.mkdirSync(RAW_RUNS_DIR, { recursive: true })
  fs.writeFileSync(
    path.join(RAW_RUNS_DIR, "metric-3-per-scenario.json"),
    JSON.stringify(rows, null, 2)
  )
  fs.writeFileSync(
    path.join(RAW_RUNS_DIR, "metric-3-aggregate.json"),
    JSON.stringify(agg, null, 2)
  )

  console.log("\n=== METRIC 3 BASELINE (strategy_fit ≥ 2) ===")
  console.log(`n_total=${agg.n_total}, n_valid=${agg.n_valid}`)
  console.log(`strategy_fit scores: [${agg.strategy_fit_scores.join(", ")}]`)
  console.log(`hit rate @ ≥2: ${agg.hit_rate_at_2 !== null ? (agg.hit_rate_at_2 * 100).toFixed(1) + "%" : "N/A"}`)
  console.log(`target 70%: ${agg.target_70pct === null ? "N/A" : agg.target_70pct ? "✅ PASS" : "❌ FAIL"}`)
  console.log(`total cost: $${agg.total_cost_usd.toFixed(4)}`)
}

main().catch((e) => {
  console.error("metric-3-baseline FAILED:", e)
  process.exit(1)
})
