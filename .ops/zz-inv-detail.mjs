import { readFileSync, writeFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const snap = await db.collection("pa-external-candidate-records").where("enrichment.cohort","==","yc_startup_school_2026").get()
const FIRM = /\b(ventures?|capital|partners?|vc|fund|funds|angel|invest\w*|equity|holdings)\b/i
const out = []
for (const d of snap.docs) {
  const x = d.data(); const pt = x.businessDescriptor?.personType ?? []
  const co = String(x.currentCompany ?? ""), ti = String(x.currentTitle ?? "")
  const exp = (x.experience ?? []).slice(0,4).map(e=>`${e.title??""} @ ${e.company??""}`)
  const expHit = exp.some(e=>FIRM.test(e))
  if (FIRM.test(co) || FIRM.test(ti) || expHit || pt.includes("investor")) {
    out.push({ id:d.id, name:x.name, title:ti, company:co, pt, exp, build:(x.businessDescriptor?.whatTheyBuild??"").slice(0,110) })
  }
}
writeFileSync(process.argv[2], JSON.stringify(out,null,1))
console.log("candidates:", out.length)
process.exit(0)
