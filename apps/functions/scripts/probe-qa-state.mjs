import admin from 'firebase-admin'
admin.initializeApp()
const db = admin.firestore()

console.log('=== pa-qa-evaluator-runs (recent) ===')
const runs = await db.collection('pa-qa-evaluator-runs').orderBy('runAt', 'desc').limit(5).get()
runs.docs.forEach(d => {
  const r = d.data()
  console.log(`runId=${r.runId}\n  runAt=${r.runAt}\n  sampleSize=${r.sampleSize}\n  hardFilterPassRate=${r.hardFilterPassRate}\n  top3AcceptableRate=${r.top3AcceptableRate}\n  alertSent=${r.alertSent}\n  failingUserCount=${r.failingUserIds?.length ?? 0}\n  durationMs=${r.durationMs}`)
})

console.log('\n=== USERS WITH targetRoleFunction ===')
const users = await db.collection('pa-users').get()
let count = 0, real = 0, withRf = 0, realWithRf = 0, testMode = 0
users.docs.forEach(d => {
  const data = d.data()
  count++
  if (data.testMode === true) testMode++
  else real++
  const rf = data.tags?.targetRoleFunction
  if (rf?.length > 0) {
    withRf++
    if (data.testMode !== true) realWithRf++
  }
})
console.log(`total=${count} real=${real} testMode=${testMode}`)
console.log(`withTargetRoleFunction=${withRf} (real=${realWithRf})`)

console.log('\n=== ACTIVE MATCHING-JOBS WITH FRESH SWE ===')
const NOW = Date.now()
const FRESH_20D = NOW - 20*24*3600*1000
const FRESH_45D = NOW - 45*24*3600*1000
const FRESH_90D = NOW - 90*24*3600*1000
const sweJobs = await db.collection('matching-jobs')
  .where('status', '==', 'active')
  .where('roleFunction', 'array-contains', 'software_engineering')
  .orderBy('firstSeenAt', 'desc')
  .limit(500)
  .get()
let fresh20=0, fresh45=0, fresh90=0, total=0, withApply=0, sponsorTrue=0
sweJobs.docs.forEach(d => {
  const j = d.data()
  total++
  const fs = j.firstSeenAt?.toMillis?.() ?? 0
  if (fs >= FRESH_20D) fresh20++
  if (fs >= FRESH_45D) fresh45++
  if (fs >= FRESH_90D) fresh90++
  if (j.atsApplyUrl && !/jobright\.ai/i.test(j.atsApplyUrl)) withApply++
  if (j.sponsorship === true) sponsorTrue++
})
console.log(`SWE active sample (500): total=${total} fresh20d=${fresh20} fresh45d=${fresh45} fresh90d=${fresh90} withValidAts=${withApply} sponsorTrue=${sponsorTrue}`)

console.log('\n=== MOST RECENT SWE firstSeenAt (newest 5) ===')
sweJobs.docs.slice(0, 5).forEach(d => {
  const j = d.data()
  const fs = j.firstSeenAt?.toMillis ? new Date(j.firstSeenAt.toMillis()).toISOString() : 'invalid'
  console.log(`  ${fs} — ${j.roleTitle ?? j.title} @ ${j.company}`)
})
