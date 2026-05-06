import admin from 'firebase-admin'
admin.initializeApp()
const db = admin.firestore()

const FRESH_CUTOFF = Date.now() - 20 * 24 * 3600 * 1000
const FRESH_ISO = new Date(FRESH_CUTOFF).toISOString()

console.log(`=== MATCHING-JOBS CORPUS HEALTH ===`)
console.log(`fresh cutoff: ${FRESH_ISO} (20d ago)`)

// Total active
const all = await db.collection('matching-jobs').where('status', '==', 'active').count().get()
console.log(`total active: ${all.data().count}`)

// Active SWE within 20d
const sweFresh = await db.collection('matching-jobs')
  .where('status', '==', 'active')
  .where('roleFunction', 'array-contains', 'software_engineering')
  .orderBy('firstSeenAt', 'desc')
  .limit(200)
  .get()

let withinFresh = 0
let bySeniority = {}
let withSponsor = 0
let nonJobright = 0
const samples = []
for (const d of sweFresh.docs) {
  const j = d.data()
  const fs = j.firstSeenAt?.toMillis?.() ?? 0
  const fresh = fs >= FRESH_CUTOFF
  if (fresh) withinFresh++
  const sl = j.seniorityLevel ?? 'null'
  bySeniority[sl] = (bySeniority[sl] || 0) + 1
  if (j.sponsorship === true) withSponsor++
  if (j.atsApplyUrl && !/jobright\.ai/i.test(j.atsApplyUrl)) nonJobright++
  if (samples.length < 5 && fresh && j.sponsorship === true) {
    samples.push({ title: j.roleTitle, company: j.company, seniority: sl, sponsor: j.sponsorship, fs: new Date(fs).toISOString(), atsUrl: j.atsApplyUrl?.slice(0, 60) })
  }
}
console.log(`SWE active sample (200 most recent):`)
console.log(`  within 20d freshness: ${withinFresh}`)
console.log(`  by seniorityLevel: ${JSON.stringify(bySeniority)}`)
console.log(`  with sponsor=true: ${withSponsor}`)
console.log(`  non-jobright atsApplyUrl: ${nonJobright}`)
console.log(`\nSample fresh+sponsor jobs:`)
samples.forEach(s => console.log(JSON.stringify(s)))

// Adam-fit: senior + sponsor + fresh + non-jobright
const adamFit = sweFresh.docs.filter(d => {
  const j = d.data()
  const fs = j.firstSeenAt?.toMillis?.() ?? 0
  const sl = j.seniorityLevel ?? ''
  return fs >= FRESH_CUTOFF
    && j.sponsorship === true
    && j.atsApplyUrl && !/jobright\.ai/i.test(j.atsApplyUrl)
    && j.dead !== true
    && ['senior','staff','principal','mid_level'].includes(sl)
})
console.log(`\nAdam-fit (senior+sponsor+fresh+non-jobright): ${adamFit.length}`)
adamFit.slice(0, 5).forEach(d => {
  const j = d.data()
  console.log(`  ${j.roleTitle} @ ${j.company} [${j.seniorityLevel}] sponsor=${j.sponsorship} fs=${new Date(j.firstSeenAt.toMillis()).toISOString()}`)
})
