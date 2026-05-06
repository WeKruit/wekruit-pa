import admin from 'firebase-admin'
admin.initializeApp()
const db = admin.firestore()

const sweJobs = await db.collection('matching-jobs')
  .where('status', '==', 'active')
  .where('roleFunction', 'array-contains', 'software_engineering')
  .limit(5)
  .get()

console.log('=== firstSeenAt FIELD SHAPE ===')
sweJobs.docs.forEach(d => {
  const j = d.data()
  console.log(`---\nid=${d.id.slice(0, 30)}`)
  console.log(`  firstSeenAt type: ${typeof j.firstSeenAt}`)
  console.log(`  firstSeenAt value: ${JSON.stringify(j.firstSeenAt).slice(0, 150)}`)
  console.log(`  firstSeenAt._seconds: ${j.firstSeenAt?._seconds}`)
  console.log(`  firstSeenAt.seconds: ${j.firstSeenAt?.seconds}`)
  console.log(`  firstSeenAt.toMillis: ${typeof j.firstSeenAt?.toMillis}`)
  console.log(`  Date.parse: ${typeof j.firstSeenAt === 'string' ? Date.parse(j.firstSeenAt) : 'n/a'}`)
})

console.log('\n=== ALL TIMESTAMPS (first 1 job) ===')
const j = sweJobs.docs[0]?.data() ?? {}
for (const [k, v] of Object.entries(j)) {
  if (k.match(/(At|Date|Time)$/i) || k === 'createdAt' || k === 'updatedAt') {
    console.log(`  ${k}: ${typeof v} ${JSON.stringify(v).slice(0, 100)}`)
  }
}
