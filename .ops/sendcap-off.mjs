import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const since = new Date(Date.now()-90*60*1000).toISOString()
const o = await db.collection("pa-outbound").where("createdAt",">=",since).get()
const def = o.docs.map(d=>d.data()).filter(x=>x.capacityDeferred === true)
console.log(`capacityDeferred rows in last 90min: ${def.length} / ${o.size}`)
for (const r of def.slice(0,5)) console.log(`   ${String(r.capacityDeferredReason??"").slice(0,90)}`)
const ref = db.collection("pa-feature-flags").doc("sendbluePerNumberSendCapEnabled")
console.log("\nflag BEFORE:", JSON.stringify((await ref.get()).data() ?? null))
if (process.argv[2] === "--off") {
  await ref.set({ key:"sendbluePerNumberSendCapEnabled", value:"0", type:"string", scope:"global",
    updatedAt:new Date().toISOString(), updatedBy:"claude-yc-event-2026-07-25",
    reason:'Adam 2026-07-25: "let\'s not limit the daily message sent amount, only the daily user added (1000)". Per-number send cap was deferring rows to the 5-min retry sweep → p90 248s / max 931s delivery lag during the YC event.' }, { merge:true })
  console.log("flag AFTER :", JSON.stringify((await ref.get()).data()))
}
process.exit(0)
