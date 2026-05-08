import { initializeApp, applicationDefault } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
initializeApp({ credential: applicationDefault(), projectId: "wekruit-5f89b" })
const db = getFirestore()

// sample broader: random offset
const snap = await db.collection("matching-jobs").where("status", "==", "active").limit(8000).get()
let enriched = 0, missing = 0
const inds = new Map()
const versions = new Map()
let skillSchemaObj = 0, skillSchemaStr = 0, skillSchemaEmpty = 0, sampleSkillObj = null
let relevantTagsSeen = 0
for (const d of snap.docs) {
  const x = d.data()
  const hasCanon = (Array.isArray(x.roleFunction) && x.roleFunction.length>0)
                && (Array.isArray(x.industrySector) && x.industrySector.length>0)
  if (hasCanon) enriched++; else missing++
  ;(x.industrySector||[]).forEach(v=>inds.set(v,(inds.get(v)||0)+1))
  versions.set(x.enricherVersion ?? "none", (versions.get(x.enricherVersion ?? "none")||0)+1)
  const sk = Array.isArray(x.requiredSkills) ? x.requiredSkills : []
  if (sk.length === 0) skillSchemaEmpty++
  else if (typeof sk[0] === "string") skillSchemaStr++
  else if (typeof sk[0] === "object") { skillSchemaObj++; if (!sampleSkillObj) sampleSkillObj = sk[0] }
  if (Array.isArray(x.relevantTags) && x.relevantTags.length > 0) relevantTagsSeen++
}
const sortedInd = Array.from(inds.entries()).sort((a,b)=>b[1]-a[1]).slice(0,15)
console.log(JSON.stringify({
  total: snap.size, enriched, missing,
  versions: Array.from(versions.entries()),
  industrySectorTop: sortedInd,
  industrySectorUnique: inds.size,
  skillSchema: {obj: skillSchemaObj, str: skillSchemaStr, empty: skillSchemaEmpty},
  relevantTagsSeen,
  sampleSkillObj
}, null, 2))
process.exit(0)
