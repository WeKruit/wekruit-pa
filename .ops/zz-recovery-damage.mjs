/** Did my 10:14PM recovery actually enrich anyone, or did it run with no Coresignal key? */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const PH=["+19142521902","+12407430509","+14126269523","+447542282427","+18476608856","+16309407529","+17738070088","+19293876878"]
for (const p of PH) {
  const r = await db.collection("pa-users").where("phoneE164","==",p).get()
  if (r.empty){console.log(`${p} NO USER`);continue}
  const u=r.docs[0].data()
  const ob=(await db.collection("pa-outbound").where("userId","==",r.docs[0].id).get()).docs.map(d=>d.data())
    .filter(x=>String(x.createdAt)>="2026-07-26T03:0").sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)))
  console.log(`\n${p}  coresignalId=${u.coresignalEmployeeId??"-"} exp=${u.experienceHighlights?.length??0} enrichedAt=${u.linkedinEnrichedAt??"-"}`)
  for (const o of ob.slice(0,3)) console.log(`    ${String(o.createdAt).slice(11,19)} [${o.status}] ${String(o.body).replace(/\n/g," ").slice(0,84)}`)
}
process.exit(0)
