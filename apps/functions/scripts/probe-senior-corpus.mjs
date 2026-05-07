import admin from 'firebase-admin'
admin.initializeApp()
const db = admin.firestore()

// Total by seniorityLevel (full corpus, not just active)
console.log('=== ALL matching-jobs by seniorityLevel ===')
const all = await db.collection('matching-jobs').limit(10000).get()
const slDist = {}
let totalScan = 0
all.docs.forEach(d => {
  totalScan++
  const sl = d.data().seniorityLevel ?? 'null'
  slDist[sl] = (slDist[sl] || 0) + 1
})
console.log(`scanned ${totalScan}/${all.size}, distribution:`)
Object.entries(slDist).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log(`  ${k}: ${v}`))

// Active + senior+
console.log('\n=== ACTIVE senior/staff/principal jobs ===')
for (const sl of ['senior', 'staff', 'principal', 'director', 'vp', 'c_level']) {
  const q = await db.collection('matching-jobs').where('status','==','active').where('seniorityLevel','==',sl).count().get()
  console.log(`  ${sl}: ${q.data().count}`)
}

// Title-regex search for "senior" / "staff" / "lead" in roleTitle (regardless of seniorityLevel field)
console.log('\n=== ACTIVE jobs with "Senior" in title (active SWE only) ===')
const sweAll = await db.collection('matching-jobs').where('status','==','active').where('roleFunction','array-contains','software_engineering').get()
let titleSenior=0, titleStaff=0, titlePrincipal=0, titleLead=0
const titleSamples = []
sweAll.docs.forEach(d => {
  const t = (d.data().roleTitle ?? '').toLowerCase()
  if (/\bsenior\b|\bsr\.?\b/.test(t)) { titleSenior++; if(titleSamples.length<5) titleSamples.push(d.data().roleTitle) }
  if (/\bstaff\b/.test(t)) titleStaff++
  if (/\bprincipal\b/.test(t)) titlePrincipal++
  if (/\blead\b/.test(t)) titleLead++
})
console.log(`active SWE total=${sweAll.size}: titleSenior=${titleSenior} titleStaff=${titleStaff} titlePrincipal=${titlePrincipal} titleLead=${titleLead}`)
console.log(`samples: ${titleSamples.join(' | ')}`)

// Total inactive senior corpus
console.log('\n=== INACTIVE senior+ ===')
for (const sl of ['senior', 'staff', 'principal']) {
  const q = await db.collection('matching-jobs').where('status','==','inactive').where('seniorityLevel','==',sl).count().get()
  console.log(`  inactive ${sl}: ${q.data().count}`)
}
