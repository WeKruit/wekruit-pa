import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const since = new Date(Date.now()-26*3600*1000).toISOString()
for (const name of ["pa-audit-events","pa-audit","audit-events"]) {
  try {
    const s = await db.collection(name).limit(1).get()
    if (s.empty) { console.log(`${name}: EMPTY/none`); continue }
    console.log(`\n=== ${name} sample ===`); console.log(JSON.stringify(s.docs[0].data()).slice(0,400))
    const w = await db.collection(name).where("createdAt",">=",since).get().catch(()=>null)
    const w2 = w ?? await db.collection(name).where("at",">=",since).get().catch(()=>null)
    if (!w2) { console.log("  (no createdAt/at field to filter)"); continue }
    const byType=new Map()
    for (const d of w2.docs){const x=d.data(); const k=`${x.type??"?"}${x.reason?`/${x.reason}`:""}`; byType.set(k,(byType.get(k)??0)+1)}
    console.log(`  rows in 26h: ${w2.size}`)
    for (const [k,v] of [...byType].sort((a,b)=>b[1]-a[1]).slice(0,20)) console.log(`    ${String(v).padStart(5)}  ${k}`)
  } catch(e){ console.log(`${name}: ${String(e).slice(0,80)}`) }
}
process.exit(0)
