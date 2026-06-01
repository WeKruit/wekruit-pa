#!/usr/bin/env node
// Reliability measurement: does gpt-5.4-nano RELIABLY call find_match AND present the roles for a
// recommend-intent message? Real model + real V16 matcher + real db (uid 8fE has 2 matches).
// If N/N present the roles → the agentic path is reliable; no deterministic net needed.
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
const findMatch = makeV16FindMatch(db, { log: () => {} })

const PROMPTS = ["recommend me some roles", "got any jobs for me?", "show me matches", "what fits me?", "ya pull roles", "find me something"]
let presented = 0, called = 0
for (let i = 0; i < PROMPTS.length; i++) {
  let fmCalls = 0
  const wrappedFM = async (a) => { fmCalls++; return findMatch(a) }
  const sid = `rel-${i}`
  const decision = await selectClaireMode({ db, userId: uid, inboundText: PROMPTS[i], log: () => {} })
  const t = createSendblueTransport({ db, toE164: "+14243201960", userId: uid, sessionId: sid, inboundEventId: `rel-evt-${i}`, dryRun: true, log: () => {} })
  await runClaireTurn(
    { userId: uid, sessionId: sid, text: PROMPTS[i], toE164: "+14243201960", lang: "en" },
    { db, transport: t, findMatch: wrappedFM, log: () => {}, mode: decision.mode,
      ...(decision.pendingStep ? { pendingStep: decision.pendingStep } : {}),
      ...(decision.processStore ? { processStore: decision.processStore } : {}),
      ...(decision.onboardingSlot ? { onboardingSlot: decision.onboardingSlot } : {}),
      ...(decision.awaitingAnswer !== undefined ? { awaitingAnswer: decision.awaitingAnswer } : {}) },
  )
  const reply = t.recordedEvents.filter(e => e.kind === "text").map(e => String(e.value ?? "")).join("\n")
  const hasRoles = /glimpse|spate|ycombinator\.com|@ /i.test(reply)
  if (fmCalls > 0) called++
  if (hasRoles) presented++
  console.log(`run${i+1} "${PROMPTS[i]}" | find_match called=${fmCalls>0} | presented roles=${hasRoles} | reply="${reply.slice(0,70).replace(/\n/g," ")}"`)
}
console.log(`\nfind_match CALLED: ${called}/${PROMPTS.length} | roles PRESENTED: ${presented}/${PROMPTS.length}`)
console.log(presented === PROMPTS.length ? "AGENTIC MATCH: RELIABLE ✅ — no deterministic net needed" : `AGENTIC MATCH: ${PROMPTS.length-presented} miss — reliability gap`)
process.exit(0)
