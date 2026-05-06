import admin from 'firebase-admin'
admin.initializeApp()
const db = admin.firestore()
const { queryMatchingJobsV16 } = await import('../../../apps/job-rec/src/tools/query-matching-jobs-v16.ts')

const ADAM_UID = 'e5d97cd8-1e1d-439d-8672-3008f8aeef2e'

console.log('=== ADAM V16 MATCH (post-fix, post-deploy, post-liveness-sweep) ===')
const log = (e, p) => console.log(`[${e}] ${JSON.stringify(p ?? {}).slice(0, 200)}`)
const res = await queryMatchingJobsV16({ userId: ADAM_UID, limit: 5 }, { db, log })

console.log(`\nFiltered: ${res.total}/${res.total + res.dropped}, hardFilter:`, JSON.stringify(res.hardFilter))
console.log(`adaptive freshness applied: ${res.hardFilter.freshness === 0 ? 'yes (all kept)' : 'check log'}`)

console.log(`\nADAM TOP ${res.jobs.length}:`)
for (let i = 0; i < res.jobs.length; i++) {
  const j = res.jobs[i]
  console.log(`\n${i+1}. ${j.jobTitle ?? j.roleTitle ?? '(no title)'} @ ${j.companyName ?? j.company ?? '(no company)'}`)
  console.log(`   url: ${(j.atsApplyUrl ?? '').slice(0, 90)}`)
  console.log(`   sponsor=${j.sponsorship} senior=${j.seniorityLevel}`)
  console.log(`   reason: ${j.reason}`)
  console.log(`   score: total=${j.v16Score?.total?.toFixed(3)} skill=${j.v16Score?.skillJaccard?.toFixed(3)} ind=${j.v16Score?.industrySector?.toFixed(3)}`)
}

console.log('\n=== EMAIL RENDER (zh) ===')
console.log('先给你看两个对得上的岗位:')
const top2 = res.jobs.slice(0, 2)
for (const j of top2) {
  console.log(`• ${j.jobTitle ?? j.roleTitle} @ ${j.companyName ?? j.company}`)
  if (j.atsApplyUrl) console.log(j.atsApplyUrl)
  if (j.reason) console.log(j.reason)
}
console.log('先看看, 不准就告诉我我再找; 之后每天会再给你新的')
