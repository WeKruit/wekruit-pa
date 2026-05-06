import admin from 'firebase-admin'
admin.initializeApp()
const db = admin.firestore()

const ADAM_UID = 'e5d97cd8-1e1d-439d-8672-3008f8aeef2e'

console.log('=== ADAM RECENT MATCH OUTBOUND ===')
const out = await db.collection('pa-outbound')
  .where('userId', '==', ADAM_UID)
  .orderBy('createdAt', 'desc')
  .limit(8)
  .get()
out.docs.forEach(d => {
  const data = d.data()
  const body = data.body ?? ''
  console.log(`---\nid=${d.id}\nrole=${data.role} status=${data.status}`)
  console.log(`createdAt=${data.createdAt?._seconds ? new Date(data.createdAt._seconds * 1000).toISOString() : data.createdAt}`)
  console.log(`body len=${body.length}`)
  console.log(`body=\n${body.slice(0, 1500)}\n---`)
})

console.log('\n=== MATCH MESSAGES BY DOC ID PREFIX ===')
const matchOut = await db.collection('pa-outbound')
  .where('userId', '==', ADAM_UID)
  .orderBy('createdAt', 'desc')
  .limit(20)
  .get()
matchOut.docs.forEach(d => {
  if (d.id.startsWith('out-jobrec') || d.id.startsWith('out-cvconfirm') || d.id.startsWith('out-match')) {
    const body = d.data().body ?? ''
    console.log(`---\nid=${d.id} body=${body.slice(0, 800)}`)
  }
})
