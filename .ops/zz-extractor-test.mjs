/** Run the SHIPPED extractor regex against every real inbound today that mentions linkedin or /in/.
 *  Ground truth, not opinion: which real user messages would we fail to read? */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
// EXACT copy of the shipped regex (enrich-from-typed-linkedin.ts:79)
const RE = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)?linkedin\.com\/in\/[^\s<>"')\]]+/i
const since = new Date(Date.now()-30*3600*1000).toISOString()
const snap = await db.collection("pa-sendblue-webhook-raw").where("receivedAt",">=",since).get()
let mentions=0, hit=0
const misses=[]
for (const d of snap.docs) {
  const x=d.data(); let b={}; try{b=JSON.parse(x.bodyText??"{}")}catch{}
  if (b.is_outbound===true) continue
  const c=String(b.content??"").trim(); if(!c) continue
  if (/^(Loved|Liked|Laughed at|Emphasized|Disliked|Questioned)\s+[“"]/.test(c)) continue
  // Does the human appear to be handing us a profile?
  if (!/linked\s?in|\/in\/|lnkd\.in/i.test(c)) continue
  mentions++
  if (RE.test(c)) { hit++; continue }
  misses.push({t:String(x.receivedAt).slice(11,19),from:String(b.from_number),c:c.replace(/\n/g," ").slice(0,88)})
}
console.log(`inbound messages that look like they hand us a profile: ${mentions}`)
console.log(`  extractor MATCHED : ${hit}`)
console.log(`  extractor MISSED  : ${misses.length}`)
console.log(`\nthe misses (real user text):`)
for (const m of misses) console.log(`  ${m.t} ${m.from.padEnd(15)} "${m.c}"`)
process.exit(0)
