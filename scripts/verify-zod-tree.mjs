#!/usr/bin/env node
/**
 * verify-zod-tree.mjs — permanent regression guard for the zod v3/v4 split.
 *
 * The thin-PB tree intentionally runs TWO majors of zod side by side:
 *   - top-level node_modules/zod          → v4  (the @openai/agents Claire SDK)
 *   - packages/core-types/node_modules/zod    → v3 (pinned, our schemas)
 *   - packages/pa-orchestrator/node_modules/zod → v3 (pinned, our schemas)
 * and apps/functions/tsconfig.json aliases `zod4-agent-sdk` → the v4 root so the
 * SDK can `import { z } from "zod4-agent-sdk"` while our code keeps v3.
 *
 * A stray hoist (e.g. a full `npm install` that flattens the nested v3 trees, or
 * a bump that drags everything to one major) silently breaks the build at
 * runtime — exactly the failure this guard exists to make loud. Run it in CI /
 * predeploy so the split can never quietly regress again.
 *
 * Usage:   node scripts/verify-zod-tree.mjs
 * Exit:    0 = split intact;  1 = an invariant is broken.
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, "..") // scripts/ → repo root is one dir up

const REMEDIATION = "rm -rf node_modules package-lock.json && npm install --force"

/** Read + parse a JSON file relative to ROOT. Throws a clear ✗ on failure. */
function readJson(relPath) {
  const abs = resolve(ROOT, relPath)
  try {
    return JSON.parse(readFileSync(abs, "utf8"))
  } catch (err) {
    fail(`could not read/parse ${relPath} (${abs})`, String(err?.message ?? err))
  }
}

/** Print a ✗ message naming the broken invariant + remediation, then exit 1. */
function fail(invariant, detail) {
  console.error(`✗ zod split broken: ${invariant}`)
  if (detail) console.error(`  detail: ${detail}`)
  console.error(`  remediation: ${REMEDIATION}`)
  process.exit(1)
}

/** Assert a zod package.json .version starts with `major`. Returns the version. */
function expectZodMajor(relPath, major, label) {
  const version = readJson(relPath).version
  if (typeof version !== "string" || !version.startsWith(`${major}`)) {
    fail(
      `${label} must be zod v${major} (${relPath} → "${version ?? "(missing)"}")`,
      `expected version starting with "${major}", got "${version ?? "(missing)"}"`
    )
  }
  return version
}

// 1. top-level zod must be v4 (the @openai/agents Claire SDK lane)
const topVersion = expectZodMajor("node_modules/zod/package.json", "4", "top-level node_modules/zod")

// 2. core-types nested zod must be v3 (our pinned schemas)
const coreVersion = expectZodMajor(
  "packages/core-types/node_modules/zod/package.json",
  "3",
  "packages/core-types/node_modules/zod"
)

// 3. pa-orchestrator nested zod must be v3 (our pinned schemas)
const orchVersion = expectZodMajor(
  "packages/pa-orchestrator/node_modules/zod/package.json",
  "3",
  "packages/pa-orchestrator/node_modules/zod"
)

// 4. apps/functions/tsconfig.json must alias the v4 SDK lane via "zod4-agent-sdk"
const tsconfig = readJson("apps/functions/tsconfig.json")
const paths = tsconfig?.compilerOptions?.paths
if (!paths || !Object.prototype.hasOwnProperty.call(paths, "zod4-agent-sdk")) {
  fail(
    'apps/functions/tsconfig.json compilerOptions.paths is missing the "zod4-agent-sdk" alias',
    "the v4 SDK lane is unmapped; the @openai/agents import would resolve to v3"
  )
}

const v3Pkgs = `core-types=${coreVersion} pa-orchestrator=${orchVersion}`
console.log(`✓ zod split OK: top=${topVersion} v3-pkgs=${v3Pkgs}`)
process.exit(0)
