import admin from 'firebase-admin'
admin.initializeApp()
const db = admin.firestore()

console.log('=== ACTIVE jobs with raw multi-tier seniorityLevel ===')
const all = await db.collection('matching-jobs').where('status','==','active').get()
let multiSr = 0, totalActive = 0, sweMultiSr = 0
const samples = []
all.docs.forEach(d => {
  totalActive++
  const j = d.data()
  const sl = j.seniorityLevel ?? ''
  if (/Senior|Staff|Lead/i.test(sl) && sl.match(/,| /)) {
    multiSr++
    const isSwe = (j.roleFunction ?? []).includes('software_engineering')
    if (isSwe) sweMultiSr++
    if (samples.length < 8) samples.push({title: j.roleTitle, company: j.company, sl, sponsor: j.sponsorship, swe: isSwe})
  }
})
console.log(`active total=${totalActive} multi-tier-with-senior=${multiSr} sweMultiSr=${sweMultiSr}`)
samples.forEach(s => console.log(`  [SWE=${s.swe}] sl="${s.sl}" sponsor=${s.sponsor} :: ${s.title} @ ${s.company}`))
