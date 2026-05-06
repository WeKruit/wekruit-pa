import admin from 'firebase-admin'
admin.initializeApp()
const db = admin.firestore()

console.log('=== RECENT MATCH OUTBOUND (any user) ===')
const recent = await db.collection('pa-outbound')
  .orderBy('createdAt', 'desc')
  .limit(30)
  .get()
let matchCount = 0
for (const d of recent.docs) {
  const data = d.data()
  const body = data.body ?? ''
  if (body.length > 50 && (body.includes('@') || body.match(/https:\/\/(?!sendblue)/) || body.includes('为啥推'))) {
    matchCount++
    if (matchCount > 6) break
    console.log(`---\nid=${d.id} uid=${data.userId} role=${data.role}`)
    console.log(`createdAt=${data.createdAt?._seconds ? new Date(data.createdAt._seconds * 1000).toISOString() : data.createdAt}`)
    console.log(`body=\n${body.slice(0, 1500)}`)
  }
}
console.log(`\ntotal match-shaped: ${matchCount}`)

console.log('\n=== MATCH LOOK-UP BY COMMON ROLE ===')
const recent2 = await db.collection('pa-outbound')
  .where('role', '==', 'assistant')
  .orderBy('createdAt', 'desc')
  .limit(40)
  .get()
let bigCount = 0
for (const d of recent2.docs) {
  const data = d.data()
  const body = data.body ?? ''
  if (body.length > 200) {
    bigCount++
    if (bigCount > 5) break
    console.log(`---\nid=${d.id} uid=${data.userId}`)
    console.log(`createdAt=${data.createdAt?._seconds ? new Date(data.createdAt._seconds * 1000).toISOString() : data.createdAt}`)
    console.log(`body=\n${body.slice(0, 2000)}`)
  }
}
