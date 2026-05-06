import admin from 'firebase-admin'
admin.initializeApp()
const db = admin.firestore()

const ADAM_UID = 'e5d97cd8-1e1d-439d-8672-3008f8aeef2e'

console.log('=== ADAM TAGS ===')
const u = await db.collection('pa-users').doc(ADAM_UID).get()
const tags = u.data()?.tags
console.log(JSON.stringify({
  targetRoleFunction: tags?.targetRoleFunction,
  industrySector: tags?.industrySector,
  relevantIndustry: tags?.relevantIndustry,
  visaStatus: tags?.visaStatus,
  careerStage: tags?.careerStage,
  yoeRange: tags?.yoeRange,
  targetLocations: tags?.targetLocations,
  targetJobType: tags?.targetJobType,
  skills: (tags?.skills ?? []).slice(0, 8).map(s => `${s.name}/${s.bucket}/${s.proficiency}`),
}, null, 2))

console.log('\n=== RECENT PA-OUTBOUND MATCH MESSAGES ===')
const out = await db.collection('pa-outbound')
  .where('userId', '==', ADAM_UID)
  .orderBy('createdAt', 'desc')
  .limit(5)
  .get()
console.log(`found ${out.size} outbound for adam`)
out.docs.forEach(d => {
  const data = d.data()
  console.log(`---\nid=${d.id}\nstatus=${data.status} createdAt=${data.createdAt}`)
  console.log(`text=${(data.text ?? '').slice(0, 800)}`)
})

console.log('\n=== ANY RECENT MATCH EMAILS GLOBAL ===')
const recent = await db.collection('pa-outbound')
  .orderBy('createdAt', 'desc')
  .limit(10)
  .get()
recent.docs.forEach(d => {
  const data = d.data()
  if ((data.text ?? '').match(/为啥推|jobs|recommendation|@\s|http/i)) {
    console.log(`---\nuid=${data.userId} id=${d.id} createdAt=${data.createdAt}`)
    console.log(`text=${(data.text ?? '').slice(0, 600)}`)
  }
})
