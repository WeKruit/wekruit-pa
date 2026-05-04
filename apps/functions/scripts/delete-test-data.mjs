import admin from 'firebase-admin'
const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
admin.initializeApp({ credential: admin.credential.cert(sa) })
const db = admin.firestore()

const APPLY = process.argv.includes('--apply')

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY DELETE' : 'DRY-RUN'}`)

  // 1. test pa-users (+1999999XXXX)
  const usersSnap = await db.collection('pa-users').limit(500).get()
  const testUsers = usersSnap.docs.filter(d => {
    const phone = d.get('phoneE164') || ''
    return typeof phone === 'string' && /^\+1999999\d{4}$/.test(phone)
  })
  console.log(`pa-users to delete: ${testUsers.length}`)

  // 2. all pa-abuse-events (all 31 are synthetic prompt_injection from today's scenario tests)
  const abuseSnap = await db.collection('pa-abuse-events').get()
  console.log(`pa-abuse-events to delete: ${abuseSnap.size}`)

  if (!APPLY) {
    console.log('DRY-RUN — no deletes. Pass --apply.')
    process.exit(0)
  }

  let deleted = 0
  const writer = db.bulkWriter()
  for (const d of testUsers) { writer.delete(d.ref); deleted++ }
  for (const d of abuseSnap.docs) { writer.delete(d.ref); deleted++ }
  await writer.close()
  console.log(`Deleted ${deleted} docs total (${testUsers.length} pa-users + ${abuseSnap.size} pa-abuse-events)`)
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
