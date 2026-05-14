#!/usr/bin/env node
/**
 * Writes apps/pa-landing/.env.production.local from:
 * 1) PA_LANDING_VITE_ENV_FILE (optional) — KEY=value lines, # comments
 * 2) Falls back to apps/dashboard-web/.env.production.local (same Firebase
 *    project, so the VITE_FIREBASE_* + VITE_CV_INGEST_URL keys are reused).
 *
 * Vite production build loads .env.production.local automatically.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, "..")
const outPath = join(repoRoot, "apps/pa-landing/.env.production.local")

const REQUIRED = [
  "VITE_FIREBASE_API_KEY",
  "VITE_FIREBASE_AUTH_DOMAIN",
  "VITE_FIREBASE_PROJECT_ID",
  "VITE_FIREBASE_STORAGE_BUCKET",
  "VITE_FIREBASE_MESSAGING_SENDER_ID",
  "VITE_FIREBASE_APP_ID",
]

const OPTIONAL = [
  "VITE_CV_INGEST_URL", // paPublicCvIngest CF URL for /j/:jobId CV upload
  "VITE_LINKEDIN_PROVIDER_ID", // Firebase OIDC provider id for candidate LinkedIn login
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

const filePath = process.env.PA_LANDING_VITE_ENV_FILE?.trim()
if (filePath) {
  const abs = filePath.startsWith("/") ? filePath : join(repoRoot, filePath)
  if (!existsSync(abs)) {
    console.error(`[inject-pa-landing-vite-env] File not found: ${abs}`)
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
  console.error("[inject-pa-landing-vite-env] Missing required keys:\n  " + missing.join("\n  "))
  process.exit(1)
}

for (const k of OPTIONAL) {
  if (!merged[k] || String(merged[k]).trim() === "") {
    console.warn(`[inject-pa-landing-vite-env] WARN — optional key not set: ${k}`)
  }
}

function escapeEnvValue(v) {
  if (/[\s#"']/.test(v)) return JSON.stringify(v)
  return v
}

const ALL_KEYS = [...REQUIRED, ...OPTIONAL.filter((k) => merged[k])]
const body = ALL_KEYS.map((k) => `${k}=${escapeEnvValue(merged[k])}`).join("\n") + "\n"
writeFileSync(outPath, body, "utf8")
console.log("[inject-pa-landing-vite-env] wrote", outPath, "keys:", ALL_KEYS.join(","))
