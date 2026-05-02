/**
 * Stream H9 TD4 — predeploy-smoke.mjs unit tests.
 *
 * Verifies the smoke test catches the failure modes it's supposed to catch.
 * Uses a tmp dir + spawned `node predeploy-smoke.mjs` invocation against
 * synthesized "fake" pa-orchestrator/{src,dist} layouts.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const SMOKE_SCRIPT = resolve(__dirname, "../predeploy-smoke.mjs")

/**
 * Build a fake "repo root" layout:
 *   tmp/
 *     packages/pa-orchestrator/src/cv-context-injection.ts
 *     packages/pa-orchestrator/dist/cv-context-injection.js
 *     apps/functions/scripts/  (smoke script copy here so its REPO_ROOT
 *                                resolves to our tmp dir)
 *
 * Note: smoke script computes REPO_ROOT as `__dirname/../../..`, so we lay
 * out the script under `tmp/apps/functions/scripts/`.
 */
function buildFakeRepo(opts: {
  distContent: string
  srcMtimeOffsetMs?: number
  distMtimeOffsetMs?: number
  omitDist?: boolean
}): { repoRoot: string; smokePath: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), "pa-h9-td4-"))
  const srcDir = join(repoRoot, "packages/pa-orchestrator/src")
  const distDir = join(repoRoot, "packages/pa-orchestrator/dist")
  const scriptsDir = join(repoRoot, "apps/functions/scripts")
  mkdirSync(srcDir, { recursive: true })
  if (!opts.omitDist) mkdirSync(distDir, { recursive: true })
  mkdirSync(scriptsDir, { recursive: true })

  // Source file (always present)
  const srcPath = join(srcDir, "cv-context-injection.ts")
  writeFileSync(srcPath, "export function appendCvContextToSystemPrompt() {}\n")

  // Dist file (optional)
  if (!opts.omitDist) {
    const distPath = join(distDir, "cv-context-injection.js")
    writeFileSync(distPath, opts.distContent)
    if (opts.distMtimeOffsetMs != null) {
      const t = (Date.now() + opts.distMtimeOffsetMs) / 1000
      utimesSync(distPath, t, t)
    }
  }
  if (opts.srcMtimeOffsetMs != null) {
    const t = (Date.now() + opts.srcMtimeOffsetMs) / 1000
    utimesSync(srcPath, t, t)
  }

  // Copy the real smoke script into the fake repo so its relative paths resolve
  // to the fake layout.
  const fakeSmokePath = join(scriptsDir, "predeploy-smoke.mjs")
  const realScript = readFileSync(SMOKE_SCRIPT, "utf8")
  writeFileSync(fakeSmokePath, realScript)

  return { repoRoot, smokePath: fakeSmokePath }
}

describe("Stream H9 TD4 — predeploy-smoke.mjs", () => {
  it("PASS when dist exists, mtime >= src, and exports appendCvContextToSystemPrompt", () => {
    const { repoRoot, smokePath } = buildFakeRepo({
      distContent: "export function appendCvContextToSystemPrompt() { return 'ok' }\n",
      srcMtimeOffsetMs: -10_000,  // src is 10s older
      distMtimeOffsetMs: 0,        // dist is now (newer)
    })
    const r = spawnSync("node", [smokePath], { encoding: "utf8" })
    assert.equal(r.status, 0, `expected exit 0; got ${r.status}; stderr=${r.stderr}; stdout=${r.stdout}`)
    assert.match(r.stdout, /OK — appendCvContextToSystemPrompt/)
    rmSync(repoRoot, { recursive: true, force: true })
  })

  it("FAIL when dist file is missing (regression: deploy without build)", () => {
    const { repoRoot, smokePath } = buildFakeRepo({
      distContent: "",
      omitDist: true,
    })
    const r = spawnSync("node", [smokePath], { encoding: "utf8" })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /missing dist file/)
    rmSync(repoRoot, { recursive: true, force: true })
  })

  it("FAIL when src is newer than dist (regression: stale dist after edit)", () => {
    const { repoRoot, smokePath } = buildFakeRepo({
      distContent: "export function appendCvContextToSystemPrompt() {}\n",
      distMtimeOffsetMs: -60_000, // dist is 60s old
      srcMtimeOffsetMs: 0,         // src is now (newer)
    })
    const r = spawnSync("node", [smokePath], { encoding: "utf8" })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /STALE DIST/)
    rmSync(repoRoot, { recursive: true, force: true })
  })

  it("FAIL when dist exists but appendCvContextToSystemPrompt is missing", () => {
    const { repoRoot, smokePath } = buildFakeRepo({
      // dist module doesn't export the sentinel
      distContent: "export const SOMETHING_ELSE = 42\n",
      srcMtimeOffsetMs: -10_000,
      distMtimeOffsetMs: 0,
    })
    const r = spawnSync("node", [smokePath], { encoding: "utf8" })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /appendCvContextToSystemPrompt/)
    rmSync(repoRoot, { recursive: true, force: true })
  })
})
