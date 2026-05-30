// Prove enriched collab jobs surface for a clean SWE user (open location).
// Creates a throwaway test user, runs V16, then deletes it. Isolates the
// enrichment correctness from the pre-existing per-cohort location/careerStage
// recall gap (see memory matching_recall_gap_2026_05_28).
// Run FROM apps/functions:
//   PA_ENV_PATH=/Users/adam/Desktop/WeKruit/wekruit-pa/.env node --import tsx scripts/verify-collab-testuser.mts
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
import { queryMatchingJobsV16 } from "@pa/job-rec"
let raw = readFileSync(process.env.PA_ENV_PATH!, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)![1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()

const COLLAB_IDS = new Set(["helium-product-engineer-fullstack","hs-10996795-invoko-product-manager","hs-11005377-invoko-ui-ux-designer","hs-11005382-invoko-product-designer","metavoice-research-scientist-post-training","metavoice-software-engineer-data-evals","voicecursor-founding-engineer","voicecursor-founding-growth","voicecursor-founding-pm","wekruit-37429d02-photon-macos-devops","wekruit-973f2953-photon-objective-c-engineer"])

const TEST_UID = "zzz-collab-verify-throwaway"
await db.collection("pa-users").doc(TEST_UID).set({
  tags: {
    schemaVersion: 2,
    targetRoleFunction: ["software_engineering"],
    careerStage: "mid_level",   // window {junior,mid,senior} covers SWE collab jobs
    targetLocations: [],         // EMPTY → isAnywhere bypass (open to anything)
    skills: [{ name: "typescript" }, { name: "react" }, { name: "python" }],
  },
})

try {
  const res: any = await queryMatchingJobsV16({ userId: TEST_UID, limit: 50 }, { db } as any)
  const jobs = res.jobs ?? []
  const collabHits = jobs.filter((j: any) => COLLAB_IDS.has(j.id ?? j.jobId))
  console.log(`Clean SWE user (open location): returned=${jobs.length} total=${res.total} collabHits=${collabHits.length}`)
  console.log(`hardFilter:`, JSON.stringify(res.hardFilter))
  for (const j of collabHits) {
    console.log(`   COLLAB MATCH: ${j.id} | ${j.companyName} | ${j.jobTitle ?? j.roleTitle} | source="${j.matchSourceLabel}" | score=${j.v16Score?.total?.toFixed?.(3)}`)
  }
  const res2: any = await queryMatchingJobsV16({ userId: TEST_UID, limit: 50, collabPrescreenOnly: true }, { db } as any)
  const jobs2 = res2.jobs ?? []
  const collabHits2 = jobs2.filter((j: any) => COLLAB_IDS.has(j.id ?? j.jobId))
  console.log(`\nCOLLAB-PRESCREEN-ONLY: returned=${jobs2.length} collabHits=${collabHits2.length}`)
  for (const j of collabHits2) console.log(`   PRESCREEN COLLAB: ${j.id} | ${j.companyName} | ${j.jobTitle ?? j.roleTitle}`)
} finally {
  await db.collection("pa-users").doc(TEST_UID).delete()
  console.log("\n(throwaway test user deleted)")
}
process.exit(0)
