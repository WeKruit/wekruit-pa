import admin from 'firebase-admin'
admin.initializeApp()
const db = admin.firestore()
const ADAM = 'e5d97cd8-1e1d-439d-8672-3008f8aeef2e'

const cv = await db.collection('parsedCandidateResumes').where('userId', '==', ADAM).orderBy('createdAt', 'desc').limit(1).get()
const d = cv.docs[0]?.data()
if (!d) { console.log('no CV'); process.exit() }
console.log('=== ADAM WORK HISTORY (top 3) ===')
const wh = d.workHistory ?? d.experiences ?? []
wh.slice(0, 3).forEach(e => {
  console.log(`---\ntitle: ${e.title}\ncompany: ${e.company}\ndates: ${e.startDate} → ${e.endDate}`)
  console.log(`bullets: ${(e.bullets ?? e.achievements ?? []).slice(0, 3).join(' / ').slice(0, 400)}`)
  console.log(`description: ${(e.description ?? '').slice(0, 300)}`)
})
console.log('\n=== TOP SKILLS ===')
console.log((d.topSkills ?? d.candidateProfile?.skills ?? []).slice(0, 15).join(', '))
console.log('\n=== PROJECTS top 2 ===')
;(d.projects ?? []).slice(0, 2).forEach(p => {
  console.log(`- ${p.name}: ${(p.description ?? '').slice(0, 200)} [tech: ${(p.technologies ?? []).join(',')}]`)
})
