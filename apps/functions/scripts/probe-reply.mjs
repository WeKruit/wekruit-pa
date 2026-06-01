import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw = raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const uid = "8fEwIduUrzxZsblHHsNz"

console.log("=== LAST 6 pa-outbound (what actually got SENT) ===")
const out = await db.collection("pa-outbound").where("userId","==",uid).get()
out.docs.map(d=>d.data()).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))).slice(0,6)
  .forEach(x=>console.log(`\n  ${x.createdAt} status=${x.status}\n  BODY: ${JSON.stringify(x.body)}`))

console.log("\n\n=== matching-jobs doc SCHEMA (1 active SWE job, ALL keys) ===")
const mj = await db.collection("matching-jobs").where("status","==","active").where("roleFunction","array-contains-any",["software_engineering"]).limit(3).get()
mj.docs.forEach((d,i)=>{
  const j=d.data()
  console.log(`\n  [job ${i}] id=${d.id}`)
  console.log(`  keys: ${Object.keys(j).join(", ")}`)
  console.log(`  title-ish: ${JSON.stringify({title:j.title, jobTitle:j.jobTitle, role:j.role, position:j.position, name:j.name})}`)
  console.log(`  company-ish: ${JSON.stringify({company:j.company, employer:j.employer, companyName:j.companyName, org:j.organization})}`)
  console.log(`  url-ish: ${JSON.stringify({atsApplyUrl:j.atsApplyUrl, applyUrl:j.applyUrl, url:j.url, jobUrl:j.jobUrl})}`)
})
process.exit(0)
