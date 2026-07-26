// READ-ONLY: how many of the WHOLE cohort have a company at all, and how many are enriched?
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const snap = await db.collection("pa-external-candidate-records").where("enrichment.cohort", "==", "yc_startup_school_2026").get()
let total = 0, enrichedOk = 0, hasCompany = 0, hasProfile = 0, profileWithWhat = 0, founderish = 0, founderHasProfile = 0
const noCompany = []
const PLACEHOLDER = new Set(["stealth", "stealth startup", "self-employed", "freelance", "-", ""])
for (const d of snap.docs) {
  total++
  const u = d.data()
  if (u.coresignalMatch !== "ok") continue
  enrichedOk++
  const co = String(u.currentCompany ?? "").trim()
  const title = String(u.currentTitle ?? "").toLowerCase()
  const isFounder = /founder|ceo|co-?founder/.test(title)
  if (isFounder) founderish++
  if (co && !PLACEHOLDER.has(co.toLowerCase())) hasCompany++
  else noCompany.push(`${u.name ?? "?"} | title="${u.currentTitle ?? "-"}" | company="${co}"`)
  const p = u.companyProfile
  if (p && typeof p === "object") { hasProfile++; if (p.whatTheyDo || p.matchLine) profileWithWhat++; if (isFounder) founderHasProfile++ }
}
console.log(`cohort records         ${total}`)
console.log(`coresignal ok          ${enrichedOk}`)
console.log(`has a REAL company     ${hasCompany}   (${Math.round(hasCompany/enrichedOk*100)}% of enriched)`)
console.log(`founder/CEO titled     ${founderish}`)
console.log(`companyProfile written ${hasProfile}   (founders among them: ${founderHasProfile})`)
console.log(`  ...with whatTheyDo   ${profileWithWhat}`)
console.log(`\nNO usable company (${noCompany.length}) — first 15:`)
noCompany.slice(0, 15).forEach((x) => console.log("   " + x))
process.exit(0)
