import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH,"utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"')))raw=raw.slice(1,-1)
admin.initializeApp({credential:admin.credential.cert(JSON.parse(raw)),projectId:"wekruit-5f89b"})
const db=admin.firestore()
const UID="8fEwIduUrzxZsblHHsNz", PHONE="+14243201960"
const u=(await db.collection("pa-users").doc(UID).get()).data()||{}
console.log("USER onboardingState:",u.onboardingState,"| sharedOnboarding:",u.sharedOnboarding?JSON.stringify(u.sharedOnboarding).slice(0,120):"none","| workSession:",u.workSession?.kind??"none")
console.log("USER tags keys:",Object.keys(u.tags||{}).join(","))
const recent=async(col,field)=>{
  try{const s=await db.collection(col).where(field,"==",UID).orderBy("createdAt","desc").limit(4).get()
    console.log(`\n${col} (${s.size}):`); s.docs.forEach(d=>{const x=d.data();console.log("  ",d.id.slice(0,18),x.status||x.state||"",x.errorCode||x.error||x.reason||"",(x.createdAt||x.receivedAt||"").toString().slice(0,24),(x.text||x.body||x.message||"").toString().slice(0,50))})
  }catch(e){console.log(`${col}: query err ${e.message.slice(0,80)}`)}
}
await recent("pa-inbound-events","userId")
await recent("pa-outbound","userId")
await recent("pa-messages","userId")
// also inbound by phone (in case userId not stamped)
try{const s=await db.collection("pa-inbound-events").where("fromNumber","==",PHONE).orderBy("createdAt","desc").limit(4).get()
console.log(`\npa-inbound-events byPhone (${s.size}):`);s.docs.forEach(d=>{const x=d.data();console.log("  ",d.id.slice(0,18),x.status,x.errorCode||x.error||"",x.userId?.slice(0,10),(x.text||"").slice(0,40))})}catch(e){console.log("byPhone err",e.message.slice(0,80))}
