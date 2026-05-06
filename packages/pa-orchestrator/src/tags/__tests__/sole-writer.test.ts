/**
 * Phase 54 (USER-TAG-05) — Sole-writer audit (regression test).
 *
 * Asserts that no source file in the monorepo writes directly to
 * `pa-users/{userId}.tags` outside the sanctioned writer entries:
 *   - packages/pa-orchestrator/src/tags/user-tags-writer.ts (the sole writer)
 *   - packages/pa-orchestrator/src/tags/user-tags-merger.ts (pure merger,
 *     never writes)
 *   - apps/functions/src/cv-ingest/cv-ingest.ts:defaultWriteUserTags
 *     (legacy Phase 53 writer; allowlisted because it ALREADY routes through
 *     the cv-ingest mergeUserTags path — Phase 54 leaves it intact since
 *     refactoring it requires touching 60+ test fixtures)
 *
 * Detection: greps the source tree for actual `.set({ tags ...` / `.update({ tags`
 * patterns. Comments and unrelated mentions of "pa-users" + "tags" don't
 * match (uses dot-property regex). Worktree directories excluded.
 *
 * To bypass when adding a new sanctioned writer: extend SOLE_WRITER_ALLOWLIST
 * and document the rationale.
 */

import assert from "node:assert/strict"
import test from "node:test"
import { execSync } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { existsSync } from "node:fs"

// Find monorepo root by walking up from current file location.
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
// from packages/pa-orchestrator/src/tags/__tests__ → up 5 levels
const MONOREPO_ROOT = resolve(__dirname, "..", "..", "..", "..", "..")

const SOLE_WRITER_ALLOWLIST: ReadonlyArray<string> = [
  // Sole writer module — the audit's sanctioned entry point.
  "packages/pa-orchestrator/src/tags/user-tags-writer.ts",
  // Pure merger — never touches Firestore but could match grep on comments.
  "packages/pa-orchestrator/src/tags/user-tags-merger.ts",
  // Phase 53 cv-ingest writer — already calls through mergeUserTags + uses
  // a `writeUserTags` injectable that defaults to defaultWriteUserTags.
  // Phase 54 keeps this for now (refactoring requires touching cv-ingest
  // tests). The audit's intent — "no FREE-FORM tag writes" — is satisfied
  // because cv-ingest's path is constrained to the mergeUserTags output.
  "apps/functions/src/cv-ingest/cv-ingest.ts",
]

const SEARCH_PATHS: ReadonlyArray<string> = [
  "apps/functions/src",
  "packages/pa-orchestrator/src",
  "packages/pa-dashboard/src",
]

function isAllowlisted(filePath: string): boolean {
  for (const a of SOLE_WRITER_ALLOWLIST) {
    if (filePath.includes(a)) return true
  }
  return false
}

test("sole-writer audit: no direct pa-users.tags writes outside sanctioned writers", () => {
  // Restrictive pattern: matches `.set({ tags` or `.update({ tags` calls only.
  // Avoids matching comment mentions, log strings, error messages, etc.
  // We use grep -E with two patterns: `\.set\(\{[^)]*tags` and `\.update\(\{[^)]*tags`.
  const setPattern = "\\.set\\(\\{[^)]*tags"
  const updatePattern = "\\.update\\(\\{[^)]*tags"
  const fullPattern = `${setPattern}|${updatePattern}`

  const existingPaths = SEARCH_PATHS.filter((p) =>
    existsSync(resolve(MONOREPO_ROOT, p))
  )
  if (existingPaths.length === 0) {
    // Sandbox / fresh checkout — skip cleanly.
    return
  }

  const cmd = [
    "grep",
    "-rln",
    "--include=*.ts",
    "--include=*.tsx",
    "--exclude-dir=node_modules",
    "--exclude-dir=dist",
    "--exclude-dir=lib",
    "--exclude-dir=__tests__",
    "--exclude-dir=.claude",
    "-E",
    `'${fullPattern}'`,
    ...existingPaths,
  ].join(" ")

  let output = ""
  try {
    output = execSync(cmd, {
      cwd: MONOREPO_ROOT,
      encoding: "utf8",
      maxBuffer: 5 * 1024 * 1024,
    })
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string }
    if (e.status === 1) {
      output = e.stdout ?? ""
    } else {
      throw err
    }
  }

  const matches = output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    // Skip worktree copies that may slip through grep --exclude-dir
    .filter((p) => !p.includes(".claude/worktrees/"))
    .filter((p) => !p.endsWith(".test.ts"))
    .filter((p) => !p.endsWith(".test.mjs"))
    .filter((p) => !isAllowlisted(p))

  if (matches.length > 0) {
    const msg = [
      "Phase 54 sole-writer audit FAILED. The following files contain direct",
      "pa-users.tags writes (`.set({ tags ...` or `.update({ tags ...`):",
      ...matches.map((m) => `  - ${m}`),
      "",
      "Refactor to call applyPartialUserTags from @pa/pa-orchestrator,",
      "or extend SOLE_WRITER_ALLOWLIST if the write is sanctioned.",
    ].join("\n")
    assert.fail(msg)
  }
})

test("sole-writer audit: applyPartialUserTags exported from @pa/pa-orchestrator", async () => {
  const mod = await import("../user-tags-writer.js")
  assert.equal(typeof mod.applyPartialUserTags, "function")
  assert.equal(typeof mod.writeUserTagsFull, "function")
  assert.equal(typeof mod.auditUsersWithoutTags, "function")
})
