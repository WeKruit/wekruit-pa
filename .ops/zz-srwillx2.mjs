import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db=admin.firestore()
const since=new Date(Date.now()-3*3600*1000).toISOString()
// find by the pasted slug
const r=await db.collection("pa-users").where("phoneE164","==","+16508800410").get()
let uid=r.empty?null:r.docs[0].id
if(!uid){const raw2=await db.collection("pa-sendblue-webhook-raw").where("receivedAt",">=",since).get()
 for(const d of raw2.docs){let b={};try{b=JSON.parse(d.data().bodyText??"{}")}catch{}
  if(String(b.content??"").includes("srwillx")){const rr=await db.collection("pa-users").where("phoneE164","==",String(b.from_number)).get();if(!rr.empty){uid=rr.docs[0].id;console.log("found via raw webhook, from="+b.from_number)}}}}
if(!uid){console.log("no user");process.exit(0)}
const u=(await db.collection("pa-users").doc(uid).get()).data()??{}
console.log(`uid=${uid} phone=${u.phoneE164} coresignalId=${u.coresignalEmployeeId??"-"} exp=${u.experienceHighlights?.length??0}`)
const rows=[]
for(const d of (await db.collection("pa-messages").where("userId","==",uid).get()).docs){const x=d.data();rows.push({t:String(x.createdAt),w:(x.direction??x.role)==="user"?"THEM":"us",b:String(x.text??x.body??""),m:x.mediaUrl?"[MEDIA]":""})}
for(const d of (await db.collection("pa-outbound").where("userId","==",uid).get()).docs){const x=d.data();rows.push({t:String(x.createdAt),w:`OUT[${x.status}]`,b:String(x.body??""),m:""})}
rows.sort((a,b)=>a.t.localeCompare(b.t))
for(const r of rows.slice(-14)) console.log(`  ${r.t.slice(11,19)} ${r.w.padEnd(13)} ${r.m}${r.b.replace(/\n/g," ").slice(0,86)}`)
// which turns ran
console.log("--- turns ---")
for(const d of (await db.collection("pa-turns").where("userId","==",uid).get()).docs){const t=d.data()
  console.log(`  ${String(t.createdAt).slice(11,19)} handledBy=${t.handledBy} in="${String(t.inboundText??"").slice(0,34)}" tools=${(t.toolCalls??[]).map(c=>c.name).join(",")}`)}
process.exit(0)

