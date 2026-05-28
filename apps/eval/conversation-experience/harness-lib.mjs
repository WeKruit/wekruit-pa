/**
 * Shared helpers for the two-layer conversation-experience eval.
 *
 * Layer 1 (process-intact-runner.mjs)   — deterministic HARD gate (exit code)
 * Layer 2 (llm-runner.mjs / bfcl-runner.mjs) — real-LLM ADVISORY scorecard
 *
 * These helpers are intentionally dependency-free (no dotenv, no test runner)
 * so the eval can run from a bare `node` invocation inside the workspace.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

/** Repo root from a runner module living at apps/eval/conversation-experience/. */
export function repoRootFrom(metaUrl) {
  return resolve(dirname(fileURLToPath(metaUrl)), "..", "..", "..")
}

/**
 * Load the repo-root `.env` into process.env. Worktrees don't carry the
 * gitignored `.env`, so walk up to the first ancestor that has one (the main
 * checkout). Mirrors llm-runner.mjs's loader.
 */
export function loadDotEnv(repoRoot) {
  let dir = repoRoot
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, ".env")
    if (existsSync(candidate)) {
      const raw = readFileSync(candidate, "utf-8")
      for (const line of raw.split("\n")) {
        const t = line.trim()
        if (!t || t.startsWith("#")) continue
        const eq = t.indexOf("=")
        if (eq === -1) continue
        const k = t.slice(0, eq).trim()
        let v = t.slice(eq + 1).trim()
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
        if (!(k in process.env) || !process.env[k]) process.env[k] = v
      }
      return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** Load every *.json fixture in a directory (sorted, stable order). */
export function loadJsonFixtures(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => ({ path: join(dir, file), name: file, fixture: JSON.parse(readFileSync(join(dir, file), "utf-8")) }))
}

/** Expand {key} placeholders throughout a value tree from a flat ctx map. */
export function expandPlaceholders(value, ctx) {
  if (typeof value === "string") {
    let out = value
    for (const [k, v] of Object.entries(ctx)) out = out.split(`{${k}}`).join(String(v))
    return out
  }
  if (Array.isArray(value)) return value.map((v) => expandPlaceholders(v, ctx))
  if (value && typeof value === "object") {
    const o = {}
    for (const [k, v] of Object.entries(value)) o[expandPlaceholders(k, ctx)] = expandPlaceholders(v, ctx)
    return o
  }
  return value
}

export function getByDottedPath(obj, path) {
  let cur = obj
  for (const part of path.split(".")) {
    if (cur == null) return undefined
    cur = cur[part]
  }
  return cur
}

export function jsonEq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Dynamic-import a built dist module by repo-relative path (file URL). */
export async function importDist(repoRoot, relPath) {
  const abs = join(repoRoot, relPath)
  if (!existsSync(abs)) {
    throw new Error(`dist missing: ${relPath} — build the workspace first (pnpm -r build)`)
  }
  return import(pathToFileURL(abs).href)
}
