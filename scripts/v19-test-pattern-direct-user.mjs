#!/usr/bin/env node
/**
 * v1.9 — TEST PATTERN A: Direct new user onboarding via SMS
 *
 * Simulates: candidate sees `/j/:jobId` public page → taps Open in iMessage
 * → sends WeKruit_<jobId>_<requestedUserId>_Job → goes through prescreen
 * → PII confirm → matching.
 *
 * No prior ATS data. No prior session. Fresh `pa-users` row created on
 * first inbound (or pre-stamped via pa-prescreen-pending-invites).
 *
 * Run:  node scripts/v19-test-pattern-direct-user.mjs [jobId]
 */
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"

const jobId = process.argv[2] ?? "hs-11005382-invoko-product-designer"
const cfg = JSON.parse(readFileSync(`${homedir()}/.config/configstore/firebase-tools.json`, "utf8"))
const tokRes = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",
    client_secret: "j9iVZfS8kkCEFUPaAeJV0sAi",
    refresh_token: cfg.tokens.refresh_token,
    grant_type: "refresh_token",
  }),
})
const { access_token } = await tokRes.json()

// 1. Generate fresh requestedUserId UUID (mimics public job page localStorage)
const requestedUserId = crypto.randomUUID()
console.log(`\n=== PATTERN A: Direct new user — jobId=${jobId} ===`)
console.log(`requestedUserId (cookie-style): ${requestedUserId}`)

// 2. Create pa-prescreen-pending-invites row (web flow does this on page load)
async function v(val) {
  if (val === null) return { nullValue: null }
  if (typeof val === "boolean") return { booleanValue: val }
  if (typeof val === "string") return { stringValue: val }
  if (typeof val === "object") {
    const out = {}
    for (const [k, vv] of Object.entries(val)) out[k] = await v(vv)
    return { mapValue: { fields: out } }
  }
}
const inviteBody = {
  fields: (await v({ jobId, requestedUserId, createdAt: new Date().toISOString() })).mapValue.fields,
}
const inviteRes = await fetch(
  `https://firestore.googleapis.com/v1/projects/wekruit-5f89b/databases/(default)/documents/pa-prescreen-pending-invites/${requestedUserId}`,
  {
    method: "PATCH",
    headers: { authorization: `Bearer ${access_token}`, "content-type": "application/json" },
    body: JSON.stringify(inviteBody),
  }
)
console.log(`pa-prescreen-pending-invites stamp: ${inviteRes.status}`)

// 3. Run simulator (replays the prescreen pipeline against the seeded config).
console.log(`\nReplaying prescreen pipeline with canned strong-candidate replies…`)
const replies = [
  "I shipped a consumer design system at a Series A fintech, 18 months ownership — visual + flow + component library",
  "Fluent in Figma, prototype daily in Framer + v0 + Cursor; recently shipped 4 interactive demos in a sprint",
].join("|")
const r = spawnSync("node", ["scripts/v19-simulate-prescreen.mjs", jobId, replies], {
  stdio: "inherit",
})

// 4. Verification checks
console.log(`\n=== PATTERN A summary ===`)
console.log(`SMS trigger candidate would send: WeKruit_${jobId}_${requestedUserId}_Job`)
console.log(`Public page URL: https://wekruit-pa.web.app/j/${jobId}`)
console.log(`Simulator exit code: ${r.status}`)
console.log(
  r.status === 0
    ? "✓ Prescreen pipeline reaches PASS terminal"
    : "✗ Prescreen pipeline did NOT reach PASS — investigate"
)
console.log(`\nNext (live SMS): wekruit-pa Sendblue inbound → coalescer → prescreen → PII → recs.`)
process.exit(r.status ?? 0)
