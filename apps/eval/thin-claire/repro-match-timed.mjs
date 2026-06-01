#!/usr/bin/env node
// Pinpoint the 60s hang: real session ses_96ae, time find_match vs the whole agent run.
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
import { loadClaireBundle, loadEnv } from "./_claire-bundle.mjs"
loadEnv()
const { runClaireTurn, createSendblueTransport, makeV16FindMatch, selectClaireMode } = await loadClaireBundle()
let raw = readFileSync(process.env.PA_ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw = raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const uid = "8fEwIduUrzxZsblHHsNz"
const sid = "ses_96ae9f4569ebab80144aca3d65b1f08a" // the REAL session (what the live turn used)
const t0 = process.hrtime.bigint()
const ms = () => Number(process.hrtime.bigint() - t0) / 1e6

let fmCalls = 0, fmMs = 0
const realFM = makeV16FindMatch(db, { log: () => {} })
const findMatch = async (a) => { const s = ms(); fmCalls++; const r = await realFM(a); fmMs += ms() - s; console.log(`  find_match #${fmCalls} took ${(ms()-s).toFixed(0)}ms → ${r.recCount} recs`); return r }

console.log(`[${ms().toFixed(0)}ms] selectClaireMode...`)
const decision = await selectClaireMode({ db, userId: uid, inboundText: "Recommend me some roles", log: () => {} })
console.log(`[${ms().toFixed(0)}ms] mode=${decision.mode}; starting runClaireTurn (60s internal ceiling)...`)
const transport = createSendblueTransport({ db, toE164: "+14243201960", userId: uid, sessionId: sid, inboundEventId: "timed-evt", dryRun: true, log: (e,p)=>console.log(`  [run ${ms().toFixed(0)}ms] ${e}`, p?JSON.stringify(p):"") })
await runClaireTurn(
  { userId: uid, sessionId: sid, text: "Recommend me some roles", toE164: "+14243201960", lang: "en" },
  { db, transport, findMatch, log: (e,p)=>console.log(`  [run ${ms().toFixed(0)}ms] ${e}`, p?JSON.stringify(p):""), mode: decision.mode,
    ...(decision.processStore ? { processStore: decision.processStore } : {}) },
)
console.log(`[${ms().toFixed(0)}ms] DONE. find_match total=${fmMs.toFixed(0)}ms across ${fmCalls} calls`)
console.log("reply:", transport.recordedEvents.filter(e=>e.kind==="text").map(e=>e.value).join(" | ").slice(0,120))
process.exit(0)
