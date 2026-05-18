import { initializeApp, cert } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { readFileSync } from "node:fs"

const saStr = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  ?? (readFileSync(".env","utf8").split("\n").find(l => l.startsWith("FIREBASE_SERVICE_ACCOUNT_JSON=")) ?? "").replace(/^FIREBASE_SERVICE_ACCOUNT_JSON=/,"")
initializeApp({ credential: cert(JSON.parse(saStr)) })
const db = getFirestore()

// Find Adam's user via phone
const phones = ["+14243201960", "14243201960", "4243201960"]
let user = null
for (const p of phones) {
  const snap = await db.collection("pa-users").where("phone", "==", p).limit(1).get()
  if (!snap.empty) { user = { id: snap.docs[0].id, ...snap.docs[0].data() }; break }
  const snap2 = await db.collection("pa-users").where("phoneE164", "==", p).limit(1).get()
  if (!snap2.empty) { user = { id: snap2.docs[0].id, ...snap2.docs[0].data() }; break }
}
console.log("USER:", user ? user.id : "NOT_FOUND", user?.phone ?? user?.phoneE164 ?? "(no phone field)")

// Find a publicVisible test job
const jobSnap = await db.collection("matching-jobs")
  .where("publicVisible", "==", true)
  .where("status", "==", "active")
  .limit(3)
  .get()
console.log("---PUBLIC JOBS---")
for (const d of jobSnap.docs) {
  const data = d.data()
  console.log(d.id, "|", data.jobTitle ?? data.title ?? "(no title)", "|", data.companyName ?? data.company ?? "(no co)")
}

// Any job at all
if (jobSnap.empty) {
  const any = await db.collection("matching-jobs").limit(3).get()
  console.log("---ANY JOBS---")
  for (const d of any.docs) console.log(d.id, "|", d.data().jobTitle ?? "(no title)")
}
process.exit(0)
