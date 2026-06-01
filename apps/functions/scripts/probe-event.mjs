import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw = raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const uid = "8fEwIduUrzxZsblHHsNz"

// 1. recent inbound events — no orderBy assumption; pull a chunk and sort in-memory by any time field
const snap = await db.collection("pa-inbound-events").limit(300).get()
const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }))
const t = (x) => String(x.receivedAt||x.createdAt||x.processedAt||x.updatedAt||"")
const mine = rows.filter(x => x.userId===uid || String(x.fromNumber||x.from||x.externalChatId||"").includes("4243201960"))
  .sort((a,b)=>t(b).localeCompare(t(a)))
console.log(`=== pa-inbound-events total fetched=${rows.length}, for 8fE/1960=${mine.length} ===`)
for (const x of mine.slice(0,6)) {
  console.log(`\n[${x.id}]`)
  console.log("  time:", t(x), "| status:", x.status, "| userId:", x.userId, "| handledBy:", x.handledBy||x.handler||"-")
  console.log("  from:", x.fromNumber||x.from||x.externalChatId, "| body:", JSON.stringify(String(x.body||x.text||"").slice(0,60)))
  console.log("  error:", x.error||x.lastError||"-", "| thinClaire:", x.thinClaireHandled, "| keys:", Object.keys(x).join(","))
}

// 2. the EXACT outbound doc id the kickoff would compute for each recent inbound event
const { createHash } = await import("node:crypto")
const docId = (k)=>"out_"+createHash("sha256").update(k,"utf8").digest("hex").slice(0,40)
console.log("\n=== expected outbound doc for each recent event id ===")
for (const x of mine.slice(0,6)) {
  const key = `claire-reply-${x.id}`
  const id = docId(key)
  const od = await db.collection("pa-outbound").doc(id).get()
  console.log(`  event ${x.id} → outbound ${id}: exists=${od.exists}${od.exists?` status=${od.data().status} body=${JSON.stringify(String(od.data().body||"").slice(0,40))}`:""}`)
}

// 3. is thin enabled for this user, per the real resolver path?
console.log("\n=== flag doc locations ===")
for (const path of ["pa-config/thinClaire","pa-feature-flags/thinClaire","pa-runtime-config/featureFlags","config/featureFlags"]) {
  const [c,d]=path.split("/"); const s=await db.collection(c).doc(d).get().catch(()=>null)
  if (s&&s.exists) console.log(`  ${path}:`, JSON.stringify(s.data()).slice(0,300))
}
const ud = (await db.collection("pa-users").doc(uid).get()).data()
console.log("  user.flags:", JSON.stringify({thin:ud?.paThinClaireEnabled, flags:ud?.flags, ff:ud?.featureFlags}))
process.exit(0)
