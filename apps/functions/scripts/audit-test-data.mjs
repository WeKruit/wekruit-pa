import admin from 'firebase-admin'
import fs from 'node:fs'
const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
admin.initializeApp({ credential: admin.credential.cert(sa) })
const db = admin.firestore()

async function main() {
  // Count +199 test phones in pa-users
  const usersSnap = await db.collection('pa-users').limit(500).get()
  const testUsers = usersSnap.docs.filter(d => {
    const h = d.get('handle') || d.get('participant') || d.get('imessageHandle') || ''
    return typeof h === 'string' && h.startsWith('+199')
  })
  console.log(`pa-users total scanned: ${usersSnap.size}`)
  console.log(`pa-users with +199 handle: ${testUsers.length}`)
  if (testUsers.length > 0) {
    console.log('sample 5:')
    testUsers.slice(0, 5).forEach(d => {
      const data = d.data()
      console.log(`  ${d.id} handle=${data.handle || data.participant || data.imessageHandle} created=${data.createdAt?.toDate?.() || data.createdAt}`)
    })
  }

  // Recent abuse events (last 24h)
  const cutoff = admin.firestore.Timestamp.fromDate(new Date(Date.now() - 24*60*60*1000))
  const abuseSnap = await db.collection('pa-abuse-events').where('createdAt', '>=', cutoff).limit(50).get()
  console.log(`\npa-abuse-events last 24h: ${abuseSnap.size}`)
  abuseSnap.docs.slice(0, 5).forEach(d => {
    const data = d.data()
    console.log(`  ${d.id} kind=${data.kind} created=${data.createdAt?.toDate?.()} signals=${JSON.stringify(data.signals || data.signal)} userId=${data.userId} channel=${data.channel}`)
  })

  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
