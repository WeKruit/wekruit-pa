// Phase 34 — baseline-runner.mjs
//
// Runs deterministic axes from VOICE_AXES_V2 over a 3-source corpus:
// 1. Smoke fixtures (3 hand-curated samples — current rev sample)
// 2. Existing scenario YAML expected_assistant blobs (~25 scenarios)
// 3. Synthetic 50-turn chains (3 personas × 50 turns)
//
// Output:
// - raw-runs/per-scenario.json: every scenario, every axis, raw values
// - raw-runs/aggregate.json: distributions per axis (mean/p50/p95/min/max)
//
// No LLM cost. No network (advice_novelty embed half degrades to null
// when BGE_API_KEY missing — captured + flagged in output).

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  FILLER_BLACKLIST_ZH,
  FILLER_BLACKLIST_EN,
  computeLengthCompliance,
  computeMirrorRatio,
  computeDriftScore,
  computeAdviceNovelty,
  inferStrategy,
  stageForTurn,
} from "../../../tests/scenarios/lib/voice-axes.mjs"
import { buildSyntheticCorpus } from "./synthetic-corpus.mjs"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..")
const SCENARIOS_DIR = path.join(REPO_ROOT, "tests", "scenarios", "scenarios")
const SMOKE_FIXTURES = path.join(REPO_ROOT, "tests", "scenarios", "lib", "voice-axes-smoke-fixtures.json")
const RAW_RUNS_DIR = path.join(__dirname, "raw-runs")

const ALL_BLACKLIST = [...FILLER_BLACKLIST_ZH, ...FILLER_BLACKLIST_EN]

function aiTelltaleHits(text) {
  if (typeof text !== "string") return 0
  let hits = 0
  for (const phrase of ALL_BLACKLIST) {
    if (text.includes(phrase)) hits += 1
  }
  return hits
}

function loadSmokeFixtures() {
  const raw = JSON.parse(fs.readFileSync(SMOKE_FIXTURES, "utf-8"))
  return raw.fixtures.map((f) => ({
    id: f.id,
    source: "smoke",
    turns: f.turns,
  }))
}

// NOTE: scenario YAMLs are TEST DEFINITIONS (user prompts + asserts on
// expected reply behavior), NOT transcripts. To get real Claire turns
// for those, would need to run scenarios live against orchestrator
// (LLM cost). Deferred to follow-up T4 — Adam approval required for spend.
// Baseline corpus = smoke fixtures + synthetic 50-turn chains.
function loadScenarioCorpus() {
  return []
}

function loadSyntheticCorpus() {
  return buildSyntheticCorpus().map((p) => ({
    id: p.id,
    source: "synthetic_50turn",
    turns: p.turns,
  }))
}

function pct(num, total) {
  return total === 0 ? 0 : (num / total) * 100
}

function p50p95(values) {
  if (values.length === 0) return { p50: 0, p95: 0, min: 0, max: 0, mean: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const mean = values.reduce((s, v) => s + v, 0) / values.length
  return {
    mean,
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    min: sorted[0],
    max: sorted[sorted.length - 1],
  }
}

async function scoreScenario(scenario) {
  const turns = scenario.turns
  if (turns.length === 0) return null

  // Metric 1: AI tell-tale rate — % assistant turns containing any blacklist phrase
  let telltaleTurns = 0
  for (const t of turns) {
    if (aiTelltaleHits(t.assistant ?? "") > 0) telltaleTurns += 1
  }
  const aiTelltaleRate = pct(telltaleTurns, turns.length)

  // Metric 2: 50-turn drift score (mirror-only without network)
  const drift = await computeDriftScore(turns, { window: 50 })

  // Metric 3: tone shift hit rate (preview — strategy classification only, full requires labeled corpus)
  const strategies = []
  for (let i = 0; i < turns.length; i += 1) {
    strategies.push(inferStrategy(turns[i].assistant ?? ""))
  }

  // Metric 4: length compliance
  const lengthCompliance = computeLengthCompliance(turns, { cap: 3 })

  // Metric 5: repeat advice rate (text-only fallback if no embed)
  // Use Jaccard on word-level n-grams as a no-network proxy.
  let repeatAdviceProxy = 0
  for (let i = 1; i < turns.length; i += 1) {
    const cur = turns[i].assistant ?? ""
    const prior = turns
      .slice(Math.max(0, i - 3), i)
      .map((t) => t.assistant ?? "")
      .filter(Boolean)
    if (prior.length === 0 || !cur) continue
    const ratios = prior.map((p) => computeMirrorRatio(p, cur))
    const max = Math.max(...ratios)
    if (max >= 0.5) repeatAdviceProxy += 1
  }
  const repeatAdviceRate = pct(repeatAdviceProxy, Math.max(1, turns.length - 1))

  // Optional: advice_novelty via embed (network-required, graceful degrade)
  let adviceNoveltyEmbed = null
  if (process.env.BGE_API_KEY || process.env.PA_SILICONFLOW_API_KEY) {
    try {
      const samples = []
      for (let i = 1; i < turns.length; i += 1) {
        const cur = turns[i].assistant ?? ""
        const prior = turns
          .slice(Math.max(0, i - 3), i)
          .map((t) => t.assistant ?? "")
          .filter(Boolean)
        if (prior.length === 0 || !cur) continue
        const r = await computeAdviceNovelty(cur, prior)
        if (r && typeof r.maxSim === "number") samples.push(r.maxSim)
      }
      adviceNoveltyEmbed = samples.length > 0 ? p50p95(samples) : null
    } catch {
      adviceNoveltyEmbed = null
    }
  }

  return {
    id: scenario.id,
    source: scenario.source,
    turn_count: turns.length,
    ai_telltale_rate: aiTelltaleRate,
    ai_telltale_hits: telltaleTurns,
    drift_score: drift.driftScore,
    drift_mirror_max: drift.mirrorMax,
    drift_mirror_avg: drift.mirrorAvg,
    drift_repeat_max: drift.repeatMax,
    length_compliance: lengthCompliance.compliance,
    length_within_cap: lengthCompliance.withinCap,
    length_total: lengthCompliance.total,
    length_over_cap_idx: lengthCompliance.overCapTurns,
    repeat_advice_rate_proxy: repeatAdviceRate,
    advice_novelty_embed: adviceNoveltyEmbed,
    strategies,
  }
}

function aggregate(scenarios) {
  const allRows = scenarios.filter(Boolean)
  return {
    n_scenarios: allRows.length,
    n_turns_total: allRows.reduce((s, r) => s + r.turn_count, 0),
    metrics: {
      ai_telltale_rate: p50p95(allRows.map((r) => r.ai_telltale_rate)),
      drift_score: p50p95(allRows.map((r) => r.drift_score)),
      drift_mirror_max: p50p95(allRows.map((r) => r.drift_mirror_max)),
      drift_mirror_avg: p50p95(allRows.map((r) => r.drift_mirror_avg)),
      length_compliance: p50p95(allRows.map((r) => r.length_compliance)),
      repeat_advice_rate_proxy: p50p95(allRows.map((r) => r.repeat_advice_rate_proxy)),
    },
    by_source: {
      smoke: allRows.filter((r) => r.source === "smoke").length,
      scenario_yaml: allRows.filter((r) => r.source === "scenario_yaml").length,
      synthetic_50turn: allRows.filter((r) => r.source === "synthetic_50turn").length,
    },
    embed_axis_present: allRows.some((r) => r.advice_novelty_embed !== null),
  }
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes("--dry-run")

  const corpus = [
    ...loadSmokeFixtures(),
    ...loadScenarioCorpus(),
    ...loadSyntheticCorpus(),
  ]
  console.log(`Corpus: ${corpus.length} scenarios`)
  console.log(`  smoke: ${corpus.filter((c) => c.source === "smoke").length}`)
  console.log(`  scenario_yaml: ${corpus.filter((c) => c.source === "scenario_yaml").length}`)
  console.log(`  synthetic_50turn: ${corpus.filter((c) => c.source === "synthetic_50turn").length}`)
  console.log(`Total turns: ${corpus.reduce((s, c) => s + c.turns.length, 0)}`)

  if (dryRun) {
    console.log("Dry-run — exiting before scoring.")
    return
  }

  if (!fs.existsSync(RAW_RUNS_DIR)) fs.mkdirSync(RAW_RUNS_DIR, { recursive: true })

  console.log("Scoring scenarios...")
  const rows = []
  for (const scenario of corpus) {
    const r = await scoreScenario(scenario)
    if (r) rows.push(r)
  }
  console.log(`Scored ${rows.length} / ${corpus.length}`)

  const agg = aggregate(rows)

  fs.writeFileSync(
    path.join(RAW_RUNS_DIR, "per-scenario.json"),
    JSON.stringify(rows, null, 2)
  )
  fs.writeFileSync(
    path.join(RAW_RUNS_DIR, "aggregate.json"),
    JSON.stringify(agg, null, 2)
  )

  console.log("\n=== AGGREGATE ===")
  console.log(JSON.stringify(agg, null, 2))
}

main().catch((e) => {
  console.error("baseline-runner FAILED:", e)
  process.exit(1)
})
