import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw = raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const uid = "8fEwIduUrzxZsblHHsNz"

const tryOrder = async (coll, field) => {
  try { return await db.collection(coll).orderBy(field, "desc").limit(15).get() }
  catch { return await db.collection(coll).limit(15).get() }
}

console.log("=== pa-inbound-events (recent) ===")
const ev = await tryOrder("pa-inbound-events", "receivedAt")
const rows = ev.docs.map(d => ({ id: d.id, ...d.data() }))
  .sort((a,b) => String(b.receivedAt||b.createdAt||"").localeCompare(String(a.receivedAt||a.createdAt||"")))
for (const x of rows.slice(0,12)) {
  console.log(`${(x.receivedAt||x.createdAt||"?")} | status=${x.status} | from=${String(x.fromNumber||x.phoneE164||x.from||"").slice(-4)} | uid=${x.userId||x.paUserId||"-"} | handled=${x.handledBy||x.handler||"-"} | err=${x.error||x.lastError||"-"} | text=${JSON.stringify(String(x.text||x.body||x.content||x.message||"").slice(0,50))}`)
}

console.log("\n=== pa-messages for uid (recent) ===")
const msgs = await db.collection("pa-messages").where("userId","==",uid).limit(20).get()
const mrows = msgs.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>String(b.createdAt||b.timestamp||"").localeCompare(String(a.createdAt||a.timestamp||"")))
for (const x of mrows.slice(0,10)) {
  console.log(`${x.createdAt||x.timestamp||"?"} | dir=${x.direction||x.role||"-"} | text=${JSON.stringify(String(x.text||x.body||x.content||"").slice(0,60))}`)
}

console.log("\n=== user doc state ===")
const u = (await db.collection("pa-users").doc(uid).get()).data()
console.log("onboardingState:", u?.onboardingState, "| onboardingStatus:", u?.onboardingStatus, "| phoneE164:", u?.phoneE164, "| sharedOnboarding:", u?.sharedOnboarding?JSON.stringify(u.sharedOnboarding).slice(0,200):"(none)")
console.log("status(profile):", u?.status, "| thinClaire flag fields:", JSON.stringify({thin:u?.paThinClaireEnabled, canary:u?.thinClaireCanary}))
process.exit(0)
