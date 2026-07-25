/**
 * Backfill ycIntake.kickoffSentAt for everyone who ALREADY received the kickoff.
 * Data-only — sends nothing. Closes the replay loop for live users immediately,
 * without waiting for each of them to take another turn.
 */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const apply = process.argv.includes("--apply")

const KICK = "hey!! welcome 🎉 i'm claire"
const t = await db.collection("pa-turns").where("createdAt", ">=", "2026-07-20T00:00:00.000Z").get()
const firstKick = new Map()
for (const d of t.docs) {
  const x = d.data()
  if (!String(x.finalText ?? "").startsWith(KICK)) continue
  const at = String(x.createdAt ?? "")
  if (!firstKick.has(x.userId) || at < firstKick.get(x.userId)) firstKick.set(x.userId, at)
}
console.log(`users who received the kickoff: ${firstKick.size}`)

let stamped = 0, already = 0
for (const [uid, at] of firstKick) {
  const snap = await db.collection("pa-users").doc(uid).get()
  if (snap.data()?.ycIntake?.kickoffSentAt) { already++; continue }
  if (apply) await db.collection("pa-users").doc(uid).set({ ycIntake: { kickoffSentAt: at } }, { merge: true })
  stamped++
}
console.log(`${apply ? "STAMPED" : "WOULD STAMP"}: ${stamped} | already had it: ${already}`)
if (!apply) console.log("DRY RUN — pass --apply")
process.exit(0)
