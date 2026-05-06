import admin from 'firebase-admin'
admin.initializeApp()
const db = admin.firestore()

// Import V16 from built dist (deploy in progress; use src TS via tsx)
const { queryMatchingJobsV16 } = await import('../../../apps/job-rec/src/tools/query-matching-jobs-v16.ts')

const ADAM_UID = 'e5d97cd8-1e1d-439d-8672-3008f8aeef2e'

console.log('=== ADAM V16 LIVE QUERY (post-fixes) ===')
const log = (event, payload) => console.log(`[${event}]`, JSON.stringify(payload ?? {}).slice(0, 200))
const res = await queryMatchingJobsV16(
  { userId: ADAM_UID, limit: 5 },
  { db, log }
)

console.log('\n=== RESULT ===')
console.log(`total filtered: ${res.total}`)
console.log(`dropped: ${res.dropped}`)
console.log(`hardFilter:`, JSON.stringify(res.hardFilter))
console.log(`noUserTags: ${res.noUserTags ?? false}`)
console.log(`llmCacheStale: ${res.llmCacheStale ?? false}`)

console.log(`\nTOP ${res.jobs?.length ?? 0} JOBS:`)
res.jobs?.forEach((j, i) => {
  console.log(`\n${i+1}. ${j.jobTitle ?? j.roleTitle} @ ${j.companyName ?? j.company}`)
  console.log(`   atsApplyUrl: ${(j.atsApplyUrl ?? '').slice(0, 80)}`)
  console.log(`   roleFunction: ${JSON.stringify(j.roleFunction)}`)
  console.log(`   seniorityLevel: ${j.seniorityLevel}`)
  console.log(`   sponsorship: ${j.sponsorship}`)
  console.log(`   firstSeenAt: ${j.firstSeenAt}`)
  console.log(`   v16Score: total=${j.v16Score?.total?.toFixed(3)} llm=${j.v16Score?.llmMatch} skill=${j.v16Score?.skillJaccard?.toFixed(3)} indSec=${j.v16Score?.industrySector?.toFixed(3)}`)
  console.log(`   matchedSkills: ${JSON.stringify(j.matchedSkills?.slice(0,2))}`)
  console.log(`   reason: ${j.reason}`)
})
