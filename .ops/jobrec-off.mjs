import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const ref = db.collection("pa-feature-flags").doc("paJobRecEnabled")
const before = (await ref.get()).data()
console.log("BEFORE:", JSON.stringify(before))
if (process.argv[2] === "--off") {
  await ref.set({ value: false, updatedAt: new Date().toISOString(), note: "yc event day 2026-07-25 — Adam: skip job recs today" }, { merge: true })
  console.log("AFTER :", JSON.stringify((await ref.get()).data()))
}
process.exit(0)
