import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const snap = await db.collection("pa-external-candidate-records").where("enrichment.cohort","==","yc_startup_school_2026").get()
console.log("pool:", snap.size)
let withDesc = 0, withPt = 0
// Firm-name signal over COMPANY (data classification, not user-prose intent)
const FIRM = /\b(ventures?|capital|partners?|vc|fund|funds|angel|invest\w*|equity|holdings)\b/i
const cands = []
for (const d of snap.docs) {
  const x = d.data(); const bd = x.businessDescriptor
  if (bd) withDesc++
  const pt = bd?.personType ?? []
  if (pt.length) withPt++
  const co = String(x.currentCompany ?? ""), ti = String(x.currentTitle ?? "")
  const firmish = FIRM.test(co) || FIRM.test(ti)
  if (firmish || pt.includes("investor")) {
    cands.push({ id:d.id, name:x.name, ti, co, pt, firmish })
  }
}
console.log("withDescriptor:", withDesc, "withPersonType:", withPt)
console.log("\nCANDIDATE SET (firm-name signal OR personType has investor):", cands.length)
for (const c of cands.sort((a,b)=>String(a.co).localeCompare(String(b.co))))
  console.log(`  ${c.firmish?"F":" "}${c.pt[0]==="investor"?"P":c.pt.includes("investor")?"s":" "} | ${c.name} | ${c.ti} @ ${c.co} | ${JSON.stringify(c.pt)}`)
process.exit(0)
