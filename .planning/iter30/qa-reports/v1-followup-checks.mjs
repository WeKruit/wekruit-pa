// Follow-up: case-11 reply check + case 6/7 deeper inspection.
import admin from 'firebase-admin'

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
admin.initializeApp({ credential: admin.credential.cert(sa) })
const db = admin.firestore()

const TARGET_USER_ID = 'e5d97cd8-1e1d-439d-8672-3008f8aeef2e'

async function main() {
  // Case 11: get latest message via simple query (no compound index)
  const allRecent = await db.collection('pa-messages')
    .where('userId', '==', TARGET_USER_ID)
    .limit(50)
    .get()
  const docs = allRecent.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(d => d.createdAt)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  console.log('═══ Latest 20 pa-messages for target user ═══')
  for (const d of docs.slice(0, 20)) {
    const body = (d.body || d.text || '').slice(0, 150).replace(/\n/g, ' ')
    console.log(`[${d.createdAt}] ${d.role}: ${body}`)
  }

  // Final user state
  const u = (await db.collection('pa-users').doc(TARGET_USER_ID).get()).data() ?? {}
  console.log('\n═══ Final user record ═══')
  console.log(`onboardingState: ${u.onboardingState}`)
  console.log(`statedPreferences: ${JSON.stringify(u.statedPreferences)}`)
  console.log(`resumeAccepted: ${JSON.stringify(u.resumeAccepted)}`)
  console.log(`updatedAt: ${u.updatedAt}`)

  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
