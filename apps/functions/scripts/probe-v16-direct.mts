import { readFileSync } from "node:fs"
import admin from "firebase-admin"
import { queryMatchingJobsV16 } from "@pa/job-rec"
let raw = readFileSync(process.env.PA_ENV_PATH!, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)![1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw = raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const uid = "8fEwIduUrzxZsblHHsNz"

const u = (await db.collection("pa-users").doc(uid).get()).data()!
console.log("tags:", JSON.stringify({ role: u.tags?.targetRoleFunction, loc: u.tags?.targetLocations, careerStage: u.tags?.careerStage, jobType: u.tags?.targetJobType, visa: u.tags?.visaStatus }))

const res: any = await queryMatchingJobsV16({ userId: uid, limit: 50 } as any, { db } as any)
console.log("\n=== V16 FULL result keys ===", Object.keys(res).join(", "))
console.log("total:", res.total, "| jobs:", (res.jobs||[]).length, "| dropped:", res.dropped)
console.log("needsOnboarding:", res.needsOnboarding, "| noUserTags:", res.noUserTags, "| missingAxes:", JSON.stringify(res.missingAxes))
console.log("hardFilter:", JSON.stringify(res.hardFilter))
console.log("freshnessWindowDays:", res.freshnessWindowDays ?? res.freshnessDays)
console.log("fallbackApplied:", res.fallbackApplied)
;(res.jobs||[]).slice(0,6).forEach((j:any,i:number)=>console.log(`  [${i}] ${j.roleTitle||j.jobTitle} @ ${j.companyName} loc=${JSON.stringify(j.locationBuckets)} fresh=${j.firstSeenAt} url=${j.atsApplyUrl?"y":"NULL"}`))
process.exit(0)
