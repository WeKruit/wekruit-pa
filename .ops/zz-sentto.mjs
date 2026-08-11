import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const uid = process.argv[2]
const u = (await db.collection("pa-users").doc(uid).get()).data() ?? {}
console.log("intake:", JSON.stringify(u.ycIntake ?? {}))
console.log("sentCount:", (u.ycPeopleMatchSent ?? []).length)
for (const rid of (u.ycPeopleMatchSent ?? [])) {
  const r = (await db.collection("pa-external-candidate-records").doc(rid).get()).data() ?? {}
  console.log(`  ${r.name} | ${r.currentTitle} @ ${r.currentCompany} | pt=${JSON.stringify(r.businessDescriptor?.personType ?? null)}`)
}
process.exit(0)
