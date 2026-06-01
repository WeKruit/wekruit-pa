#!/usr/bin/env node
/** READ-ONLY: what prescreen sessions + pending HITL review attempts exist for a uid. */
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { cert, getApps, initializeApp } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

const UID = process.argv[2] || "8fEwIduUrzxZsblHHsNz" // +14243201960

function loadSA() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS && existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS))
    return JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"))
  for (const c of [resolve(process.cwd(), "../../.env"), "/Users/adam/Desktop/WeKruit/wekruit-pa/.env"]) {
    if (existsSync(c)) {
      const m = readFileSync(c, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.+)$/m)
      if (m) return JSON.parse(m[1].replace(/^"/, "").replace(/"$/, ""))
    }
  }
  throw new Error("no creds")
}
if (!getApps().length) initializeApp({ credential: cert(loadSA()), projectId: "wekruit-5f89b" })
const db = getFirestore()

console.log(`\n=== uid ${UID} ===`)

const sess = await db.collection("pa-prescreen-sessions").where("userId", "==", UID).get()
console.log(`\npa-prescreen-sessions: ${sess.size}`)
for (const d of sess.docs) {
  const x = d.data()
  console.log(`  ${d.id} | job=${x.jobId} | terminal=${x.terminal} | pendingReview=${x.terminalActionPendingReview} | updated=${x.updatedAt ?? x.lastTurnAt ?? ""}`)
}

const att = await db.collection("pa-evaluation-attempts").where("candidateId", "==", UID).get()
console.log(`\npa-evaluation-attempts: ${att.size}`)
for (const d of att.docs) {
  const x = d.data()
  console.log(`  ${d.id} | job=${x.jobId} | terminal=${x.terminal ?? x.proposedTerminal} | status=${x.status ?? x.reviewStatus} | source=${x.source} | committed=${x.downstreamCommit ?? x.committed ?? ""}`)
}

const evp = await db.collection("pa-employer-visible-profiles").where("candidateId", "==", UID).get()
console.log(`\npa-employer-visible-profiles (already-passed jobs → schedulable): ${evp.size}`)
for (const d of evp.docs) console.log(`  ${d.id} | job=${d.data().jobId}`)
process.exit(0)
