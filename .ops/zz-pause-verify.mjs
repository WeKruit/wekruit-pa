/** Is the fleet pause fully lifted RIGHT NOW? Counts every gate that can swallow an inbound. */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const all = await db.collection("pa-users").select("doNotContact","operatorPause","doNotContactSource","doNotContactAt","phoneE164","ycIntake","createdAt").get()
let total=0, dnc=0, paused=0, ycDnc=0
const realStop=[], suspicious=[]
for (const d of all.docs){
  const u=d.data(); total++
  if (u.operatorPause) { paused++; suspicious.push({p:u.phoneE164,why:"operatorPause marker still set"}) }
  if (u.doNotContact===true){
    dnc++
    if (u.ycIntake) ycDnc++
    // A REAL opt-out always carries source+timestamp (stop-gate writes them). The pause script never did.
    if (!u.doNotContactSource && !u.doNotContactAt) suspicious.push({p:u.phoneE164,why:"doNotContact=true with NO source/at → looks like an operator pause, not a user STOP"})
    else realStop.push(u.phoneE164)
  }
}
console.log(`pa-users total            : ${total}`)
console.log(`operatorPause marker set  : ${paused}   <- must be 0`)
console.log(`doNotContact === true     : ${dnc}  (of which YC: ${ycDnc})`)
console.log(`  genuine STOP (has source/at): ${realStop.length}`)
console.log(`  SUSPICIOUS (no source/at)   : ${suspicious.filter(s=>s.why.startsWith("doNotContact")).length}   <- must be 0`)
for (const s of suspicious.slice(0,20)) console.log(`     ${s.p ?? "(no phone)"} — ${s.why}`)
process.exit(0)
