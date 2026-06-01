import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw = raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const uid = "8fEwIduUrzxZsblHHsNz"

console.log("=== THE inbound event: all timestamps + dedup key ===")
const ev = (await db.collection("pa-inbound-events").doc("inb_18ba2c2cf42f3bfac3ee6417741960faea3809af").get()).data()
console.log("  createdAt:", ev.createdAt)
console.log("  claimedAt:", ev.claimedAt)
console.log("  startedAt:", ev.startedAt)
console.log("  updatedAt:", ev.updatedAt)
console.log("  leaseUntil:", ev.leaseUntil)
console.log("  attemptCount:", ev.attemptCount, "| maxAttempts:", ev.maxAttempts)
console.log("  idempotencyKey:", ev.idempotencyKey, "| correlationId:", ev.correlationId)
console.log("  status:", ev.status, "| handledBy:", ev.handledBy)

console.log("\n=== ALL pa-messages for uid (full, time-sorted) ===")
const msgs = await db.collection("pa-messages").where("userId","==",uid).limit(30).get()
msgs.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>String(a.createdAt||a.timestamp).localeCompare(String(b.createdAt||b.timestamp)))
  .forEach(x=>console.log(`  ${x.createdAt||x.timestamp} | ${x.direction||x.role} | ${JSON.stringify(String(x.text||x.body||x.content||"").slice(0,55))}`))

console.log("\n=== ALL raw sendblue webhook rows touching 1960 (last chunk) ===")
const rawSnap = await db.collection("pa-sendblue-webhook-raw").limit(300).get().catch(()=>({docs:[]}))
const rawRows = rawSnap.docs.map(d=>({id:d.id,...d.data()}))
  .filter(x=>JSON.stringify(x).includes("4243201960"))
  .sort((a,b)=>String(b.receivedAt||b.createdAt||"").localeCompare(String(a.receivedAt||a.createdAt||"")))
console.log(`  raw rows touching 1960: ${rawRows.length}`)
for (const x of rawRows.slice(0,8)) {
  const p = x.payload||x.rawPayload||x.body||x
  const content = (typeof p==="object" && (p.content||p.text)) || ""
  console.log(`  ${x.receivedAt||x.createdAt||"?"} | ${x.is_outbound?"OUT":"IN"} | content=${JSON.stringify(String(content).slice(0,45))} | handle=${(p.message_handle||p.messageHandle||"").slice(0,10)}`)
}

console.log("\n=== last reinitFreshAt on user (when I reset) ===")
const u=(await db.collection("pa-users").doc(uid).get()).data()
console.log("  reinitFreshAt:", u.reinitFreshAt, "| updatedAt:", u.updatedAt)
console.log("  sharedOnboarding.startedAt:", u.sharedOnboarding?.startedAt, "| currentQ:", u.sharedOnboarding?.currentQuestionId)
process.exit(0)
