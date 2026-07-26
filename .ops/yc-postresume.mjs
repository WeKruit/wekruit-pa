import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const RESUME = process.argv[2] ?? "2026-07-25T18:15:00.000Z"
const now = new Date().toISOString()
console.log(`now=${now}  resume cutoff=${RESUME}\n`)
const m = await db.collection("pa-messages").where("createdAt",">=",RESUME).get()
const inbound = m.docs.map(d=>d.data()).filter(x=>(x.direction??x.role)==="user")
console.log(`inbound since resume: ${inbound.length}`)
let answered=0, pending=0
const un=[]
for (const x of inbound) {
  const o = await db.collection("pa-outbound").where("userId","==",x.userId).get()
  const rep = o.docs.some(d=>String(d.data().createdAt??"") > String(x.createdAt))
  if (rep) answered++
  else { pending++; un.push({at:String(x.createdAt), uid:x.userId, t:String(x.text??x.body??"").slice(0,44)}) }
}
console.log(`  answered: ${answered}`)
console.log(`  NOT answered: ${pending}`)
un.sort((a,b)=>a.at.localeCompare(b.at))
for (const u of un.slice(-12)) {
  const usr=(await db.collection("pa-users").doc(u.uid).get()).data()??{}
  const ageS=Math.round((Date.parse(now)-Date.parse(u.at))/1000)
  console.log(`   ${u.at.slice(11,19)} (${ageS}s ago) ${usr.phoneE164} dnc=${usr.doNotContact===true} "${u.t}"`)
}
process.exit(0)
