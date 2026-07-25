import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH,"utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const since = new Date(Date.now()-6*3600*1000).toISOString()
const o = await db.collection("pa-outbound").where("createdAt",">=",since).get()
const byStatus={}, dupBodies={}
for (const d of o.docs) {
  const x=d.data(); byStatus[x.status]=(byStatus[x.status]||0)+1
  if (x.status==="duplicate_skipped") { const k=String(x.body??"").slice(0,60); dupBodies[k]=(dupBodies[k]||0)+1 }
}
console.log("outbound 6h by status:", JSON.stringify(byStatus))
console.log("\n被去重吃掉的文案 top:")
Object.entries(dupBodies).sort((a,b)=>b[1]-a[1]).slice(0,8).forEach(([k,v])=>console.log(`  ${String(v).padStart(3)}×  "${k}"`))
// json leak
const msgs = await db.collection("pa-messages").where("createdAt",">=",since).get()
let leak=0
for (const d of msgs.docs) { const t=String(d.data().text ?? d.data().body ?? ""); if (t.trim().startsWith('{"messages"')) leak++ }
console.log(`\n{"messages":...} 泄漏进 transcript: ${leak} / ${msgs.size} 条`)
process.exit(0)
