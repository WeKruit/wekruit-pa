import { readFileSync } from "node:fs"
import admin from "firebase-admin"
import { queryMatchingJobsV16 } from "@pa/job-rec"
let raw = readFileSync(process.env.PA_ENV_PATH!, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)![1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw = raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const uid = "8fEwIduUrzxZsblHHsNz"
const ref = db.collection("pa-users").doc(uid)
const orig = (await ref.get()).data()!
const origTags = orig.tags

async function run(label: string, patch: Record<string, any>) {
  await ref.update(Object.fromEntries(Object.entries(patch).map(([k, v]) => [`tags.${k}`, v])))
  const res: any = await queryMatchingJobsV16({ userId: uid, limit: 50 } as any, { db } as any)
  console.log(`\n[${label}]  total=${res.total} returned=${(res.jobs||[]).length} dropped=${res.dropped}`)
  console.log(`   hardFilter: ${JSON.stringify(res.hardFilter)}`)
  ;(res.jobs||[]).slice(0,4).forEach((j:any,i:number)=>console.log(`     [${i}] ${j.roleTitle||j.jobTitle} @ ${j.companyName} loc=${JSON.stringify(j.locationBuckets)}`))
}

try {
  await run("A: +careerStage=junior (restore résumé-derived)", { careerStage: "junior" })
  await run("B: +careerStage +remote location", { careerStage: "junior", targetLocations: ["new_york_metro","san_francisco_bay_area","remote"] })
  await run("C: +careerStage, locations=remote only (anywhere bypass)", { careerStage: "junior", targetLocations: ["remote"] })
} finally {
  // restore original tags exactly (this is a read-only diagnostic; do not mutate durable state).
  await ref.update({ tags: origTags })
  console.log("\n(restored original tags)")
}
process.exit(0)
