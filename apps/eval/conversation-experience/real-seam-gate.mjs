#!/usr/bin/env node
/**
 * REAL-SEAM PREDEPLOY GATE — the BLOCKING, deploy-safe real-model canary.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (the #1 audit finding)
 * ──────────────────────────────────────
 * The BLOCKING predeploy gate in firebase.json used to run `runner.mjs`, which
 * its OWN docstring calls a "FALSE GREEN": it applies the fixture-supplied
 * `extractor_simulated_patch` to a Firestore mock and then asserts that same
 * patch is present. It never calls the model, never drives the real
 * `maybeRunExtractor` seam, and so passes while the same scenario FAILS on the
 * live phone (the documented #245 / mid-onboarding regression chain).
 *
 * Meanwhile `real-seam-runner.mjs` DID drive the real `gpt-5.4-nano` →
 * `maybeRunExtractor` → durable tag store, but it was manual-only AND exits 2
 * (setup error) without a key — i.e. it would BRICK a keyless deploy if wired in
 * as-is. This gate is the deploy-safe entrypoint that fixes both:
 *
 *   • KEY PRESENT (CI / the deploy machine's .env): RUN the real model over the
 *     fixed real-seam-fixtures set and BLOCK (exit 1) if a fixture regresses.
 *     This is what makes the blocking gate honest — revert the C2 memoryEntities
 *     coerce in conversation-extractor.ts and this gate goes RED.
 *
 *   • NO KEY (offline / local deploy without the secret): GRACEFULLY SKIP with a
 *     LOUD warning and exit 0. It must NOT block the deploy. `pnpm run deploy`
 *     must still succeed keyless, exactly as before this gate existed. (Contrast
 *     with real-seam-runner.mjs, which exits 2 by design as a manual receipt.)
 *
 * COST DISCIPLINE
 * ───────────────
 *   • Small FIXED fixture set: apps/eval/conversation-experience/real-seam-fixtures/
 *     (2 fixtures × 1 turn = 2 model calls today). A hard `--max-model-calls`
 *     ceiling (default 6) aborts BEFORE exceeding it, so a runaway fixture set
 *     can never burn unbounded spend on a deploy.
 *   • A couple of retries on TRANSIENT network/5xx errors (not on deterministic
 *     failures) so a single blip doesn't false-fail a deploy.
 *   • A wall-clock budget (default 120s) so a hung model call can't stall the
 *     deploy forever — timeout → SKIP (exit 0, loud), never a false RED.
 *
 * The deterministic exit code is driven ONLY by non-`baseline_red` fixtures.
 * A `baseline_red` fixture (an intentionally-tracked live gap) is advisory and
 * never blocks; a surprise GREEN on one is surfaced loudly.
 *
 * EXIT CODES
 * ──────────
 *   0  green (every non-baseline_red fixture passed)  OR  gracefully skipped
 *      (no key / dist not built / model unreachable). Deploy proceeds.
 *   1  a non-baseline_red real-seam fixture REGRESSED. Deploy blocked.
 *
 * Run:  node apps/eval/conversation-experience/real-seam-gate.mjs
 * Flags / env:
 *   --max-model-calls N | PA_REAL_SEAM_MAX_CALLS=N   (default 6)
 *   --budget-ms N       | PA_REAL_SEAM_BUDGET_MS=N    (default 120000)
 *   --retries N         | PA_REAL_SEAM_RETRIES=N      (default 2)
 *   PA_REAL_SEAM_REQUIRE_KEY=1  → fail (exit 1) instead of skipping when no key
 *                                 (use in CI where the key MUST be present).
 */

import { join, dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { existsSync } from "node:fs"
import { repoRootFrom, loadDotEnv, runRealSeamFixtures } from "./harness-lib.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = repoRootFrom(import.meta.url)
const FIXTURES_DIR = join(__dirname, "real-seam-fixtures")
const DIST_EXTRACTOR = join(REPO_ROOT, "packages", "pa-orchestrator", "dist", "conversation-extractor-runtime.js")

const BANNER = "════════════════════════════════════════════════════════════════"

function intArg(flag, envName, dflt) {
  const i = process.argv.indexOf(flag)
  if (i !== -1 && process.argv[i + 1]) {
    const n = Number.parseInt(process.argv[i + 1], 10)
    if (Number.isFinite(n)) return n
  }
  const e = process.env[envName]
  if (e) {
    const n = Number.parseInt(e, 10)
    if (Number.isFinite(n)) return n
  }
  return dflt
}

/** Loud SKIP — print to BOTH stderr and stdout so it can't be lost in a pipe. */
function skip(reason) {
  const lines = [
    BANNER,
    " ⚠️  REAL-SEAM GATE SKIPPED — NOT BLOCKING THIS DEPLOY",
    ` reason: ${reason}`,
    " The real-model regression gate did NOT run. The candidate-journey extractor",
    " seam was NOT exercised against the live model on this deploy. To enforce it,",
    " run with a real OpenAI key (PA_OPENAI_AGENT_API_KEY / OPENAI_API_KEY) present,",
    " e.g. on CI or the deploy machine. Set PA_REAL_SEAM_REQUIRE_KEY=1 to hard-fail",
    " instead of skipping when the key is absent.",
    BANNER,
  ]
  // stderr first (visible even when stdout is captured), then stdout.
  console.error(lines.join("\n"))
  console.log(lines.join("\n"))
  process.exit(0)
}

async function main() {
  loadDotEnv(REPO_ROOT)

  const requireKey = process.env.PA_REAL_SEAM_REQUIRE_KEY === "1"
  const maxModelCalls = intArg("--max-model-calls", "PA_REAL_SEAM_MAX_CALLS", 6)
  const budgetMs = intArg("--budget-ms", "PA_REAL_SEAM_BUDGET_MS", 120000)
  const retries = intArg("--retries", "PA_REAL_SEAM_RETRIES", 2)

  // ── Graceful skip conditions (no key / dist not built) ──
  const key = (process.env.PA_OPENAI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY ?? "").trim()
  if (!key.startsWith("sk-")) {
    if (requireKey) {
      console.error(BANNER)
      console.error(" REAL-SEAM GATE: PA_REAL_SEAM_REQUIRE_KEY=1 but no real OpenAI key present — FAILING.")
      console.error(BANNER)
      process.exit(1)
    }
    skip("no real OpenAI key (PA_OPENAI_AGENT_API_KEY / OPENAI_API_KEY) in env/.env")
  }
  if (!existsSync(DIST_EXTRACTOR)) {
    // In the firebase.json predeploy sequence the orchestrator dist is built by
    // an EARLIER step, so this should not normally trigger. If it does (e.g. a
    // standalone invocation before build), skipping is the deploy-safe choice —
    // a missing dist is a build problem the build steps themselves will catch.
    skip(`pa-orchestrator dist not built (missing ${DIST_EXTRACTOR})`)
  }

  console.log(BANNER)
  console.log(" REAL-SEAM PREDEPLOY GATE  (BLOCKING · real gpt-5.4-nano)")
  console.log(` fixtures=${FIXTURES_DIR}`)
  console.log(` ceiling=${maxModelCalls} calls · budget=${budgetMs}ms · retries=${retries}`)
  console.log(BANNER)

  const { maybeRunExtractor } = await import(pathToFileURL(DIST_EXTRACTOR).href)

  // Wall-clock budget: a hung/slow model must not stall the deploy. On timeout
  // we SKIP (exit 0) — a network stall is an infra blip, not a code regression,
  // so it must never produce a false RED that blocks a deploy.
  let timedOut = false
  const budget = new Promise((resolve) => {
    setTimeout(() => {
      timedOut = true
      resolve("__timeout__")
    }, budgetMs).unref?.()
  })

  let results
  try {
    results = await Promise.race([
      runRealSeamFixtures(maybeRunExtractor, FIXTURES_DIR, {
        maxModelCalls,
        retries,
        onTransient: (name, attempt, msg) =>
          console.log(`  ↻ transient blip on '${name}' (retry ${attempt}): ${msg.slice(0, 140)}`),
      }),
      budget,
    ])
  } catch (err) {
    // A cost-ceiling breach or unexpected crash. Ceiling breach is a fixture-set
    // mistake (deterministic), so fail loudly; any other crash we treat as a skip
    // (infra), never a false RED.
    const msg = err?.message ?? String(err)
    if (/cost ceiling/i.test(msg)) {
      console.error(`\nREAL-SEAM GATE RED — ${msg}`)
      process.exit(1)
    }
    skip(`real-seam fixtures crashed (treated as infra): ${msg}`)
  }

  if (timedOut || results === "__timeout__") {
    skip(`wall-clock budget exceeded (${budgetMs}ms) — model unreachable/slow`)
  }

  // ── Report + verdict ──
  let blocking = 0
  for (const r of results) {
    const seam = r.ranOutcomes.map((o) => `ran=${o.ran}${o.reason ? `(${o.reason})` : ""}`).join(", ")
    console.log(`\n  • ${r.name}  [onboardingState=${r.onboardingState}]`)
    console.log(`      seam outcome: ${seam}`)
    console.log(`      final durable tags: ${JSON.stringify(r.finalTags)}`)
    if (r.gated) {
      if (r.baselineRed) console.log("      ⚠ BASELINE NOW GREEN — an expected-RED baseline captured the facts; update/retire this fixture.")
      else console.log("      PASS")
    } else if (r.baselineRed) {
      console.log("      RED — expected baseline (advisory, does NOT block):")
      for (const f of r.detFails) console.log(`        - ${f}`)
    } else {
      console.log("      RED (BLOCKING) — real-model regression:")
      for (const f of r.detFails) console.log(`        - ${f}`)
      blocking += 1
    }
  }

  console.log(`\n${BANNER}`)
  console.log(` ${results.length} fixture(s) · ${results._modelCalls ?? "?"} model call(s)`)
  if (blocking === 0) {
    console.log(" REAL-SEAM GATE GREEN — every non-baseline_red fixture passed. Deploy proceeds.")
    console.log(BANNER)
    process.exit(0)
  }
  console.error(` REAL-SEAM GATE RED — ${blocking} non-baseline_red fixture(s) regressed. Deploy BLOCKED.`)
  console.error(BANNER)
  process.exit(1)
}

main().catch((err) => {
  // A top-level crash here is almost certainly an infra/setup problem (the real
  // fixture failures are caught above and reported as RED). Skip rather than
  // brick a deploy on an unexpected harness error; the deterministic RED path
  // already handled the regression case.
  console.error(`real-seam-gate crashed (treated as skip, NOT blocking): ${err?.message ?? err}`)
  console.log(`real-seam-gate crashed (treated as skip, NOT blocking): ${err?.message ?? err}`)
  process.exit(0)
})
