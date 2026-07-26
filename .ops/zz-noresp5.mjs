/** READ-ONLY: per-user full forensic dump for the 13 no-response users. */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const S = (v)=>String(v??"").replace(/\s+/g," ")
const T = (v)=>{ if(!v) return "-"; if(typeof v==="string") return v.slice(11,23); if(v.toDate) return v.toDate().toISOString().slice(11,23); if(v._seconds) return new Date(v._seconds*1000).toISOString().slice(11,23); return String(v).slice(11,23) }
const TS = (v)=>{ if(!v) return 0; if(typeof v==="string") return Date.parse(v); if(v.toDate) return v.toDate().getTime(); if(v._seconds) return v._seconds*1000; return 0 }

for (const phone of process.argv.slice(2)) {
  const r = await db.collection("pa-users").where("phoneE164","==",phone).get()
  if (r.empty) { console.log(`\n######## ${phone}: NO USER DOC`); continue }
  for (const doc of r.docs) {
  const uid = doc.id, u = doc.data()
  console.log(`\n######## ${phone}  uid=${uid} ${r.docs.length>1?`(${r.docs.length} DOCS!)`:""}`)
  console.log(`  USER: dnc=${u.doNotContact} li=${u.linkedinUrl?"Y":"N"} csId=${u.coresignalEmployeeId??"-"} expHi=${(u.experienceHighlights??[]).length} ycIntake=${JSON.stringify(u.ycIntake??null).slice(0,160)} peopleSent=${(u.ycPeopleMatchSent??[]).length} pitchedAt=${T(u.pitchedAt)} paused=${u.paused??"-"} name=${S(u.displayName)}`)

  const rows=[]
  for (const d of (await db.collection("pa-messages").where("userId","==",uid).get()).docs){const x=d.data();rows.push({ms:TS(x.createdAt),t:T(x.createdAt),who:(x.direction??x.role)==="user"?"THEM":"us(msg)",body:S(x.text??x.body),id:d.id})}
  for (const d of (await db.collection("pa-outbound").where("userId","==",uid).get()).docs){const x=d.data();rows.push({ms:TS(x.createdAt),t:T(x.createdAt),who:`OUT[${x.status}]`,body:S(x.body),id:d.id,err:S(x.error??x.errorMessage??x.failureReason??"")})}
  rows.sort((a,b)=>a.ms-b.ms)
  console.log(`  --- interleaved tail (last 14 of ${rows.length}) ---`)
  for (const x of rows.slice(-14)) console.log(`   ${x.t} ${x.who.padEnd(15)} ${x.body.slice(0,95)}${x.err?` !!ERR=${x.err.slice(0,80)}`:""}`)

  const ts=(await db.collection("pa-turns").where("userId","==",uid).get()).docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>TS(a.createdAt)-TS(b.createdAt))
  console.log(`  --- pa-turns (last 4 of ${ts.length}) ---`)
  for (const t of ts.slice(-4)) {
    console.log(`   ${T(t.createdAt)} mode=${t.mode} pattern=${t.pattern} handledBy=${t.handledBy} model=${t.servedByModel??"-"} tool=${t.deliveredViaTool} supp=${t.suppressed} err=${S(t.error??"")}`)
    console.log(`      IN : "${S(t.inboundText).slice(0,90)}"`)
    console.log(`      OUT: "${S(t.finalText).slice(0,110)}"`)
    console.log(`      TOOLS: ${JSON.stringify(t.toolCalls??[]).slice(0,420)}`)
  }
  const ev=(await db.collection("pa-inbound-events").where("userId","==",uid).get()).docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>TS(a.createdAt)-TS(b.createdAt))
  console.log(`  --- pa-inbound-events (last 5 of ${ev.length}) ---`)
  for (const e of ev.slice(-5)) console.log(`   ${T(e.createdAt)} id=${e.id} status=${e.status} handled=${e.handled} reason=${S(e.reason??e.skipReason??e.error??"-").slice(0,70)} text="${S(e.text??e.body).slice(0,55)}"`)
  }
}
process.exit(0)
