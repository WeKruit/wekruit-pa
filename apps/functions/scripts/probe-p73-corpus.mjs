import admin from 'firebase-admin'
admin.initializeApp()
const db = admin.firestore()

console.log('=== matching-jobs by source_repo (Phase 73 sources) ===')
const sources = ['greenhouse:anthropic', 'greenhouse:stripe', 'greenhouse:databricks',
                 'lever:spotify', 'lever:palantir',
                 'ashby:openai', 'ashby:linear', 'ashby:notion', 'ashby:ramp']
for (const sr of sources) {
  const c = await db.collection('matching-jobs').where('source_repo', '==', sr).count().get()
  console.log(`  ${sr}: ${c.data().count}`)
}

console.log('\n=== ACTIVE senior+ post-Phase-73 ===')
for (const sl of ['senior', 'staff', 'principal', 'director']) {
  const q = await db.collection('matching-jobs').where('status','==','active').where('seniorityLevel','==',sl).count().get()
  console.log(`  active ${sl}: ${q.data().count}`)
}

console.log('\n=== ACTIVE SWE senior+ ===')
const sweSr = await db.collection('matching-jobs').where('status','==','active').where('roleFunction','array-contains','software_engineering').limit(2000).get()
let count={intern:0,entry_level:0,junior:0,mid_level:0,senior:0,staff:0,principal:0,director:0,vp:0,c_level:0,null:0,other:0}
sweSr.docs.forEach(d => {
  const sl = d.data().seniorityLevel ?? 'null'
  if (count[sl] !== undefined) count[sl]++
  else count.other++
})
console.log(`active SWE total=${sweSr.size}:`)
Object.entries(count).filter(([_,v])=>v>0).forEach(([k,v])=>console.log(`  ${k}: ${v}`))

console.log('\n=== ADAM-FIT (senior + sponsor + fresh + non-jobright) ===')
let adamFit = 0
const samples = []
sweSr.docs.forEach(d => {
  const j = d.data()
  const sl = j.seniorityLevel
  if (!['senior','staff','principal','mid_level'].includes(sl)) return
  if (j.sponsorship !== true) return
  if (!j.atsApplyUrl || /jobright\.ai/i.test(j.atsApplyUrl)) return
  if (j.dead === true) return
  adamFit++
  if (samples.length < 5) samples.push(`[${sl}] ${j.roleTitle ?? j.title} @ ${j.company ?? j.companyName}`)
})
console.log(`Adam-fit count: ${adamFit}`)
samples.forEach(s => console.log(`  ${s}`))
