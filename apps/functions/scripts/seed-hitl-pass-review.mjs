#!/usr/bin/env node
/**
 * TEST SEED (dev only): drive the REAL finalizePrescreenForHumanReview against an
 * existing prescreen session, forcing terminal=PASS, so a dashboard-reviewable
 * PASS appears in /admin/prescreen-sessions. No fabricated docs — uses the real
 * production function. No SMS is sent (no-op sender) — the candidate gets the real
 * message only when the operator COMMITS the PASS in the dashboard.
 *
 * Usage: node --import tsx scripts/seed-hitl-pass-review.mjs <sessionDocId>
 */
import { readFileSync } from "node:fs"
import { cert, getApps, initializeApp } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { finalizePrescreenForHumanReview } from "../src/prescreen-review-finalization.js"

const SESSION_ID =
  process.argv[2] ||
  "ps_metavoice-software-engineer-data-evals_8fEwIduUrzxZsblHHsNz_20260601T054818220Z"

const sa = JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"))
if (!getApps().length) initializeApp({ credential: cert(sa), projectId: "wekruit-5f89b" })
const db = getFirestore()

const snap = await db.collection("pa-prescreen-sessions").doc(SESSION_ID).get()
if (!snap.exists) throw new Error(`session ${SESSION_ID} not found`)
const state = snap.data() // the session doc IS the PreScreenState
const toE164 = typeof state.e164 === "string" ? state.e164 : ""
console.log(`session ${SESSION_ID}\n  user=${state.userId} job=${state.jobId} e164=${toE164} currentTerminal=${state.terminal}`)

const res = await finalizePrescreenForHumanReview({
  db,
  state,
  cfgSnapshot: state.cfgSnapshot,
  terminal: "PASS",
  toE164,
  lang: "en",
  // NO-OP sender: do not text the candidate from this seed. The real PASS message
  // fires when the operator commits in the dashboard (commitPrescreenOutcome).
  sendSms: async () => ({ outboundId: undefined }),
  log: (e, p) => console.log("  log:", e, JSON.stringify(p ?? {})),
})

console.log(`\n✔ pending PASS review created: attemptId=${res.attemptId}`)
console.log(`  → open /admin/prescreen-sessions, find job '${state.jobId}', mark PASS to fire the outbound.`)
process.exit(0)
