// Render the thread AS THE USER SAW IT: inbound pa-messages + delivered pa-outbound.
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
for (const phone of process.argv.slice(2)) {
  const us = await db.collection("pa-users").where("phoneE164","==",phone).get()
  for (const u of us.docs) {
    const d=u.data()
    console.log(`\n======== ${phone}  uid=${u.id} ========`)
    console.log(`intake=${JSON.stringify(d.ycIntake??{}).slice(0,300)}`)
    console.log(`li=${d.linkedinUrl??"-"} oauth=${d.linkedinOauthLinked??false} sent=${(d.ycPeopleMatchSent??[]).length}`)
    const m=await db.collection("pa-messages").where("userId","==",u.id).get()
    const o=await db.collection("pa-outbound").where("userId","==",u.id).get()
    const ev=[]
    m.docs.forEach(x=>{const y=x.data(); if(y.role==="user") ev.push({t:y.createdAt,k:"USER",b:y.body})})
    o.docs.forEach(x=>{const y=x.data(); ev.push({t:y.createdAt,k:y.status==="sent"||y.status==="delivered"?"CLAIRE":`(${y.status})`,b:y.body})})
    ev.sort((a,b)=>String(a.t).localeCompare(String(b.t)))
    for(const e of ev) console.log(`${String(e.t).slice(11,19)} ${e.k.padEnd(11)} ${String(e.b).replace(/\n/g," ⏎ ").slice(0,260)}`)
  }
}
process.exit(0)
