import admin from 'firebase-admin'
admin.initializeApp()
const db = admin.firestore()

console.log('=== matching-jobs-sponsorship-runs (latest) ===')
const runs = await db.collection('matching-jobs-sponsorship-runs').orderBy('startedAt', 'desc').limit(3).get()
runs.docs.forEach(d => {
  const r = d.data()
  console.log(`runId=${r.runId} mode=${r.mode} total=${r.total} inferred=${r.inferred} startedAt=${r.startedAt} completedAt=${r.completedAt ?? 'INCOMPLETE'}`)
  if (r.sources) console.log(`  sources: ${JSON.stringify(r.sources)}`)
  if (r.sponsorshipDistribution) console.log(`  distribution: ${JSON.stringify(r.sponsorshipDistribution)}`)
})

console.log('\n=== CURRENT MATCHING-JOBS SPONSORSHIP DISTRIBUTION ===')
const all = await db.collection('matching-jobs').where('status', '==', 'active').limit(2000).get()
let total=0, t=0, f=0, n=0, allowlist=0, jdInf=0
all.docs.forEach(d => {
  const j = d.data()
  total++
  if (j.sponsorship === true) t++
  else if (j.sponsorship === false) f++
  else n++
  if (j.sponsorshipSource === 'allowlist') allowlist++
  else if (j.sponsorshipSource?.startsWith('jd_inference')) jdInf++
})
console.log(`total active=${total}: true=${t}(${(100*t/total).toFixed(1)}%) false=${f}(${(100*f/total).toFixed(1)}%) null=${n}(${(100*n/total).toFixed(1)}%)`)
console.log(`source: allowlist=${allowlist} jd_inference=${jdInf}`)
