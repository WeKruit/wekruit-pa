#!/usr/bin/env node
/**
 * v1.9 bootstrap — operator-driven seed via Firestore REST API.
 *
 *   1. Seed pa-jobs/test-swe-screen-001 as a private QA job + level1Reveal
 *   2. Seed pa-config/sendblue-pool w/ 2 numbers (1 active, 1 paused placeholder)
 *
 * Auth: refreshes Firebase CLI's stored OAuth refresh_token → access_token.
 */
import { readFileSync } from "node:fs"
import { homedir } from "node:os"

const PROJECT_ID = "wekruit-5f89b"
const cfgPath = `${homedir()}/.config/configstore/firebase-tools.json`
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"))
const refreshToken = cfg.tokens?.refresh_token
if (!refreshToken) throw new Error("no refresh_token in firebase-tools.json")

// Refresh OAuth — matches firebase-tools default client.
const FIREBASE_CLIENT_ID = "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com"
const FIREBASE_CLIENT_SECRET = "j9iVZfS8kkCEFUPaAeJV0sAi"
const tokRes = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: FIREBASE_CLIENT_ID,
    client_secret: FIREBASE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  }),
})
if (!tokRes.ok) {
  throw new Error(`token refresh failed: ${tokRes.status} ${await tokRes.text()}`)
}
const { access_token } = await tokRes.json()
console.log("✓ access_token refreshed")

const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`

function v(val) {
  if (val === null) return { nullValue: null }
  if (typeof val === "boolean") return { booleanValue: val }
  if (typeof val === "number") {
    return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val }
  }
  if (typeof val === "string") return { stringValue: val }
  if (Array.isArray(val)) return { arrayValue: { values: val.map(v) } }
  if (typeof val === "object") {
    const out = {}
    for (const [k, vv] of Object.entries(val)) out[k] = v(vv)
    return { mapValue: { fields: out } }
  }
  throw new Error(`unsupported type: ${typeof val}`)
}

function fields(obj) {
  const out = {}
  for (const [k, vv] of Object.entries(obj)) out[k] = v(vv)
  return out
}

async function patch(docPath, data, updatePaths) {
  const url = new URL(`${BASE}/${docPath}`)
  for (const p of updatePaths) url.searchParams.append("updateMask.fieldPaths", p)
  const res = await fetch(url.toString(), {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${access_token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ fields: fields(data) }),
  })
  if (!res.ok) {
    throw new Error(`PATCH ${docPath} failed ${res.status}: ${await res.text()}`)
  }
  return res.json()
}

// ── 1. Private QA job + level1Reveal + description for test job ────────────
await patch(
  "pa-jobs/test-swe-screen-001",
  {
    publicVisible: false,
    candidatePageStatus: "test",
    prescreenConfig: {
      jobTitle: "Senior Frontend Engineer (Test Job)",
      company: "WeKruit Test Inc",
      level1Reveal: {
        applyUrl: "https://wekruit.com/j/test-swe-screen-001",
        salaryRange: "$140k-$180k",
        nextStepEta: "within 2-3 business days",
      },
    },
    descriptionMd:
      "We're hiring a Senior Frontend Engineer to ship the next iteration of our recruiting platform. React 19 / Next.js 15 / TypeScript / production observability. Remote-first, US time zones.",
    location: "Remote · US",
    hiddenFromPublicReason: "QA test job must not appear on public candidate marketplace",
    updatedAt: new Date().toISOString(),
  },
  ["publicVisible", "candidatePageStatus", "prescreenConfig", "descriptionMd", "location", "hiddenFromPublicReason", "updatedAt"]
)
console.log("✓ pa-jobs/test-swe-screen-001 seeded as private QA job + level1Reveal")

// ── 2. Sendblue pool: 2 numbers ────────────────────────────────────────────
await patch(
  "pa-config/sendblue-pool",
  {
    numbers: [
      { number: "+13054507715", status: "active", capacity: 1000, label: "Primary" },
      {
        number: "+13054507716",
        status: "paused",
        capacity: 1000,
        label: "Secondary (placeholder — swap to real # before activating)",
      },
    ],
    updatedAt: new Date().toISOString(),
  },
  ["numbers", "updatedAt"]
)
console.log("✓ pa-config/sendblue-pool seeded (1 active + 1 paused placeholder)")

console.log("\n📌 Smoke routes:")
console.log("   https://wekruit-pa.web.app/admin/sendblue-pool")
console.log("   https://wekruit-pa.web.app/admin/job-prescreen")
