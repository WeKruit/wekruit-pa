import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH,"utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db=admin.firestore()
const s = await db.collection("pa-qr-scan-pending").doc(process.argv[2]).get()
console.log(process.argv[2], s.exists ? JSON.stringify(s.data()) : "(no scan-pending doc)")
const since = new Date(Date.now()-10*3600*1000).toISOString()
const all = await db.collection("pa-qr-scan-pending").where("createdAt",">=",since).get().catch(()=>({docs:[]}))
const camp={}
for (const d of all.docs){ const c=String(d.data().campaign ?? "?"); camp[c]=(camp[c]||0)+1 }
console.log("\n今天扫码按 campaign 分布:", JSON.stringify(camp))
process.exit(0)
