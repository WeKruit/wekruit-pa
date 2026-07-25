import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync("/Users/adam/Desktop/WeKruit/wekruit-pa/.claude/worktrees/serene-diffie-15b15a/.env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const since = new Date(Date.now() - 40*60*1000).toISOString()
const o = await db.collection("pa-outbound").where("createdAt",">=",since).get()
const rows = o.docs.map(d=>d.data())
console.log("outbound last 40min:", rows.length)
const byRuntime = {}
for (const r of rows) byRuntime[r.runtimeSource ?? r.kind ?? "-"] = (byRuntime[r.runtimeSource ?? r.kind ?? "-"] ?? 0) + 1
console.log(byRuntime)
const jr = rows.filter(r => /jobrec|job_rec|recommend/i.test(String(r.runtimeSource ?? "") + String(r.kind ?? "") + String(r.eventId ?? "")))
console.log("job-rec-ish:", jr.length)
for (const r of jr.slice(0,8)) console.log(" ", String(r.createdAt).slice(11,19), r.status, String(r.body??"").slice(0,80))
process.exit(0)
