import admin from 'firebase-admin'
const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
admin.initializeApp({ credential: admin.credential.cert(sa) })
const db = admin.firestore()

async function main() {
  const allUsers = await db.collection('pa-users').limit(500).get()
  let withTestMode = 0, withoutTestMode = 0, plus199 = 0, plus199_testMode = 0
  const recentTest = []
  allUsers.docs.forEach(d => {
    const data = d.data()
    const phone = data.phoneE164 || ''
    const isPlus199 = typeof phone === 'string' && phone.startsWith('+199')
    if (isPlus199) plus199++
    if (data.testMode === true) withTestMode++
    else withoutTestMode++
    if (isPlus199 && data.testMode === true) plus199_testMode++
    if (isPlus199 && !data.testMode) recentTest.push({id: d.id, phone, createdAt: data.createdAt, testMode: data.testMode})
  })
  console.log(`pa-users total scanned: ${allUsers.size}`)
  console.log(`  +199 phones: ${plus199}`)
  console.log(`  testMode=true: ${withTestMode}`)
  console.log(`  +199 AND testMode=true: ${plus199_testMode}`)
  console.log(`  +199 BUT no testMode flag: ${recentTest.length}`)
  console.log('Sample +199 without testMode flag:')
  recentTest.slice(0,5).forEach(r => console.log(`  ${JSON.stringify(r)}`))

  // pa-abuse-events createdAt distribution
  const abuse = await db.collection('pa-abuse-events').get()
  console.log(`\npa-abuse-events total: ${abuse.size}`)
  const today = abuse.docs.filter(d => {
    const c = d.get('createdAt') || ''
    return typeof c === 'string' && c.startsWith('2026-05-03')
  })
  console.log(`  today (2026-05-03): ${today.length}`)
  const channels = new Set()
  abuse.docs.forEach(d => channels.add(d.get('channel') || 'none'))
  console.log(`  channels: ${[...channels].join(',')}`)
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
