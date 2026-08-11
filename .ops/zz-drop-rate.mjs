/** How many inbound messages the Sendblue webhook RECEIVED never became a pa-messages row?
 *  Match on (phone, content). This is the honest end-to-end delivery check for the inbound leg. */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const since = new Date(Date.now()-26*3600*1000).toISOString()

const users = await db.collection("pa-users").where("createdAt",">=",new Date(Date.now()-30*3600*1000).toISOString()).get()
const uidByPhone = new Map()
for (const d of users.docs) { const p=d.data().phoneE164; if(p) uidByPhone.set(String(p), d.id) }

const msgs = await db.collection("pa-messages").where("createdAt",">=",since).get()
const seen = new Set()
for (const d of msgs.docs) { const x=d.data(); if((x.direction??x.role)!=="user") continue
  seen.add(`${x.userId}|${String(x.text??x.body??"").trim().slice(0,60)}`) }

const snap = await db.collection("pa-sendblue-webhook-raw").where("receivedAt",">=",since).get()
let inbound=0, matched=0, noUser=0
const dropped=[]
for (const d of snap.docs) {
  const x=d.data(); let b={}; try{b=JSON.parse(x.bodyText??"{}")}catch{}
  if (b.is_outbound===true) continue
  const content=String(b.content??"").trim()
  if (!content) continue
  inbound++
  const uid=uidByPhone.get(String(b.from_number??""))
  if (!uid) { noUser++; continue }
  if (seen.has(`${uid}|${content.slice(0,60)}`)) { matched++; continue }
  dropped.push({t:String(x.receivedAt),from:b.from_number,c:content.replace(/\n/g," ").slice(0,58)})
}
dropped.sort((a,b)=>a.t.localeCompare(b.t))
console.log(`inbound webhook rows (26h)      : ${inbound}`)
console.log(`  became a pa-messages user row : ${matched}`)
console.log(`  phone has no recent pa-user   : ${noUser}`)
console.log(`  DROPPED (user exists, no row) : ${dropped.length}`)
const byHour=new Map()
for (const x of dropped) { const h=x.t.slice(11,13); byHour.set(h,(byHour.get(h)??0)+1) }
console.log(`\ndropped by UTC hour: ${[...byHour].sort().map(([h,n])=>`${h}h:${n}`).join("  ")}`)
console.log(`\nfirst 25 dropped:`)
for (const x of dropped.slice(0,25)) console.log(`  ${x.t.slice(11,19)} ${String(x.from).padEnd(15)} "${x.c}"`)
process.exit(0)
