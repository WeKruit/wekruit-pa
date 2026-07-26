/** Are the people who signed up at the event actually IN the pool others get matched against? */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db=admin.firestore()
const pool=await db.collection("pa-external-candidate-records").where("enrichment.cohort","==","yc_startup_school_2026").get()
console.log(`YC pool total records: ${pool.size}`)
// how many came from a live signup (resolvedUserId set) vs the seeded 1066 import?
let fromSignup=0, seeded=0
const signupUids=new Set()
for(const d of pool.docs){const x=d.data()
  if(x.resolvedUserId){fromSignup++;signupUids.add(String(x.resolvedUserId))}else seeded++}
console.log(`  seeded from the attendee CSV : ${seeded}`)
console.log(`  synced from a live signup    : ${fromSignup}  (${signupUids.size} distinct users)`)

const since=new Date(Date.now()-44*3600*1000).toISOString()
const users=(await db.collection("pa-users").where("createdAt",">=",since).get()).docs.map(d=>({id:d.id,...d.data()}))
const yc=users.filter(u=>u.ycIntake||String(u.source??"").includes("yc")||String(u.firstTouchCampaign??"").includes("yc"))
const enriched=yc.filter(u=>(u.experienceHighlights?.length>0)||typeof u.coresignalEmployeeId==="number")
const inPool=enriched.filter(u=>signupUids.has(u.id))
console.log(`\nEvent signups (44h)          : ${yc.length}`)
console.log(`  with real background       : ${enriched.length}`)
console.log(`  ...of those, IN the pool   : ${inPool.length}`)
console.log(`  ...enriched but NOT pooled : ${enriched.length-inPool.length}`)
for(const u of enriched.filter(u=>!signupUids.has(u.id)).slice(0,10)) console.log(`     MISSING ${u.phoneE164??u.id}  ${u.tags?.recentRoleTitle??"-"}`)
process.exit(0)
