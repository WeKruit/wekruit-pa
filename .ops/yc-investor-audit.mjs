import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const snap = await db.collection("pa-external-candidate-records").where("enrichment.cohort","==","yc_startup_school_2026").get()
const inv = [], names = ["Jack Lau","Eric Xiao","Cynthia Zhang","Ryan Schwartz","Calvin Cha"]
let withType = 0
for (const d of snap.docs) {
  const x = d.data()
  const pt = x.businessDescriptor?.personType ?? []
  if (pt.length) withType++
  if (pt.includes("investor")) inv.push(`${x.name} | ${x.currentTitle} @ ${x.currentCompany} | ${pt.join(",")}`)
}
console.log(`cohort=${snap.size} withPersonType=${withType}`)
console.log(`labelled INVESTOR: ${inv.length}`)
for (const i of inv.slice(0,30)) console.log("  " + i)
console.log("\n--- the 5 actually sent ---")
for (const d of snap.docs) {
  const x = d.data()
  if (!names.includes(x.name)) continue
  console.log(`  ${x.name} | ${x.currentTitle} @ ${x.currentCompany} | personType=[${(x.businessDescriptor?.personType??[]).join(",")}]`)
}
process.exit(0)
