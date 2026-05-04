// Check case 11: inbound + assistant reply for very-long message.
import admin from 'firebase-admin'

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
admin.initializeApp({ credential: admin.credential.cert(sa) })
const db = admin.firestore()

const TARGET_USER_ID = 'e5d97cd8-1e1d-439d-8672-3008f8aeef2e'

async function main() {
  // Find recent inbound events for this user
  const inbound = await db.collection('pa-inbound-events')
    .where('rawPayload.participant', '==', '+14243201960')
    .limit(50)
    .get()
  const events = inbound.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  console.log('═══ Latest 10 inbound events ═══')
  for (const e of events.slice(0, 10)) {
    const text = (e.rawPayload?.text || '').slice(0, 80).replace(/\n/g, ' ')
    console.log(`[${e.createdAt}] ${e.id} status=${e.status} textLen=${(e.rawPayload?.text || '').length} preview="${text}"`)
    if (e.lastError || e.error) console.log(`  ERR: ${e.lastError || e.error}`)
  }

  // Latest 30 messages
  const allRecent = await db.collection('pa-messages')
    .where('userId', '==', TARGET_USER_ID)
    .limit(50)
    .get()
  const docs = allRecent.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(d => d.createdAt)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  console.log('\n═══ Latest 30 pa-messages for target user ═══')
  for (const d of docs.slice(0, 30)) {
    const body = (d.body || d.text || '').slice(0, 200).replace(/\n/g, ' ')
    console.log(`[${d.createdAt}] ${d.role}: ${body}`)
  }

  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
