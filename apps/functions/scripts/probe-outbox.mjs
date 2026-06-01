import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw = raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const uid = "8fEwIduUrzxZsblHHsNz"

const dump = async (coll) => {
  let snap
  try { snap = await db.collection(coll).where("userId","==",uid).limit(25).get() }
  catch (e) { console.log(`  (${coll} query err: ${e.message})`); return }
  if (snap.empty) { console.log(`  (${coll}: none for uid)`); return }
  const rows = snap.docs.map(d=>({id:d.id,...d.data()}))
    .sort((a,b)=>String(b.createdAt||b.enqueuedAt||b.updatedAt||"").localeCompare(String(a.createdAt||a.enqueuedAt||a.updatedAt||"")))
  for (const x of rows.slice(0,12)) {
    console.log(`  ${x.createdAt||x.enqueuedAt||"?"} | status=${x.status||x.state||"-"} | attempts=${x.attempts??x.attemptCount??"-"} | to=${String(x.toE164||x.toNumber||x.to||"").slice(-4)} | err=${JSON.stringify(x.lastError||x.error||x.failureReason||"-").slice(0,80)} | text=${JSON.stringify(String(x.text||x.body||x.content||x.message||"").slice(0,45))}`)
  }
}

for (const c of ["pa-outbound","pa-outbox","pa-outbound-messages","pa-sendblue-outbound","outbound"]) {
  console.log(`=== ${c} ===`)
  await dump(c)
}

// also: list any pa-outbound globally most-recent (in case userId field differs)
console.log("\n=== pa-outbound MOST RECENT (any user) ===")
try {
  const g = await db.collection("pa-outbound").orderBy("createdAt","desc").limit(8).get()
  g.docs.forEach(d=>{const x=d.data(); console.log(`  ${x.createdAt} | status=${x.status} | uid=${x.userId||"-"} | to=${String(x.toE164||x.toNumber||"").slice(-4)} | err=${JSON.stringify(x.lastError||x.error||"-").slice(0,70)} | text=${JSON.stringify(String(x.text||x.body||"").slice(0,40))}`)})
} catch(e){ console.log("  err:", e.message) }
process.exit(0)
