#!/usr/bin/env node
/**
 * Verify Done #2 — pa-companies ≥200 enriched.
 *
 * Counts pa-companies docs where companyStage != "unknown" AND
 * ARRAY_LENGTH(companyTags) > 0. Pass condition: count >= 200.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=... node scripts/verify-pa-companies-enriched.mjs
 *
 * Auto-bootstraps GOOGLE_APPLICATION_CREDENTIALS from .env FIREBASE_SERVICE_ACCOUNT_JSON
 * if unset (matches the pattern used by deploy scripts).
 */
import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

function bootstrapCreds() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return
  const jsonEnv = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  if (!jsonEnv) {
    try {
      const env = readFileSync(".env", "utf8")
      const match = env.match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.+)$/m)
      if (match) process.env.FIREBASE_SERVICE_ACCOUNT_JSON = match[1].trim()
    } catch { /* no .env */ }
  }
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const tmp = join(tmpdir(), `pa-companies-verify-${Date.now()}.json`)
    writeFileSync(tmp, process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
    process.env.GOOGLE_APPLICATION_CREDENTIALS = tmp
  }
}

bootstrapCreds()

if (!getApps().length) {
  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (path) {
    initializeApp({ credential: cert(JSON.parse(readFileSync(path, "utf8"))) })
  } else {
    initializeApp({ credential: applicationDefault() })
  }
}

const db = getFirestore()

const PASS_THRESHOLD = Number(process.env.PA_COMPANIES_PASS ?? "200")

let enriched = 0
let total = 0
let unknownStage = 0
let emptyTags = 0
const sample = []

const snap = await db.collection("pa-companies").select(
  "companyStage",
  "companyTags",
  "displayName",
  "enrichmentSource",
).get()

for (const doc of snap.docs) {
  total++
  const data = doc.data()
  const stage = typeof data.companyStage === "string" ? data.companyStage : "unknown"
  const tags = Array.isArray(data.companyTags) ? data.companyTags : []
  if (stage === "unknown") unknownStage++
  if (tags.length === 0) emptyTags++
  if (stage !== "unknown" && tags.length > 0) {
    enriched++
    if (sample.length < 10) {
      sample.push({
        id: doc.id,
        displayName: data.displayName ?? doc.id,
        stage,
        tags,
        source: data.enrichmentSource ?? "?",
      })
    }
  }
}

console.log("pa-companies enrichment audit:")
console.log(`  total docs:         ${total}`)
console.log(`  enriched (stage+tags): ${enriched}`)
console.log(`  unknown stage:      ${unknownStage}`)
console.log(`  empty tags:         ${emptyTags}`)
console.log(`  pass threshold:     ${PASS_THRESHOLD}`)
console.log("")
console.log("sample enriched:")
for (const s of sample) {
  console.log(`  - ${s.displayName.padEnd(30)} stage=${s.stage.padEnd(14)} tags=${JSON.stringify(s.tags).padEnd(40)} src=${s.source}`)
}

if (enriched >= PASS_THRESHOLD) {
  console.log(`\nPASS — ${enriched}/${PASS_THRESHOLD}`)
  process.exit(0)
} else {
  console.log(`\nFAIL — ${enriched}/${PASS_THRESHOLD}`)
  process.exit(1)
}
