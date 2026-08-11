import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
for (const p of ["+19142521902","+12407430509","+14126269523"]) {
  const r=await db.collection("pa-users").where("phoneE164","==",p).get()
  const u=r.docs[0]?.data()??{}
  console.log(`${p} coresignalId=${u.coresignalEmployeeId??"-"} exp=${u.experienceHighlights?.length??0} url=${String(u.linkedinUrl??"-").slice(0,52)} enrichedAt=${u.linkedinEnrichedAt??"-"}`)
}
process.exit(0)
