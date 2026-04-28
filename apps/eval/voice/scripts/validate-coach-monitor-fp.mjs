#!/usr/bin/env node
/**
 * Phase 24 T1D — false-positive validation.
 *
 * Acceptance per 24-CONTEXT.md: FP rate on golden-50 clean (PASS) replies < 5%.
 *
 * Prerequisites:
 *   1. Build orchestrator: `cd packages/pa-orchestrator && pnpm build`
 *   2. Ensure apps/eval/voice/fixtures/golden-50.jsonl exists with ≥10 PASS cases
 *
 * Usage:
 *   node apps/eval/voice/scripts/validate-coach-monitor-fp.mjs
 *
 * Exit 0 = FP rate < 5% (or deferred due to insufficient data)
 * Exit 1 = FP rate ≥ 5%
 */
import { readFileSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { resolve, dirname } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, "../../../../")

const fixturesPath = resolve(repoRoot, "apps/eval/voice/fixtures/golden-50.jsonl")
const distPath = resolve(repoRoot, "packages/pa-orchestrator/dist/voice/coach-token-monitor.js")

// --- Guard: fixture file must exist ---
if (!existsSync(fixturesPath)) {
  console.log("INFO: apps/eval/voice/fixtures/golden-50.jsonl not found.")
  console.log("FP validation deferred — no golden-50.jsonl available.")
  console.log("Gate: re-run after plan 02 populates golden-50 with ≥10 PASS cases.")
  process.exit(0)
}

// --- Guard: built dist must exist ---
if (!existsSync(distPath)) {
  console.error("ERROR: packages/pa-orchestrator/dist/voice/coach-token-monitor.js not found.")
  console.error("Run: cd packages/pa-orchestrator && pnpm build")
  process.exit(1)
}

// Dynamic import from built dist
const { detectCoachTokens } = await import(distPath)

const rawLines = readFileSync(fixturesPath, "utf8").split("\n").filter(Boolean)
const cases = rawLines.map((l) => JSON.parse(l))
const passes = cases.filter((c) => c.label === "PASS")

if (passes.length < 10) {
  console.log(`INFO: Only ${passes.length} PASS cases found (need ≥10).`)
  console.log("FP validation deferred — insufficient PASS data.")
  console.log("Gate: re-run after plan 02 populates golden-50 with ≥10 PASS cases.")
  process.exit(0)
}

let fpCount = 0
for (const c of passes) {
  // Use last assistant turn as the reply being tested
  const turns = c.turns ?? c.context ?? []
  const lastAssistant = [...turns].reverse().find((t) => t.role === "assistant")
  if (!lastAssistant) continue
  const hits = detectCoachTokens(lastAssistant.content)
  if (hits.length > 0) {
    console.log(`FP: ${c.id} — hits:`, JSON.stringify(hits))
    fpCount++
  }
}

const rate = fpCount / passes.length
console.log(
  `Golden PASS cases: ${passes.length}, FP: ${fpCount}, rate: ${(rate * 100).toFixed(1)}%`
)

if (rate < 0.05) {
  console.log("PASS — FP rate < 5%")
  process.exit(0)
} else {
  console.log("FAIL — FP rate ≥ 5%. Review FP cases above and tighten regex if needed.")
  process.exit(1)
}
