#!/usr/bin/env node
/**
 * Writes apps/recruiter-web/.env.production.local for the recruiter-only SPA.
 *
 * Defaults to the dashboard Firebase env because recruiter-web shares the same
 * Firebase project but must not depend on the candidate pa-landing build path.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, "..")
const outPath = join(repoRoot, "apps/recruiter-web/.env.production.local")

const REQUIRED = [
  "VITE_FIREBASE_API_KEY",
  "VITE_FIREBASE_AUTH_DOMAIN",
  "VITE_FIREBASE_PROJECT_ID",
  "VITE_FIREBASE_STORAGE_BUCKET",
  "VITE_FIREBASE_MESSAGING_SENDER_ID",
  "VITE_FIREBASE_APP_ID",
]

const OPTIONAL = [
  "VITE_PA_FUNCTIONS_BASE_URL",
  "VITE_PA_SSO_BASE_URL",
]

function parseEnvFile(path) {
  const content = readFileSync(path, "utf8")
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

let merged = {}

const filePath = process.env.PA_RECRUITER_VITE_ENV_FILE?.trim()
if (filePath) {
  const abs = filePath.startsWith("/") ? filePath : join(repoRoot, filePath)
  if (!existsSync(abs)) {
    console.error(`[inject-recruiter-vite-env] File not found: ${abs}`)
    process.exit(1)
  }
  merged = { ...merged, ...parseEnvFile(abs) }
}

const dashboardEnv = join(repoRoot, "apps/dashboard-web/.env.production.local")
if (existsSync(dashboardEnv)) {
  const dash = parseEnvFile(dashboardEnv)
  for (const k of [...REQUIRED, ...OPTIONAL]) {
    if (!merged[k] && dash[k]) merged[k] = dash[k]
  }
}

if (existsSync(outPath)) {
  const existing = parseEnvFile(outPath)
  for (const k of OPTIONAL) {
    if (!merged[k] && existing[k]) merged[k] = existing[k]
  }
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
  console.error("[inject-recruiter-vite-env] Missing required keys:\n  " + missing.join("\n  "))
  process.exit(1)
}

function escapeEnvValue(v) {
  if (/[\s#"']/.test(v)) return JSON.stringify(v)
  return v
}

const allKeys = [...REQUIRED, ...OPTIONAL.filter((k) => merged[k])]
const body = allKeys.map((k) => `${k}=${escapeEnvValue(merged[k])}`).join("\n") + "\n"
writeFileSync(outPath, body, "utf8")
console.log("[inject-recruiter-vite-env] wrote", outPath, "keys:", allKeys.join(","))
