import { readFileSync } from "node:fs"
import admin from "firebase-admin"
import { queryMatchingJobsV16 } from "@pa/job-rec"
let raw = readFileSync(process.env.PA_ENV_PATH!, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)![1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw = raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const uid = "8fEwIduUrzxZsblHHsNz"

const mb = () => Math.round(process.memoryUsage().rss / 1024 / 1024)
console.log(`baseline RSS: ${mb()}MB`)
for (let i = 0; i < 2; i++) {
  global.gc?.()
  const before = mb()
  const t = Date.now()
  const res: any = await queryMatchingJobsV16({ userId: uid, limit: 50 } as any, { db } as any)
  const ms = Date.now() - t
  console.log(`\nrun ${i+1}: ${ms}ms | RSS ${before}→${mb()}MB (Δ${mb()-before}) | total=${res.total} jobs=${(res.jobs||[]).length}`)
  ;(res.jobs||[]).slice(0,4).forEach((j:any)=>{
    const cos = j.matchScore?.cvEmbCosine ?? j.matchScore?.breakdown?.cvEmbCosine ?? "?"
    console.log(`   ${j.roleTitle||j.jobTitle} @ ${j.companyName} | cvEmbCosine=${typeof cos==="number"?cos.toFixed(3):cos} | total=${(j.matchScore?.total ?? j.matchScore?.breakdown?.total ?? "?")}`)
  })
}
process.exit(0)
