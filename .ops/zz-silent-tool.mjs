import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const since = new Date(Date.now()-24*3600*1000).toISOString()
const ts=(await db.collection("pa-turns").where("createdAt",">=",since).get()).docs.map(d=>d.data())
const silent = ts.filter(t=>!String(t.finalText??"").trim() && t.deliveredViaTool!==true)
console.log(`turns: ${ts.length} | silent (no text, no tool delivery): ${silent.length}`)
const byTool=new Map(), byReason=new Map()
for (const t of silent) {
  const calls=Array.isArray(t.toolCalls)?t.toolCalls:[]
  const names=calls.map(c=>String(c.name??c.tool??"?")).join("+")||"(none)"
  byTool.set(names,(byTool.get(names)??0)+1)
  for (const c of calls) {
    let o=c.output
    if (typeof o==="string"){ try{o=JSON.parse(o)}catch{} }
    const rs = o && typeof o==="object" ? `${c.name}:${o.reason ?? (o.delivered===true?"delivered":o.ok===true?"ok":"?")}` : `${c.name}:${String(o).slice(0,24)}`
    byReason.set(rs,(byReason.get(rs)??0)+1)
  }
}
console.log("\nsilent turns by tool set:")
for (const [k,v] of [...byTool].sort((a,b)=>b[1]-a[1]).slice(0,10)) console.log(`  ${String(v).padStart(4)}  ${k}`)
console.log("\ntool outcome inside silent turns:")
for (const [k,v] of [...byReason].sort((a,b)=>b[1]-a[1]).slice(0,12)) console.log(`  ${String(v).padStart(4)}  ${k}`)
const ex = silent.find(t=>(t.toolCalls??[]).some(c=>String(c.name).includes("match_yc_people")))
if (ex) { console.log("\nsample silent match_yc_people turn output:"); console.log(JSON.stringify(ex.toolCalls,null,1).slice(0,1200)) }
process.exit(0)
