import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH!, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)![1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw = raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const C = db.collection("matching-jobs")
const LEAN = ["status","roleFunction","firstSeenAt","lastSeenAt","dead","deadCheckedAt","deadReason","roleTitle","jobTitle","title","companyName","companySize","salaryMax","salaryMin","locationRaw","locationBuckets","primaryUrl","atsApplyUrl","sponsorship","jobType","seniorityLevel","requiredSkills","industry","industryKey","industryEnum","industrySector","relevantTags"]
// hard-filter-relevant fields — these MUST be identical between full + lean or a job's survival changes
const HARD = ["status","roleFunction","firstSeenAt","dead","locationBuckets","seniorityLevel","jobType","sponsorship","atsApplyUrl","salaryMin","salaryMax","industrySector"]

// pull 30 active SWE jobs full, then the SAME ids lean, diff hard fields
const fullSnap = await C.where("status","==","active").where("roleFunction","array-contains-any",["software_engineering"]).orderBy("firstSeenAt","desc").limit(30).get()
const ids = fullSnap.docs.map(d=>d.id)
const leanSnap = await (db as any).getAll(...ids.map(id=>C.doc(id)), { fieldMask: LEAN })
const leanById = new Map(leanSnap.map((s:any)=>[s.id, s.data()||{}]))
let mismatches = 0
for (const d of fullSnap.docs) {
  const full = d.data(), lean = leanById.get(d.id)!
  for (const f of HARD) {
    const fv = JSON.stringify(full[f] ?? null), lv = JSON.stringify(lean[f] ?? null)
    if (fv !== lv) { mismatches++; console.log(`  MISMATCH ${d.id.slice(0,8)} field=${f}: full=${fv.slice(0,40)} lean=${lv.slice(0,40)}`) }
  }
}
console.log(`\nhard-filter fields identical across ${ids.length} jobs? ${mismatches===0 ? "YES ✅ (lean field list complete)" : `NO — ${mismatches} mismatches`}`)
// glimpse specifically
const g = fullSnap.docs.find(d=>String(d.data().companyName||"").toLowerCase().includes("glimpse"))
console.log("glimpse in active-SWE top30?", g? `yes (${g.id.slice(0,8)}, firstSeenAt=${g.data().firstSeenAt})` : "NO — not in current active SWE set (catalog drift / aged out)")
process.exit(0)
