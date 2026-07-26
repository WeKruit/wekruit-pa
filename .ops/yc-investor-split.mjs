import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync("/Users/adam/Desktop/WeKruit/wekruit-pa/.claude/worktrees/serene-diffie-15b15a/.env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const snap = await db.collection("pa-external-candidate-records").where("enrichment.cohort","==","yc_startup_school_2026").get()
const primary = [], secondary = []
for (const d of snap.docs) {
  const x = d.data(); const pt = x.businessDescriptor?.personType ?? []
  if (pt[0] === "investor") primary.push(`${x.name} | ${x.currentTitle} @ ${x.currentCompany}`)
  else if (pt.includes("investor")) secondary.push(`${x.name} | ${x.currentTitle} @ ${x.currentCompany}`)
}
console.log(`PRIMARY investor (now eligible): ${primary.length}`)
for (const p of primary) console.log("  ✓ " + p)
console.log(`\nSECONDARY only (now correctly excluded): ${secondary.length}`)
for (const s of secondary) console.log("  ✗ " + s)
process.exit(0)
