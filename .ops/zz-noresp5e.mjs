/** READ-ONLY: blast radius of stop_gate_suppressed_opted_out + operatorPause state + hard-net grep. */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
console.log("NOW =", new Date().toISOString())

// 1. suppressed inbound events since yesterday
const ev = await db.collection("pa-inbound-events").where("createdAt",">=","2026-07-25T00:00:00.000Z").get()
const sup = ev.docs.map(d=>d.data()).filter(e=>e.routedTo==="stop_gate_suppressed_opted_out")
console.log(`\npa-inbound-events since 2026-07-25: ${ev.size} total, ${sup.length} routedTo=stop_gate_suppressed_opted_out`)
const byMin = {}
for (const e of sup) { const k=String(e.createdAt).slice(11,16); byMin[k]=(byMin[k]??0)+1 }
console.log("  per-minute histogram (UTC):")
for (const k of Object.keys(byMin).sort()) console.log(`    ${k}  ${"#".repeat(Math.min(byMin[k],60))} ${byMin[k]}`)
const times = sup.map(e=>String(e.createdAt)).sort()
console.log(`  FIRST suppressed: ${times[0]}`)
console.log(`  LAST  suppressed: ${times[times.length-1]}`)
console.log(`  distinct users suppressed: ${new Set(sup.map(e=>e.userId)).size}`)
console.log("  sample bodies:", sup.slice(0,8).map(e=>String(e.body??"").replace(/\s+/g," ").slice(0,40)).join(" | "))

// 2. operatorPause state right now
const u = await db.collection("pa-users").get()
let stillPaused=0, hasMarker=0, dncTrue=0, ycTotal=0
for (const d of u.docs){const x=d.data(); if(x.operatorPause) hasMarker++; if(x.doNotContact===true) dncTrue++; if(x.operatorPause&&x.doNotContact===true) stillPaused++
  if (x.source==="yc_startup_school"||x.ycEventEntryAt||x.firstTouchCampaign==="yc-startup-school") ycTotal++}
console.log(`\npa-users: ${u.size} total | yc-tagged ${ycTotal} | doNotContact=true ${dncTrue} | operatorPause marker ${hasMarker} | STILL PAUSED (both) ${stillPaused}`)

// 3. did the hard-net bubble ever go out?
const ob = await db.collection("pa-outbound").where("createdAt",">=","2026-07-25T00:00:00.000Z").get()
const net = ob.docs.map(d=>d.data()).filter(o=>String(o.body??"").includes("i'm here 👋"))
console.log(`\npa-outbound since 2026-07-25: ${ob.size} rows | hard-net "i'm here 👋": ${net.length}`)
for (const n of net.slice(0,10)) console.log(`   ${String(n.createdAt).slice(11,19)} [${n.status}] u=${n.userId} ${String(n.body).slice(0,70)}`)
const badStatus = ob.docs.map(d=>d.data()).filter(o=>!["sent","delivered"].includes(String(o.status)))
console.log(`  non-sent/delivered outbound rows: ${badStatus.length} ->`, JSON.stringify(badStatus.reduce((a,o)=>{a[o.status]=(a[o.status]??0)+1;return a},{})))
process.exit(0)
