import { initializeApp, applicationDefault } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

initializeApp({ credential: applicationDefault(), projectId: "wekruit-5f89b" })
const db = getFirestore()

const snap = await db.collection("matching-jobs").where("status", "==", "active").limit(2000).get()
let enriched = 0, missing = 0, sampleEnriched = null, sampleMissing = null
const indSec = new Set(), roleFns = new Set()
for (const d of snap.docs) {
  const x = d.data()
  const hasCanon = (Array.isArray(x.roleFunction) && x.roleFunction.length>0)
                && (Array.isArray(x.industrySector) && x.industrySector.length>0)
                && Array.isArray(x.requiredSkills)
  if (hasCanon) {
    enriched++
    if (!sampleEnriched) sampleEnriched = { id: d.id, roleFunction: x.roleFunction, industrySector: x.industrySector, skills_n: (x.requiredSkills||[]).length, enricherVersion: x.enricherVersion }
    ;(x.industrySector||[]).forEach(v=>indSec.add(v))
    ;(x.roleFunction||[]).forEach(v=>roleFns.add(v))
  } else {
    missing++
    if (!sampleMissing) sampleMissing = { id: d.id, status: x.status, has_role_function: !!x.roleFunction, has_industry_sector: !!x.industrySector, enricherVersion: x.enricherVersion ?? null }
  }
}
console.log(JSON.stringify({total: snap.size, enriched, missing, indSec_n: indSec.size, roleFns_n: roleFns.size, sampleEnriched, sampleMissing}, null, 2))
process.exit(0)
