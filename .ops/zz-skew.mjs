/** Measure the ACTUAL pa-outbound vs pa-messages write-order skew, instead of guessing a constant.
 *  For each turn that demonstrably replied (pa-turns with a finalText), compare the inbound message
 *  timestamp against the outbound row that carries that same finalText. */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const since = new Date(Date.now()-4*3600*1000).toISOString()
const turns = await db.collection("pa-turns").where("createdAt",">=",since).get()
const skews = []
for (const d of turns.docs) {
  const t = d.data()
  const txt = String(t.finalText ?? "")
  if (!txt || !t.userId) continue
  const inbound = String(t.inboundText ?? "")
  if (!inbound) continue
  // the pa-messages row for THIS inbound
  const m = await db.collection("pa-messages").where("userId","==",t.userId).get()
  const um = m.docs.map(x=>x.data()).find(x=>(x.direction??x.role)==="user" && String(x.text??x.body??"")===inbound)
  if (!um) continue
  const o = await db.collection("pa-outbound").where("userId","==",t.userId).get()
  const or_ = o.docs.map(x=>x.data()).find(x=>String(x.body??"").slice(0,60)===txt.slice(0,60))
  if (!or_) continue
  skews.push((Date.parse(String(or_.createdAt)) - Date.parse(String(um.createdAt)))/1000)
  if (skews.length >= 120) break
}
skews.sort((a,b)=>a-b)
const p=(q)=>skews[Math.floor(skews.length*q)]?.toFixed(2)
console.log(`matched reply pairs: ${skews.length}`)
console.log(`skew outbound-minus-inbound (s): min=${skews[0]?.toFixed(2)} p10=${p(.1)} p50=${p(.5)} p90=${p(.9)} max=${skews.at(-1)?.toFixed(2)}`)
console.log(`negative (outbound written BEFORE inbound): ${skews.filter(s=>s<0).length}/${skews.length}`)
console.log(`most negative: ${skews.filter(s=>s<0).slice(0,5).map(s=>s.toFixed(2)).join(", ")}`)
process.exit(0)
