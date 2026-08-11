/** Did the clamp actually land? Compare limits the model passed BEFORE vs AFTER the deploy. */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const CUT = process.argv[2] ?? new Date(Date.now()-15*60*1000).toISOString()
const since = new Date(Date.now()-20*3600*1000).toISOString()
const t = await db.collection("pa-turns").where("createdAt",">=",since).get()
const pre={}, post={}
let nPost=0
for (const d of t.docs) {
  const x=d.data()
  const calls = Array.isArray(x.toolCalls)?x.toolCalls:[]
  for (const c of calls) {
    const nm = c.name ?? c.tool ?? ""
    if (!String(nm).includes("match_yc_people")) continue
    let args = c.args ?? c.arguments ?? {}
    if (typeof args === "string") { try { args = JSON.parse(args) } catch { args = {} } }
    const k = String(args.limit ?? "absent")
    const bucket = String(x.createdAt) >= CUT ? post : pre
    bucket[k]=(bucket[k]??0)+1
    if (String(x.createdAt) >= CUT) nPost++
  }
}
console.log(`cutoff ${CUT}`)
console.log("BEFORE deploy, limit arg:", JSON.stringify(pre))
console.log("AFTER  deploy, limit arg:", JSON.stringify(post), `(${nPost} calls)`)
