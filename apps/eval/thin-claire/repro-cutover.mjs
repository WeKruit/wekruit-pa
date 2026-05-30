#!/usr/bin/env node
// Reproduce the EXACT cutover decision for the stuck recommend event (dryRun → no real sends).
// Prints every log line maybeRunThinClaire emits so we see WHY thin returned false (defer? flag?
// early-return? exception?) without needing Cloud Logging access.
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
import { loadClaireBundle, loadEnv } from "./_claire-bundle.mjs"
loadEnv()
const { maybeRunThinClaire } = await loadClaireBundle()
let raw = readFileSync(process.env.PA_ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw = raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const eventId = "inb_3fb742a9896f416cb4500d9ac93afcf2b5044054"

console.log("=== calling maybeRunThinClaire (dryRun) for the stuck recommend event ===")
let handled, threw
try {
  handled = await maybeRunThinClaire(db, eventId, { dryRun: true, log: (e, p) => console.log(`  [thin] ${e}`, p ? JSON.stringify(p) : "") })
} catch (e) {
  threw = e
}
console.log("\nRESULT: thinHandled =", handled, threw ? `| THREW: ${threw?.message}\n${threw?.stack}` : "")
process.exit(0)
