import admin from 'firebase-admin'
const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
admin.initializeApp({ credential: admin.credential.cert(sa) })
const db = admin.firestore()

const APPLY = process.argv.includes('--apply')

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`)
  const allUsers = await db.collection('pa-users').limit(500).get()
  const targets = []
  allUsers.docs.forEach(d => {
    const data = d.data()
    const phone = data.phoneE164 || ''
    if (typeof phone === 'string' && /^\+1999999\d{4}$/.test(phone) && data.testMode !== true) {
      targets.push({id: d.id, phone, createdAt: data.createdAt})
    }
  })
  console.log(`Targets: ${targets.length} pa-users with +1999999XXXX phone but no testMode=true`)
  if (targets.length === 0) { process.exit(0) }
  console.log('Sample 5:')
  targets.slice(0,5).forEach(t => console.log(`  ${t.id} ${t.phone} created=${t.createdAt}`))

  if (!APPLY) {
    console.log('\nDRY-RUN — no writes. Pass --apply to write testMode=true.')
    process.exit(0)
  }

  const writer = db.bulkWriter()
  let count = 0
  for (const t of targets) {
    writer.set(db.collection('pa-users').doc(t.id), { testMode: true, testModeBackfilledAt: new Date().toISOString() }, { merge: true })
    count++
  }
  await writer.close()
  console.log(`Wrote testMode=true to ${count} pa-users docs`)
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
