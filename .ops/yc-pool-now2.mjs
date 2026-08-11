import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const snap = await db.collection("pa-external-candidate-records").where("enrichment.cohort","==","yc_startup_school_2026").get()
console.log(`YC cohort pool total: ${snap.size}`)
const bySrc = {}
for (const d of snap.docs) { const s = d.data()?.enrichment?.source ?? "-"; bySrc[s]=(bySrc[s]??0)+1 }
console.log("by enrichment.source:", bySrc)
const signups = snap.docs.map(d=>({id:d.id,...d.data()})).filter(x=>x.enrichment?.source==="wekruit_signup")
signups.sort((a,b)=>String(a.updatedAt??"").localeCompare(String(b.updatedAt??"")))
console.log(`\nlive scanners synced into pool: ${signups.length}`)
for (const s of signups.slice(-10)) console.log(`   ${String(s.updatedAt??s.createdAt??"-").slice(5,19)} ${s.name??"-"} | ${s.currentTitle??"-"} @ ${s.currentCompany??"-"}`)
process.exit(0)
