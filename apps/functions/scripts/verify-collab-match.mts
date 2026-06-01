// Verify enriched collab jobs now match for a test SWE/junior US candidate.
// Run FROM apps/functions:
//   PA_ENV_PATH=/Users/adam/Desktop/WeKruit/wekruit-pa/.env node --import tsx scripts/verify-collab-match.mts
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
import { queryMatchingJobsV16 } from "@pa/job-rec"

let raw = readFileSync(process.env.PA_ENV_PATH!, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)![1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()

const COLLAB_IDS = new Set([
  "helium-product-engineer-fullstack","hs-10996795-invoko-product-manager","hs-11005377-invoko-ui-ux-designer",
  "hs-11005382-invoko-product-designer","metavoice-research-scientist-post-training","metavoice-software-engineer-data-evals",
  "voicecursor-founding-engineer","voicecursor-founding-growth","voicecursor-founding-pm",
  "wekruit-37429d02-photon-macos-devops","wekruit-973f2953-photon-objective-c-engineer",
])

const userId = process.argv[2] || "8fEwIduUrzxZsblHHsNz"
const u = (await db.collection("pa-users").doc(userId).get()).data() as any
console.log(`Test user ${userId}: targetRoleFunction=${JSON.stringify(u?.tags?.targetRoleFunction)} careerStage=${u?.tags?.careerStage} visa=${u?.tags?.visaStatus} locs=${JSON.stringify(u?.tags?.targetLocations)}\n`)

async function run(label: string, collabPrescreenOnly: boolean) {
  const res: any = await queryMatchingJobsV16({ userId, limit: 25, ...(collabPrescreenOnly ? { collabPrescreenOnly: true } : {}) }, { db } as any)
  const jobs = res?.jobs ?? res?.matches ?? res?.results ?? []
  const collabHits = jobs.filter((j: any) => COLLAB_IDS.has(j.jobId ?? j.id ?? j.job?.id))
  console.log(`--- ${label} --- returned=${jobs.length} collabHits=${collabHits.length}`)
  if (res?.hardFilter || res?.hardFilterCounters || res?.diagnostics) {
    console.log(`   hardFilter:`, JSON.stringify(res.hardFilter ?? res.hardFilterCounters ?? res.diagnostics))
  }
  for (const j of collabHits.slice(0, 12)) {
    console.log(`   COLLAB: ${j.jobId ?? j.id} | ${j.companyName ?? j.company ?? ""} | ${j.jobTitle ?? j.roleTitle ?? j.title ?? ""} | source=${j.matchSource ?? j.source ?? "?"}`)
  }
  return collabHits.length
}

const general = await run("GENERAL match (collabPrescreenOnly=false)", false)
console.log("")
const prescreen = await run("COLLAB-PRESCREEN-ONLY (collabPrescreenOnly=true)", true)
console.log(`\n=== RESULT: collab jobs in general=${general}, in collab-prescreen-only=${prescreen} ===`)
process.exit(0)
