/** Mark the availability item as a CIRCUMSTANCE question (data, not inference). */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db=admin.firestore()
const apply=process.argv.includes("--apply")
// Any hard item that asks about availability / on-site / relocation, across ALL collab jobs.
const CIRC=/available|availability|in-person|on-?site|relocat|full-time in|willing to work|start date/i
const s=await db.collection("pa-jobs").get()
let touched=0
for(const d of s.docs){
  const j=d.data(); const rb=j.recruiterBoard; if(!rb?.checklist?.groups) continue
  let changed=false
  for(const g of rb.checklist.groups){
    if(g.kind!=="hard") continue
    for(const it of g.items??[]){
      if(it.circumstance===true) continue
      if(CIRC.test(String(it.text??""))){ it.circumstance=true; changed=true
        console.log(`  ${d.id}\n     "${String(it.text).slice(0,78)}"`) }
    }
  }
  if(changed){touched++; if(apply) await db.collection("pa-jobs").doc(d.id).set({recruiterBoard:rb},{merge:true})}
}
console.log(`\n${apply?"MARKED":"would mark"} items on ${touched} job(s)`)
if(!apply) console.log("DRY RUN — pass --apply")
process.exit(0)
