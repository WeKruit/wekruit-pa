#!/usr/bin/env node
/**
 * Stream H9 TD4 — predeploy smoke test for stale @pa/pa-orchestrator dist.
 *
 * Why this exists: P7-E observed the predeploy chain occasionally shipping a
 * stale `packages/pa-orchestrator/dist/` whose compiled shape didn't match
 * the latest source. The deploy succeeded, but the function imported
 * yesterday's bytecode. This smoke test fails LOUDLY if dist is missing or
 * doesn't match the current source — preventing the deploy from continuing.
 *
 * What it asserts:
 *   1. `packages/pa-orchestrator/dist/cv-context-injection.js` exists.
 *   2. The dist file's mtime is NEWER than the corresponding `.ts` source.
 *      If the .ts was edited after the build, the build is stale.
 *   3. Loading the dist file via `import()` succeeds and exposes
 *      `appendCvContextToSystemPrompt` as a function.
 *
 * Exit code: 0 on pass, 1 on fail (predeploy chain aborts on non-zero).
 */
import { existsSync, statSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, "../../..") // apps/functions/scripts → repo root
const DIST_FILE = resolve(REPO_ROOT, "packages/pa-orchestrator/dist/cv-context-injection.js")
const SRC_FILE = resolve(REPO_ROOT, "packages/pa-orchestrator/src/cv-context-injection.ts")

function fail(msg) {
  console.error("[predeploy-smoke] FAIL —", msg)
  process.exit(1)
}

if (!existsSync(DIST_FILE)) {
  fail(`missing dist file: ${DIST_FILE}\nRun: npm run build --workspace=@pa/pa-orchestrator`)
}
if (!existsSync(SRC_FILE)) {
  fail(`missing source file (smoke test target moved?): ${SRC_FILE}`)
}

const distStat = statSync(DIST_FILE)
const srcStat = statSync(SRC_FILE)
if (srcStat.mtimeMs > distStat.mtimeMs) {
  fail(
    `STALE DIST — ${SRC_FILE} (mtime ${new Date(srcStat.mtimeMs).toISOString()}) ` +
    `is newer than ${DIST_FILE} (mtime ${new Date(distStat.mtimeMs).toISOString()}).\n` +
    `Run: rm -rf packages/pa-orchestrator/dist && ` +
    `npm run build --workspace=@pa/pa-orchestrator`
  )
}

// Load via filesystem URL — works regardless of package.json `exports` map.
const distUrl = pathToFileURL(DIST_FILE).href
try {
  const mod = await import(distUrl)
  if (typeof mod.appendCvContextToSystemPrompt !== "function") {
    fail(
      `dist loaded but appendCvContextToSystemPrompt is ${typeof mod.appendCvContextToSystemPrompt} ` +
      `(expected function). dist is corrupt or function shape changed.`
    )
  }
  console.log(
    `[predeploy-smoke] OK — appendCvContextToSystemPrompt is a function (dist mtime: ` +
    `${new Date(distStat.mtimeMs).toISOString()})`
  )
} catch (err) {
  fail(`dist failed to load: ${err.message}`)
}

// 2026-05-18 — typo guard for the underscore-vs-dash collection name.
// `voice/realtime-tagger.ts:192` once wrote to the underscore variant and
// silently created a 312-doc shadow collection. After the cleanup goal
// landed, the canonical name is always pa-users (dash). The grep below
// fails the predeploy chain if a Firestore call resurfaces with the
// underscore. The pattern itself is kept variable-only to avoid self-match.
{
  const { execSync } = await import("node:child_process")
  const TYPO_TOKEN = "pa" + "_" + "users"
  const escapedToken = TYPO_TOKEN.replace(/_/g, "_")
  const pattern = `collection\\(\\s*[\\"']${escapedToken}[\\"']`
  // --include limits to source files. Exclusions strip built artifacts
  // (dist/, lib/, build/), node_modules, and this file itself.
  const cmd = `grep -rEn --include="*.ts" --include="*.mjs" --include="*.js" ` +
    `"${pattern}" "${REPO_ROOT}/packages" "${REPO_ROOT}/apps" ` +
    `2>/dev/null ` +
    `| grep -v node_modules ` +
    `| grep -v "/dist/" ` +
    `| grep -v "/lib/" ` +
    `| grep -v "/build/" ` +
    `| grep -v "predeploy-smoke.mjs" || true`
  let hits = ""
  try {
    hits = execSync(cmd, { encoding: "utf-8" }).trim()
  } catch (err) {
    fail(`typo grep failed: ${err.message}`)
  }
  if (hits.length > 0) {
    fail(
      `${TYPO_TOKEN} typo regressed — Firestore collection name MUST be ` +
      `pa-users (dash). Hits:\n${hits}\n` +
      `See .planning/GOAL-pa-users-cleanup.md for the 2026-05-18 cleanup policy.`
    )
  }
  console.log(`[predeploy-smoke] OK — no ${TYPO_TOKEN} underscore typo regressions`)
}

// v2.2 — Cross-channel prescreen parity. SMS + voice both call
// runPrescreenTurn; this gate ensures they don't drift. Any divergence in
// lifecycle.kind / terminalAction / pipeline-state across the in-memory
// scenarios → exit 1 → predeploy abort.
const PARITY_RUNNER = resolve(REPO_ROOT, "tests/scenarios/runner-parity.mjs")
if (existsSync(PARITY_RUNNER)) {
  const { spawnSync } = await import("node:child_process")
  const result = spawnSync(process.execPath, [PARITY_RUNNER], {
    stdio: "inherit",
    env: process.env,
  })
  if (result.status !== 0) {
    fail(
      `cross-channel prescreen parity FAILED (exit ${result.status}). ` +
      `SMS + voice runPrescreenTurn outcomes diverged on one of the ` +
      `tests/scenarios/runner-parity.mjs scenarios. Investigate before ` +
      `shipping — see .planning/VOICE-PRESCREEN-INTERFACE.md.`,
    )
  }
  console.log("[predeploy-smoke] OK — cross-channel prescreen parity green")
} else {
  console.warn(`[predeploy-smoke] WARN — parity runner not found at ${PARITY_RUNNER}; skipping`)
}
