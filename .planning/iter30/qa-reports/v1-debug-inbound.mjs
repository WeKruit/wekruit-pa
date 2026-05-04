// Debug: where did my harness_ inbound events go?
import admin from 'firebase-admin'

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
admin.initializeApp({ credential: admin.credential.cert(sa) })
const db = admin.firestore()

const TARGET_USER_ID = 'e5d97cd8-1e1d-439d-8672-3008f8aeef2e'

async function main() {
  // List ALL inbound events from last 10 minutes
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString()
  const inbound = await db.collection('pa-inbound-events')
    .where('createdAt', '>=', cutoff)
    .limit(100)
    .get()
  const events = inbound.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  console.log(`═══ ALL inbound events since ${cutoff} (${events.length}) ═══`)
  for (const e of events) {
    const text = (e.rawPayload?.text || '').slice(0, 60).replace(/\n/g, ' ')
    const part = e.rawPayload?.participant || '?'
    console.log(`[${e.createdAt}] ${e.id} status=${e.status} part=${part} kind=${e.rawPayload?.kind} text="${text}"`)
    if (e.lastError || e.error) console.log(`  ERR: ${e.lastError || e.error}`)
  }

  // And check pa-messages for this user since 5 min
  const cutoff2 = new Date(Date.now() - 10 * 60 * 1000).toISOString()
  const msgs = await db.collection('pa-messages')
    .where('userId', '==', TARGET_USER_ID)
    .where('createdAt', '>=', cutoff2)
    .limit(100)
    .get()
  console.log(`\n═══ pa-messages for user since ${cutoff2} (${msgs.size}) ═══`)
  const sorted = msgs.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  for (const d of sorted) {
    const body = (d.body || d.text || '').slice(0, 150).replace(/\n/g, ' ')
    const eid = d.rawMeta?.eventId || '?'
    console.log(`[${d.createdAt}] ${d.role} eid=${eid}: ${body}`)
  }

  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
