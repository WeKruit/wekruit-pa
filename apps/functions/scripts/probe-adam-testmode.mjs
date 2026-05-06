import admin from 'firebase-admin'
admin.initializeApp()
const db = admin.firestore()

const ADAM = 'e5d97cd8-1e1d-439d-8672-3008f8aeef2e'
const u = await db.collection('pa-users').doc(ADAM).get()
const data = u.data()
console.log(`Adam testMode: ${data?.testMode}`)
console.log(`Adam onboardingState: ${data?.onboardingState}`)
console.log(`Adam tags.targetRoleFunction: ${JSON.stringify(data?.tags?.targetRoleFunction)}`)
console.log(`Adam keys: ${Object.keys(data ?? {}).join(', ').slice(0, 200)}`)

console.log('\n=== Real users WITH skills (no testMode flag) ===')
const all = await db.collection('pa-users').get()
let realCount = 0, withSkills = 0, withTargetRf = 0
const samples = []
all.docs.forEach(d => {
  const data = d.data()
  if (data.testMode === true) return
  realCount++
  const rf = data.tags?.targetRoleFunction
  const sk = data.tags?.skills
  if (Array.isArray(sk) && sk.length > 0) withSkills++
  if (Array.isArray(rf) && rf.length > 0) {
    withTargetRf++
    if (samples.length < 5) samples.push({ uid: d.id.slice(0, 8), rf, skillCount: sk?.length ?? 0 })
  }
})
console.log(`real users (testMode!=true): ${realCount}`)
console.log(`real with skills: ${withSkills}`)
console.log(`real with targetRoleFunction: ${withTargetRf}`)
samples.forEach(s => console.log(`  ${s.uid} rf=${JSON.stringify(s.rf)} skills=${s.skillCount}`))
