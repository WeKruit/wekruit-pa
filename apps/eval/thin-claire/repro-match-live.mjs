#!/usr/bin/env node
// Reproduce the dev-phone "nonsense website" match turn IN-PROCESS against the REAL db + REAL V16
// matcher for uid 8fE (role seed restored). Shows (1) the clean "Title @ Company\nurl" lines the
// find_match TOOL produces, then (2) what gpt-5.4-nano actually composes as the user reply (the leak).
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
import { loadClaireBundle, loadEnv } from "./_claire-bundle.mjs"
loadEnv()
const { runClaireTurn, createSendblueTransport, makeV16FindMatch, selectClaireMode } = await loadClaireBundle()

let raw = readFileSync(process.env.PA_ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw = raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const uid = "8fEwIduUrzxZsblHHsNz", sid = "repro-match-" + uid

const findMatch = makeV16FindMatch(db, { log: () => {} })

console.log("=== 1. RAW find_match tool output (what the matcher hands the agent) ===")
const fm = await findMatch({ userId: uid, requestedCount: 3 })
console.log("  ok:", fm.ok, "| recCount:", fm.recCount, "| reason:", fm.reason)
console.log("  jobs (clean lines):")
;(fm.jobs || []).forEach((j, i) => console.log(`    [${i}] ${JSON.stringify(j)}`))

console.log("\n=== 2. FULL turn: what gpt-5.4-nano actually composes for 'recommend me some roles' ===")
const decision = await selectClaireMode({ db, userId: uid, inboundText: "recommend me some roles", log: () => {} })
console.log("  mode:", decision.mode, "| deferToLegacy:", decision.deferToLegacy)
const transport = createSendblueTransport({ db, toE164: "+14243201960", userId: uid, sessionId: sid, inboundEventId: "repro-evt-1", dryRun: true, log: () => {} })
await runClaireTurn(
  { userId: uid, sessionId: sid, text: "recommend me some roles", toE164: "+14243201960", lang: "en" },
  { db, transport, findMatch, log: () => {}, mode: decision.mode,
    ...(decision.pendingStep ? { pendingStep: decision.pendingStep } : {}),
    ...(decision.processStore ? { processStore: decision.processStore } : {}),
    ...(decision.onboardingSlot ? { onboardingSlot: decision.onboardingSlot } : {}),
    ...(decision.awaitingAnswer !== undefined ? { awaitingAnswer: decision.awaitingAnswer } : {}) },
)
console.log("  transport events:", transport.recordedEvents.map(e => e.kind).join(", "))
for (const e of transport.recordedEvents) {
  if (e.kind === "text" || e.kind === "status") console.log(`  [${e.kind}] ${JSON.stringify(String(e.value ?? ""))}`)
}
process.exit(0)
