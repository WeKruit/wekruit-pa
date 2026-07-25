import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH,"utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const since = new Date(Date.now()-12*3600*1000).toISOString()
const m = await db.collection("pa-messages").where("createdAt",">=",since).get()
const byUser = new Map()
for (const d of m.docs) { const x=d.data(); const k=String(x.userId??""); if(!k) continue
  if(!byUser.has(k)) byUser.set(k,[]); byUser.get(k).push(x) }
const o = await db.collection("pa-outbound").where("createdAt",">=",since).get()
const outByUser = new Map()
for (const d of o.docs) { const x=d.data(); const k=String(x.userId??""); if(!k) continue
  if(!outByUser.has(k)) outByUser.set(k,[]); outByUser.get(k).push(x) }
let dead=0, total=0
const cases=[]
for (const [uid, msgs] of byUser) {
  const sorted = msgs.sort((a,b)=>String(a.createdAt??"").localeCompare(String(b.createdAt??"")))
  const outs = (outByUser.get(uid)??[]).map(x=>String(x.createdAt??""))
  for (const x of sorted) {
    const t = String(x.text ?? x.body ?? "")
    if (!t.trim().startsWith('{"messages"')) continue
    let parsed = null
    try { parsed = JSON.parse(t) } catch { /* truncated */ }
    const msgs = Array.isArray(parsed?.messages) ? parsed.messages.filter(x=>String(x).trim()) : null
    if (msgs && msgs.length === 0) continue   // empty list = tool already delivered, CORRECT
    total++
    const at = String(x.createdAt ?? "")
    // did ANY outbound get created within 60s after this composed reply?
    const delivered = outs.some(o => o >= at && new Date(o) - new Date(at) < 60000)
    if (!delivered) { dead++; cases.push({ uid: uid.slice(0,8), at: at.slice(5,19), t: t.slice(0, 150) }) }
  }
}
console.log(`非空 composed 回复 ${total} | 从未投递(死掉) ${dead}\n`)
cases.slice(0,12).forEach(c=>console.log(`  ${c.at} uid=${c.uid}\n      "${c.t.replace(/\n/g," ")}"`))
process.exit(0)
