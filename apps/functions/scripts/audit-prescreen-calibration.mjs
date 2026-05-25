#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { cert, getApps, initializeApp } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

import {
  gradePrescreenSessionForCalibration,
  summarizeCalibrationRows,
} from "./lib/prescreen-calibration-audit.mjs"
import {
  classifyPrescreenSessionUser,
  loadUserDocsById,
  summarizeExcludedPrescreenRows,
} from "./lib/real-prescreen-session-filter.mjs"

const args = parseArgs(process.argv.slice(2))
const PROJECT_ID = "wekruit-5f89b"

if (args.help) {
  console.log(`Usage: node apps/functions/scripts/audit-prescreen-calibration.mjs [--limit=200] [--job-id=...] [--all] [--include-non-real] [--json]

Read-only. Scans real candidate pa-prescreen-sessions by default, compares stored AI terminal against a stricter reviewer rubric, and writes nothing.`)
  process.exit(0)
}

const db = initDb()
const snap = await db.collection("pa-prescreen-sessions").orderBy("updatedAt", "desc").limit(args.limit).get()
const sessions = []
for (const doc of snap.docs) {
  const data = doc.data()
  if (!args.all && data.terminalActionPendingReview !== true) continue
  if (args.jobId && data.jobId !== args.jobId) continue
  sessions.push({ id: doc.id, ...data })
}

const userDocs = await loadUserDocsById(db, sessions.map((session) => session.userId))
const excluded = []
const realSessions = []
for (const session of sessions) {
  const classification = classifyPrescreenSessionUser({
    userId: session.userId,
    userDoc: userDocs.get(session.userId) ?? null,
    session,
  })
  if (!args.includeNonReal && !classification.included) {
    excluded.push({
      sessionId: session.id ?? session.sessionId ?? "",
      userId: session.userId ?? "",
      jobId: session.jobId ?? session.matchingJobId ?? "",
      terminal: session.terminal ?? "",
      reason: classification.reason,
      source: classification.source,
    })
    continue
  }
  realSessions.push(session)
}

const rows = realSessions.map(gradePrescreenSessionForCalibration)
const summary = summarizeCalibrationRows(rows)
const downgraded = rows
  .filter((row) => row.currentTerminal === "PASS" && row.rubricRecommendation === "FAIL")
  .slice(0, args.samples)
  .map(formatSample)

const report = {
  readOnly: true,
  scanned: snap.size,
  included: rows.length,
  excludedNonReal: excluded.length,
  excludedByReason: summarizeExcludedPrescreenRows(excluded),
  summary,
  downgradedSamples: downgraded,
  excludedSamples: excluded.slice(0, 25),
}

if (args.json) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`Read-only prescreen calibration audit`)
  console.log(`Scanned ${report.scanned}, included ${report.included}`)
  console.log(JSON.stringify(summary, null, 2))
  if (downgraded.length) {
    console.log(`\nAI PASS downgraded samples:`)
    for (const sample of downgraded) {
      console.log(`- ${sample.sessionId} job=${sample.jobId} ratio=${sample.ratio} band=${sample.band}`)
      console.log(`  reasons: ${sample.reasons.join("; ")}`)
    }
  }
}

function formatSample(row) {
  return {
    sessionId: row.sessionId,
    jobId: row.jobId,
    userId: row.userId ? `${String(row.userId).slice(0, 8)}...` : "",
    currentTerminal: row.currentTerminal,
    rubricRecommendation: row.rubricRecommendation,
    band: row.band,
    ratio: Number(row.ratio.toFixed(3)),
    reasons: row.reasons,
  }
}

function parseArgs(argv) {
  const parsed = {
    limit: 200,
    samples: 12,
    jobId: "",
    all: false,
    json: false,
    help: false,
    includeNonReal: false,
  }
  for (const arg of argv) {
    if (arg === "--all") parsed.all = true
    else if (arg === "--json") parsed.json = true
    else if (arg === "--include-non-real") parsed.includeNonReal = true
    else if (arg === "--help" || arg === "-h") parsed.help = true
    else if (arg.startsWith("--limit=")) parsed.limit = clampInt(arg.slice("--limit=".length), 1, 1000, 200)
    else if (arg.startsWith("--samples=")) parsed.samples = clampInt(arg.slice("--samples=".length), 0, 100, 12)
    else if (arg.startsWith("--job-id=")) parsed.jobId = arg.slice("--job-id=".length)
    else throw new Error(`Unknown arg: ${arg}`)
  }
  return parsed
}

function initDb() {
  if (!getApps().length) {
    const sa = loadServiceAccount()
    initializeApp({ credential: cert(sa), projectId: sa.project_id ?? PROJECT_ID })
  }
  return getFirestore()
}

function loadServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
  const envPath = resolve(process.cwd(), ".env")
  if (existsSync(envPath)) {
    const envText = readFileSync(envPath, "utf8")
    const match = envText.match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.+)$/m)
    if (match) return JSON.parse(match[1])
  }
  throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON missing. Run from repo root or export it.")
}

function clampInt(raw, min, max, fallback) {
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}
