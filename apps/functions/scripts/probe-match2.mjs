import admin from 'firebase-admin'
admin.initializeApp()
const db = admin.firestore()

const ADAM_UID = 'e5d97cd8-1e1d-439d-8672-3008f8aeef2e'

console.log('=== ADAM SKILLS RAW ===')
const u = await db.collection('pa-users').doc(ADAM_UID).get()
const tags = u.data()?.tags
console.log('skills type:', Array.isArray(tags?.skills) ? 'array' : typeof tags?.skills)
console.log('skills length:', tags?.skills?.length)
console.log('skills[0] keys:', tags?.skills?.[0] ? Object.keys(tags.skills[0]) : 'null')
console.log('skills[0] raw:', JSON.stringify(tags?.skills?.[0]))
console.log('skills[1] raw:', JSON.stringify(tags?.skills?.[1]))
console.log('skills[2] raw:', JSON.stringify(tags?.skills?.[2]))

console.log('\n=== ADAM ALL OUTBOUND ===')
const out = await db.collection('pa-outbound')
  .where('userId', '==', ADAM_UID)
  .orderBy('createdAt', 'desc')
  .limit(5)
  .get()
out.docs.forEach(d => {
  const data = d.data()
  console.log(`---\nid=${d.id}\nstatus=${data.status} createdAt=${data.createdAt}`)
  console.log(`channel=${data.channel} type=${data.type} kind=${data.kind}`)
  console.log(`KEYS: ${Object.keys(data).join(',')}`)
  console.log(`text len=${(data.text ?? '').length}`)
  console.log(`text=${(data.text ?? '').slice(0, 1000)}`)
  console.log(`message=${JSON.stringify(data.message ?? null).slice(0, 500)}`)
  console.log(`payload=${JSON.stringify(data.payload ?? null).slice(0, 500)}`)
})

console.log('\n=== ADAM PARSED CANDIDATE RESUMES ===')
const pcr = await db.collection('parsedCandidateResumes')
  .where('userId', '==', ADAM_UID)
  .orderBy('createdAt', 'desc')
  .limit(2)
  .get()
pcr.docs.forEach(d => {
  const data = d.data()
  console.log(`---\nid=${d.id} createdAt=${data.createdAt}`)
  console.log(`KEYS: ${Object.keys(data).join(',')}`)
  console.log(`industries=${JSON.stringify(data.industries ?? data.industryTags)}`)
  console.log(`relevantIndustry=${JSON.stringify(data.relevantIndustry)}`)
  console.log(`skills count=${(data.skills ?? data.candidateProfile?.skills ?? []).length}`)
  console.log(`skills sample=${JSON.stringify((data.skills ?? data.candidateProfile?.skills ?? []).slice(0, 5))}`)
})
