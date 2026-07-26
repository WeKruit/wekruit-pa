/** Who texted us at the YC event but never got their background in? Splits the cohort by WHY,
 *  because the ask is different for each. Read-only. */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const since = new Date(Date.now()-34*3600*1000).toISOString()
const users=(await db.collection("pa-users").where("createdAt",">=",since).get()).docs.map(d=>({id:d.id,...d.data()}))
const yc=users.filter(u=>u.ycIntake||String(u.source??"").includes("yc")||String(u.firstTouchCampaign??"").includes("yc"))
const hasBg=u=>(u.experienceHighlights?.length>0)||typeof u.coresignalEmployeeId==="number"
const oauth=u=>u.linkedinOauthLinked===true||Boolean(u.linkedinOauthSub)
const placeholder=u=>typeof u.linkedinUrl==="string"&&u.linkedinUrl.includes("/oauth-linked/")

const G={neverTried:[],oauthNoData:[],stopped:[],noPhone:[]}
for (const u of yc){
  if (u.doNotContact===true){G.stopped.push(u);continue}
  if (!u.phoneE164){G.noPhone.push(u);continue}
  if (hasBg(u)) continue
  if (oauth(u)&&placeholder(u)) G.oauthNoData.push(u)
  else if (!oauth(u)) G.neverTried.push(u)
  else G.oauthNoData.push(u)
}
console.log(`YC users (34h): ${yc.length}`)
console.log(`  already have background (no reminder needed): ${yc.filter(hasBg).length}`)
console.log(`\nREMINDER COHORT`)
console.log(`  A. never started LinkedIn login at all : ${G.neverTried.length}`)
console.log(`  B. logged in, LinkedIn gave us nothing : ${G.oauthNoData.length}   <- placeholder url, zero background`)
console.log(`  excluded — opted out (STOP)            : ${G.stopped.length}`)
console.log(`  excluded — no phone on file            : ${G.noPhone.length}`)
console.log(`  TOTAL REACHABLE                        : ${G.neverTried.length+G.oauthNoData.length}`)
for (const [k,list] of [["A never-tried",G.neverTried],["B oauth-no-data",G.oauthNoData]]) {
  console.log(`\n--- ${k} (first 12 of ${list.length}) ---`)
  for (const u of list.slice(0,12)) console.log(`   ${(u.phoneE164??u.id).padEnd(16)} ${String(u.displayName??u.linkedinOauthName??"-").slice(0,22).padEnd(23)} intake=${u.ycIntake?.building?"y":"n"} pitched=${u.pitchedAt?"y":"n"}`)
}
process.exit(0)
