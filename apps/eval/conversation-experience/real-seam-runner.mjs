#!/usr/bin/env node
/**
 * REAL-SEAM SUITE — single entrypoint for the production-fidelity eval layer.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (the false-green problem)
 * ─────────────────────────────────────────
 * The P0 blocking predeploy gate is `runner.mjs` (the arbiter-decision canary).
 * It is a FALSE GREEN for the candidate journey: it grades a Firestore mock that
 * was pre-seeded by the fixture's own `extractor_simulated_patch` /
 * `matcher_simulated_result`. i.e. it SIMULATES the extractor's output and then
 * asserts the DB contains it — it never runs the real model, never drives the
 * real `maybeRunExtractor` seam, and so can pass while the same scenario FAILS on
 * the live phone (proof: `avoid-swe-after-onboarding.json` PASS/exit 0, while the
 * same case failed live).
 *
 * The REAL-SEAM runners DO drive production code (real `maybeRunExtractor` →
 * `applyPartialUserTags`; real `run(agent)` + the `find-match` connector; real
 * `PreScreenPipeline.runTurn`; real `SHARED_ONBOARDING_QUESTIONS`/`resolveNext`)
 * but they are scattered and NON-blocking. This runner is the single entrypoint
 * that runs them all + a new mid-onboarding capture fixture, and prints one
 * baseline scorecard. (Wiring it into firebase.json as the blocking gate is left
 * to the integrator.)
 *
 * WHAT IT RUNS
 * ────────────
 *   1. NEW in-process fixture: `mid-onboarding-out-of-slot-capture`
 *      Drives the EXACT production seam `maybeRunExtractor` with
 *      onboardingState=pending (the live-failure path) on a dense out-of-slot
 *      multi-fact message and asserts the durable store actually captured the
 *      facts. EXPECTED RED today (mid-onboarding short-circuits the extractor).
 *      RED here is the CORRECT baseline — it is the live phone bug, isolated.
 *      Marked `baseline_red:true` so it does NOT fail the suite (surfaces a
 *      surprise GREEN if a fix lands). The deterministic suite exit code is
 *      driven by the non-baseline_red real-seam runners below.
 *
 *   2. Sub-runners (real model / real reducers), each a child `node` process so
 *      a crash in one is isolated and reported, not silently swallowed:
 *        - agent-onboarding-canary.mjs   (scoped onboarding agent + reducer)
 *        - agent-jobsearch-canary.mjs    (run(agent) + find-match, post-reducer tags)
 *        - agent-prescreen-canary.mjs    (scoped prescreen agent + PreScreenPipeline)
 *        - llm-runner.mjs                (real maybeRunExtractor extraction + grader)
 *
 * NETWORK / KEYS: every sub-runner + the in-process fixture call a real model
 * (gpt-5.4-nano via OpenAI). Requires PA_OPENAI_AGENT_API_KEY / OPENAI_API_KEY in
 * the repo `.env` (auto-loaded; worktrees walk up to the main checkout). Without a
 * key the suite exits 2 (setup error) — it does NOT fake a pass.
 *
 * EXIT CODES
 * ──────────
 *   0  every non-baseline_red real-seam check passed (suite green)
 *   1  a non-baseline_red real-seam check FAILED (suite red — would block)
 *   2  setup error (no key, dist not built) — cannot run the real seam at all
 *
 * Run:  node apps/eval/conversation-experience/real-seam-runner.mjs
 */

import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { join, basename, dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { existsSync } from "node:fs"
import { repoRootFrom, loadDotEnv, runRealSeamFixtures } from "./harness-lib.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = repoRootFrom(import.meta.url)
const GRADER_MODEL = process.env.PA_AGENT_MODEL?.trim() || "gpt-5.4-nano"

// The in-process real-seam fixture engine (FirestoreStub + maybeRunExtractor
// drive loop + capture assertion) lives in harness-lib.mjs::runRealSeamFixtures
// so the BLOCKING predeploy gate (real-seam-gate.mjs) exercises the EXACT same
// code path this manual scorecard does.

// ────────────────────────────────────────────────────────────────────────
// Sub-runner orchestration (each in its own node process; capture exit code)
// ────────────────────────────────────────────────────────────────────────
function runChild(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(__dirname, file)], {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    let err = ""
    child.stdout.on("data", (d) => (out += d.toString()))
    child.stderr.on("data", (d) => (err += d.toString()))
    child.on("close", (code) => resolve({ file, code, out, err }))
    child.on("error", (e) => resolve({ file, code: 2, out, err: String(e?.message ?? e) }))
  })
}

const SUB_RUNNERS = [
  "agent-onboarding-canary.mjs",
  "agent-jobsearch-canary.mjs",
  "agent-prescreen-canary.mjs",
  "llm-runner.mjs",
]

function lastNonEmptyLines(text, n) {
  return text
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "")
    .slice(-n)
}

// ────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────
async function main() {
  loadDotEnv(REPO_ROOT)
  const key = (process.env.PA_OPENAI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY ?? "").trim()
  if (!key.startsWith("sk-")) {
    console.error("SETUP ERROR: no real OpenAI key (PA_OPENAI_AGENT_API_KEY / OPENAI_API_KEY) in .env — the real-seam suite calls a real model and will not fake a pass.")
    process.exit(2)
  }
  const distExtractor = join(REPO_ROOT, "packages", "pa-orchestrator", "dist", "conversation-extractor-runtime.js")
  if (!existsSync(distExtractor)) {
    console.error(`SETUP ERROR: build pa-orchestrator first (missing ${distExtractor}) — run \`pnpm -r build\` or \`pnpm --filter pa-orchestrator build\`.`)
    process.exit(2)
  }

  console.log("════════════════════════════════════════════════════════════════")
  console.log(" REAL-SEAM SUITE  (production code, real gpt-5.4-nano)")
  console.log(` model=${GRADER_MODEL}  repo=${REPO_ROOT}`)
  console.log("════════════════════════════════════════════════════════════════")

  // ── 1. in-process real-seam fixtures (mid-onboarding capture) ──
  const { maybeRunExtractor } = await import(pathToFileURL(distExtractor).href)
  console.log("\n── In-process real-seam fixtures (real maybeRunExtractor) ──")
  let fixtureResults = []
  try {
    fixtureResults = await runRealSeamFixtures(maybeRunExtractor, join(__dirname, "real-seam-fixtures"))
  } catch (err) {
    console.error(`  in-process fixtures crashed: ${err?.message ?? err}`)
    process.exit(2)
  }
  for (const r of fixtureResults) {
    const ranSummary = r.ranOutcomes.map((o) => `ran=${o.ran}${o.reason ? `(${o.reason})` : ""}`).join(", ")
    console.log(`\n  • ${r.name}  [onboardingState=${r.onboardingState}]`)
    console.log(`      seam outcome: ${ranSummary}`)
    console.log(`      final durable tags: ${JSON.stringify(r.finalTags)}`)
    if (r.gated) {
      if (r.baselineRed) console.log(`      ⚠ BASELINE NOW GREEN — expected-RED baseline captured the facts; a mid-onboarding capture fix may have landed (update/retire this fixture).`)
      else console.log(`      PASS (deterministic capture gate)`)
    } else if (r.baselineRed) {
      console.log(`      RED — expected baseline (advisory, does NOT block). The live-phone bug, isolated:`)
      for (const f of r.detFails) console.log(`        - ${f}`)
    } else {
      console.log(`      FAIL (deterministic capture gate):`)
      for (const f of r.detFails) console.log(`        - ${f}`)
    }
  }

  // ── 2. sub-runners (child processes) ──
  console.log("\n── Sub-runners (real model + real reducers, isolated processes) ──")
  const childResults = []
  for (const file of SUB_RUNNERS) {
    process.stdout.write(`  running ${file} ... `)
    const res = await runChild(file)
    childResults.push(res)
    console.log(res.code === 0 ? "GREEN (exit 0)" : `RED (exit ${res.code})`)
  }

  // ── 3. scorecard ──
  console.log("\n════════════════════════ BASELINE SCORECARD ════════════════════════")
  console.log("In-process fixtures:")
  for (const r of fixtureResults) {
    const verdict = r.gated ? (r.baselineRed ? "GREEN* (surprise — was baseline_red)" : "GREEN") : r.baselineRed ? "RED (expected baseline — advisory)" : "RED (BLOCKING)"
    const lastReason = r.ranOutcomes.length ? (r.ranOutcomes[r.ranOutcomes.length - 1].reason ?? "ran=true") : "n/a"
    console.log(`  ${verdict.padEnd(40)} ${r.name}  [seam: ${lastReason}]`)
  }
  console.log("Sub-runners:")
  for (const c of childResults) {
    console.log(`  ${(c.code === 0 ? "GREEN" : `RED (exit ${c.code})`).padEnd(40)} ${basename(c.file)}`)
  }

  // Determine blocking outcome: a non-baseline_red fixture RED, OR any sub-runner
  // non-zero exit, fails the suite. baseline_red fixtures never block.
  const fixtureBlocking = fixtureResults.filter((r) => !r.gated && !r.baselineRed)
  const childBlocking = childResults.filter((c) => c.code !== 0)

  // Surface the tail of any failing/crashed sub-runner so the receipt is self-contained.
  for (const c of childResults) {
    if (c.code !== 0) {
      console.log(`\n  --- tail of ${basename(c.file)} (exit ${c.code}) ---`)
      for (const l of lastNonEmptyLines(c.err || c.out, 8)) console.log(`    ${l}`)
    }
  }

  console.log("\n────────────────────────────────────────────────────────────────────")
  if (fixtureBlocking.length === 0 && childBlocking.length === 0) {
    console.log("REAL-SEAM SUITE GREEN — every non-baseline_red real-seam check passed.")
    if (fixtureResults.some((r) => r.baselineRed && !r.gated)) {
      console.log("(Advisory: a baseline_red fixture is RED as expected — the mid-onboarding capture gap is live and tracked.)")
    }
    process.exit(0)
  }
  console.error(`REAL-SEAM SUITE RED — ${fixtureBlocking.length} fixture + ${childBlocking.length} sub-runner blocking failure(s).`)
  process.exit(1)
}

main().catch((err) => {
  console.error("real-seam-runner crashed:", err)
  process.exit(2)
})
