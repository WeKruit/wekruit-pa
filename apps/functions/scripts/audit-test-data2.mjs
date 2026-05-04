import admin from 'firebase-admin'
const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
admin.initializeApp({ credential: admin.credential.cert(sa) })
const db = admin.firestore()

async function main() {
  console.log('=== pa-users sample (3) ===')
  const usersSnap = await db.collection('pa-users').limit(3).get()
  usersSnap.docs.forEach(d => {
    console.log(`id=${d.id}`)
    console.log(`  keys=${Object.keys(d.data()).join(',')}`)
  })

  console.log('\n=== Search +199 in pa-users ===')
  const allUsers = await db.collection('pa-users').limit(500).get()
  const matches = []
  allUsers.docs.forEach(d => {
    const json = JSON.stringify(d.data())
    if (json.includes('+199')) matches.push({id: d.id, snippet: json.match(/\+199[\d]+/)?.[0]})
  })
  console.log(`Total +199 hits: ${matches.length} of ${allUsers.size}`)
  matches.slice(0,8).forEach(m => console.log(`  ${m.id} → ${m.snippet}`))

  console.log('\n=== pa-abuse-events sample (5 latest) ===')
  const abuseSnap = await db.collection('pa-abuse-events').limit(5).get()
  abuseSnap.docs.forEach(d => {
    console.log(`id=${d.id}`)
    console.log(`  keys=${Object.keys(d.data()).join(',')}`)
    console.log(`  data=${JSON.stringify(d.data()).slice(0,250)}`)
  })

  console.log(`\npa-abuse-events total in collection: scanning...`)
  const allAbuse = await db.collection('pa-abuse-events').get()
  console.log(`  ${allAbuse.size} total`)
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
