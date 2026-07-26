import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const since = new Date(Date.now()-26*3600*1000).toISOString()
const snap = await db.collection("pa-sendblue-webhook-raw").where("receivedAt",">=",since).get()
const want = new Set(process.argv.slice(2))
console.log(`raw rows (26h): ${snap.size}`)
let inb=0
const hits=[]
for (const d of snap.docs) {
  const x=d.data()
  let b={}; try{b=JSON.parse(x.bodyText??"{}")}catch{}
  if (b.is_outbound===true) continue
  inb++
  const from=String(b.from_number??"")
  if (!want.size || want.has(from)) hits.push({t:String(x.receivedAt).slice(11,23),from,content:String(b.content??"").replace(/\n/g," ").slice(0,70),media:b.media_url??null,status:b.status,handled:x.handled??"-",err:x.error??x.skipReason??"-"})
}
console.log(`inbound rows: ${inb} | matching filter: ${hits.length}`)
hits.sort((a,b)=>a.t.localeCompare(b.t))
for (const h of hits) console.log(`  ${h.t} ${h.from.padEnd(15)} "${h.content}" media=${h.media?"YES":"-"} status=${h.status} handled=${h.handled} err=${h.err}`)
process.exit(0)
