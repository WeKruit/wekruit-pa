import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync("/Users/adam/Desktop/WeKruit/wekruit-pa/.claude/worktrees/serene-diffie-15b15a/.env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const since = new Date(Date.now()-6*60*1000).toISOString()
const o = await db.collection("pa-outbound").where("createdAt",">=",since).get()
const by = {}
for (const d of o.docs) { const x=d.data(); const k=`${x.runtimeSource??"-"}|${String(x.idempotencyKey??"").slice(0,12)}`; by[k]=(by[k]??0)+1 }
console.log(`outbound rows created in last 6 min: ${o.size}`)
console.log(JSON.stringify(by,null,1))
process.exit(0)
