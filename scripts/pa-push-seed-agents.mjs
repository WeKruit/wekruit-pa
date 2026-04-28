#!/usr/bin/env node
/**
 * Merges `packages/agent-registry` seed agents into Firestore `pa-agents`
 * (same as `ensureSeedAgents`, batch set with merge: true). Use this after
 * editing `src/seed.json` so production picks up a new `systemPrompt` / version —
 * a cold project only auto-seeds when no default doc exists, so existing
 * projects keep stale agent docs until you push.
 *
 * Auth: same as other `scripts/pa-*.mjs` — `.env` with
 * `FIREBASE_SERVICE_ACCOUNT_JSON`, or a JSON path, or application default
 * credentials.
 *
 *   node scripts/pa-push-seed-agents.mjs          # dry-run: list agent ids
 *   node scripts/pa-push-seed-agents.mjs --apply
 */
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { cert, getApps, initializeApp, applicationDefault } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

const __dir = dirname(fileURLToPath(import.meta.url))
const registryDist = join(__dir, "../packages/agent-registry/dist/seed.js")

function loadDotEnv(relPath) {
  const p = join(__dir, "..", relPath)
  if (!existsSync(p)) return
  const raw = readFileSync(p, "utf8")
  for (const line of raw.split("\n")) {
    const t = line.trim()
    if (!t || t.startsWith("#")) continue
    const eq = t.indexOf("=")
    if (eq <= 0) continue
    const k = t.slice(0, eq).trim()
    let v = t.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    if (process.env[k] === undefined) process.env[k] = v
  }
}

function getDb() {
  if (getApps().length) return getFirestore()
  const jsonEnv = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  const path = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (jsonEnv && jsonEnv.trim().length > 0) {
    const sa = JSON.parse(jsonEnv)
    initializeApp({ credential: cert(sa), projectId: sa.project_id })
  } else if (path) {
    const sa = JSON.parse(readFileSync(path, "utf8"))
    initializeApp({ credential: cert(sa), projectId: sa.project_id })
  } else {
    initializeApp({
      credential: applicationDefault(),
      projectId: process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT,
    })
  }
  return getFirestore()
}

function parseArgs(argv) {
  const apply = argv.includes("--apply")
  const help = argv.includes("--help") || argv.includes("-h")
  return { apply, help }
}

async function main() {
  loadDotEnv(".env")
  const { apply, help } = parseArgs(process.argv.slice(2))
  if (help) {
    process.stdout.write(
      "pa-push-seed-agents: merge repo seed into Firestore pa_agents.\n" +
        "  (no args)  print agent ids from seed (dry-run)\n" +
        "  --apply    call ensureSeedAgents (not allowed in CI)\n" +
        "Requires built @pa/agent-registry: npm run build --workspace=@pa/agent-registry\n"
    )
    return 0
  }
  if (!existsSync(registryDist)) {
    process.stderr.write(
      "Missing packages/agent-registry/dist/seed.js — run: npm run build --workspace=@pa/agent-registry\n"
    )
    return 2
  }
  const { ensureSeedAgents, loadSeedAgents } = await import(pathToFileURL(registryDist).href)
  const agents = loadSeedAgents()
  process.stdout.write(`[seed] ${agents.length} agent(s) in seed: ${agents.map((a) => a.id).join(", ")}\n`)
  if (!apply) {
    process.stdout.write("[seed] dry-run only. Pass --apply to write to Firestore.\n")
    return 0
  }
  if (process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") {
    process.stderr.write("[seed] FAIL: CI detected; operator-run only.\n")
    return 2
  }
  const db = getDb()
  await ensureSeedAgents(db)
  process.stdout.write("[seed] ensureSeedAgents completed.\n")
  return 0
}

const isMain = typeof process !== "undefined" && process.argv[1]?.endsWith("pa-push-seed-agents.mjs")
if (isMain) {
  main().then(
    (code) => process.exit(code ?? 0),
    (err) => {
      process.stderr.write(String(err?.stack || err) + "\n")
      process.exit(1)
    }
  )
}
