import admin from 'firebase-admin'
admin.initializeApp()
const db = admin.firestore()

console.log('=== MATCHING-JOBS-LIVENESS-RUNS (Phase 57 paLivenessSweepDaily) ===')
const ls = await db.collection('matching-jobs-liveness-runs').orderBy('runAt', 'desc').limit(5).get()
console.log(`runs found: ${ls.size}`)
ls.docs.forEach(d => {
  const data = d.data()
  console.log(`runAt=${data.runAt} counters=${JSON.stringify(data.counters)}`)
})

console.log('\n=== MATCHING-JOBS-MIGRATION-AUDIT (Phase 55) ===')
const mig = await db.collection('matching-jobs-migration-audit').orderBy('startedAt', 'desc').limit(3).get()
console.log(`runs found: ${mig.size}`)
mig.docs.forEach(d => {
  const data = d.data()
  console.log(`runId=${d.id} mode=${data.mode} total=${data.total} processed=${data.processed} startedAt=${data.startedAt}`)
})

console.log('\n=== MATCHING-JOBS GLOBAL HEALTH ===')
const all = await db.collection('matching-jobs').count().get()
console.log(`total docs: ${all.data().count}`)
const active = await db.collection('matching-jobs').where('status', '==', 'active').count().get()
console.log(`active: ${active.data().count}`)
const dead = await db.collection('matching-jobs').where('dead', '==', true).count().get()
console.log(`dead=true: ${dead.data().count}`)
const noAts = await db.collection('matching-jobs').where('status', '==', 'active').limit(500).get()
let missingAts = 0, jobright = 0, valid = 0, withSponsor = 0, withSenior = 0, withStaff = 0, withSkillsArr = 0
for (const d of noAts.docs) {
  const j = d.data()
  if (!j.atsApplyUrl) missingAts++
  else if (/jobright\.ai/i.test(j.atsApplyUrl)) jobright++
  else valid++
  if (j.sponsorship === true) withSponsor++
  if (j.seniorityLevel === 'senior') withSenior++
  if (j.seniorityLevel === 'staff') withStaff++
  if (Array.isArray(j.requiredSkills) && j.requiredSkills.length > 0) withSkillsArr++
}
console.log(`active sample (500): missingAts=${missingAts} jobright=${jobright} valid=${valid} withSponsor=${withSponsor} senior=${withSenior} staff=${withStaff} hasReqSkills=${withSkillsArr}`)

console.log('\n=== PA-OUTBOUND RECENT MATCH EMAILS (sample reasoning quality) ===')
const recent = await db.collection('pa-outbound').orderBy('createdAt', 'desc').limit(40).get()
let matchSample = 0
for (const d of recent.docs) {
  const data = d.data()
  const body = data.body ?? ''
  if (body.includes('为啥推') || body.includes('why:')) {
    matchSample++
    if (matchSample > 3) break
    console.log(`---\nuid=${data.userId} createdAt=${data.createdAt?._seconds ? new Date(data.createdAt._seconds * 1000).toISOString() : data.createdAt}`)
    console.log(body.slice(0, 1200))
  }
}
console.log(`\ntotal match emails in last 40 outbound: ${matchSample}`)
