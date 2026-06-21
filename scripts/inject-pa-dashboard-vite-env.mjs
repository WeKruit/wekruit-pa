#!/usr/bin/env node
/**
 * Writes apps/dashboard-web/.env.production.local from:
 * 1) PA_DASHBOARD_VITE_ENV_FILE (optional) — KEY=value lines, # comments
 * 2) process.env — overrides file (for Infisical / CI export)
 *
 * Vite production build loads .env.production.local automatically.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, "..")
const outPath = join(repoRoot, "apps/dashboard-web/.env.production.local")

const REQUIRED = [
  "VITE_FIREBASE_API_KEY",
  "VITE_FIREBASE_AUTH_DOMAIN",
  "VITE_FIREBASE_PROJECT_ID",
  "VITE_FIREBASE_STORAGE_BUCKET",
  "VITE_FIREBASE_MESSAGING_SENDER_ID",
  "VITE_FIREBASE_APP_ID",
]

// v1.9 hotfix 2026-05-12 — optional VITE_* keys preserved alongside the
// required Firebase set. When present in the source env file (or process.env),
// they get written through to .env.production.local; absence is a soft warn
// (not fail) so legacy Adam deploys still work.
const OPTIONAL = [
  "VITE_CV_INGEST_URL", // paPublicCvIngest CF URL for /j/:jobId/cv upload
  "VITE_ALGOLIA_APP_ID", // Algolia app for admin search (submissions + candidates)
  "VITE_ALGOLIA_SEARCH_KEY", // Algolia search-only key (public, frontend)
]

/** @param {string} path */
function parseEnvFile(path) {
  const content = readFileSync(path, "utf8")
  /** @type {Record<string, string>} */
  const out = {}
  for (const line of content.split("\n")) {
    const t = line.trim()
    if (!t || t.startsWith("#")) continue
    const i = t.indexOf("=")
    if (i === -1) continue
    const key = t.slice(0, i).trim()
    let val = t.slice(i + 1).trim()
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    out[key] = val
  }
  return out
}

/** @type {Record<string, string>} */
let merged = {}

const filePath = process.env.PA_DASHBOARD_VITE_ENV_FILE?.trim()
if (filePath) {
  const abs = filePath.startsWith("/") ? filePath : join(repoRoot, filePath)
  if (!existsSync(abs)) {
    console.error(`[inject-pa-dashboard-vite-env] File not found: ${abs}`)
    process.exit(1)
  }
  merged = { ...merged, ...parseEnvFile(abs) }
}

for (const k of Object.keys(process.env)) {
  if (
    (k.startsWith("VITE_FIREBASE_") || OPTIONAL.includes(k)) &&
    process.env[k] != null &&
    String(process.env[k]).trim() !== ""
  ) {
    merged[k] = String(process.env[k]).trim()
  }
}

const missing = REQUIRED.filter((k) => !merged[k] || String(merged[k]).trim() === "")
if (missing.length) {
  console.error(
    "[inject-pa-dashboard-vite-env] Missing required keys:\n  " + missing.join("\n  "),
  )
  console.error(
    "\nFix: set PA_DASHBOARD_VITE_ENV_FILE to a KEY=value file, and/or export VITE_FIREBASE_* in the shell.",
  )
  console.error("Example: infisical run -- npm run build:dashboard:with-injected-env")
  process.exit(1)
}

// Warn (don't fail) when optional keys are absent — keeps legacy single-env
// deploys working but flags missing wiring in CI output.
for (const k of OPTIONAL) {
  if (!merged[k] || String(merged[k]).trim() === "") {
    console.warn(`[inject-pa-dashboard-vite-env] WARN — optional key not set: ${k}`)
  }
}

const ALL_KEYS = [...REQUIRED, ...OPTIONAL.filter((k) => merged[k])]
const body = ALL_KEYS.map((k) => `${k}=${escapeEnvValue(merged[k])}`).join("\n") + "\n"
writeFileSync(outPath, body, "utf8")
console.log("[inject-pa-dashboard-vite-env] wrote", outPath, "keys:", ALL_KEYS.join(","))

/** @param {string} v */
function escapeEnvValue(v) {
  if (/[\s#"']/.test(v)) return JSON.stringify(v)
  return v
}
