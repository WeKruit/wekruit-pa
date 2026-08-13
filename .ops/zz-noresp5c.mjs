/** READ-ONLY: last inbound event routedTo + turn presence for each phone. */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const TS=(v)=>{if(!v)return 0;if(typeof v==="string")return Date.parse(v);if(v.toDate)return v.toDate().getTime();if(v._seconds)return v._seconds*1000;return 0}
const S=(v)=>String(v??"").replace(/\s+/g," ")
for (const phone of process.argv.slice(2)) {
  const r = await db.collection("pa-users").where("phoneE164","==",phone).get()
  if (r.empty) { console.log(`${phone}\tNO_USER`); continue }
  const uid=r.docs[0].id, u=r.docs[0].data()
  const ev=(await db.collection("pa-inbound-events").where("userId","==",uid).get()).docs.map(d=>({__id:d.id,...d.data()})).sort((a,b)=>TS(a.createdAt)-TS(b.createdAt))
  const last=ev.filter(e=>!String(e.body??"").startsWith("[system-event")).slice(-1)[0]
  const ts=(await db.collection("pa-turns").where("userId","==",uid).get()).docs.map(d=>d.data())
  const turn=ts.find(t=>t.eventId===last?.__id) ?? ts.filter(t=>Math.abs(TS(t.createdAt)-TS(last?.createdAt))<20000).slice(-1)[0]
  const outAfter=(await db.collection("pa-outbound").where("userId","==",uid).get()).docs.map(d=>d.data()).filter(o=>TS(o.createdAt)>TS(last?.createdAt))
  console.log(`\n=== ${phone} uid=${uid} dnc=${u.doNotContact} optOut=${u.optedOut??"-"} stopped=${u.stopped??"-"} sms=${u.allowSMS??"-"} peopleSent=${(u.ycPeopleMatchSent??[]).length} expHi=${(u.experienceHighlights??[]).length}`)
  console.log(`  LAST-IN "${S(last?.body).slice(0,60)}" @${S(last?.createdAt).slice(11,23)} status=${last?.status} routedTo=${last?.routedTo??"-"} handledBy=${last?.handledBy??"-"} attempts=${last?.attemptCount} err=${S(last?.lastError??last?.error??"-").slice(0,70)}`)
  console.log(`  TURN  ${turn?`mode=${turn.mode} pat=${turn.pattern} by=${turn.handledBy} tool=${turn.deliveredViaTool} supp=${turn.suppressed} final="${S(turn.finalText).slice(0,55)}" tools=${JSON.stringify(turn.toolCalls??[]).slice(0,260)}`:"*** NO TURN ***"}`)
  console.log(`  OUT-AFTER ${outAfter.length}: ${outAfter.map(o=>`[${o.status}]${S(o.body).slice(0,50)}`).join(" | ").slice(0,220)}`)
}
process.exit(0)
