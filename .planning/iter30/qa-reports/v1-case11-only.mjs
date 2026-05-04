// Case 11 isolated: send long message, fetch reply via direct event-id query.
import admin from 'firebase-admin'
import { randomUUID } from 'node:crypto'

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
admin.initializeApp({ credential: admin.credential.cert(sa) })
const db = admin.firestore()

const TARGET_USER_ID = 'e5d97cd8-1e1d-439d-8672-3008f8aeef2e'
const TARGET_PHONE = '+14243201960'

function nowIso() { return new Date().toISOString() }

async function sendBrokerInbound(text) {
  const id = `harness_${randomUUID()}`
  const idempotencyKey = `harness:${id}`
  await db.collection('pa-inbound-events').doc(id).set({
    id,
    status: 'pending',
    idempotencyKey,
    createdAt: nowIso(),
    attemptCount: 0,
    maxAttempts: 1,
    channel: 'imessage',
    rawPayload: {
      kind: 'imessage',
      participant: TARGET_PHONE,
      chatId: `iMessage;${TARGET_PHONE}`,
      messageRowId: Date.now(),
      text,
      harness: { runner: 'v1-case11-only', suppressOutbound: true },
    },
  })
  return id
}

async function pollUntilStatus(eventId, timeoutMs = 90000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const snap = await db.collection('pa-inbound-events').doc(eventId).get()
    const d = snap.data()
    if (d) {
      if (d.status === 'succeeded' || d.status === 'completed') return d
      if (d.status === 'failed' || d.status === 'dead_letter') {
        throw new Error(`inbound ${eventId} ${d.status}: ${d.lastError ?? d.error ?? 'unknown'}`)
      }
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`timeout`)
}

async function main() {
  // Reset first
  console.log('[step 1] reset')
  const rid = await sendBrokerInbound('__PA_RESET__')
  await pollUntilStatus(rid)
  await new Promise((r) => setTimeout(r, 3000))

  // Send 500-char msg
  console.log('[step 2] send 500-char message')
  const longMsg = '我'.repeat(500)
  console.log(`  message length: ${longMsg.length}`)
  const eid = await sendBrokerInbound(longMsg)
  console.log(`  eventId: ${eid}`)
  const t0 = Date.now()
  const data = await pollUntilStatus(eid)
  console.log(`  status: ${data.status}, elapsed: ${Date.now() - t0}ms`)
  if (data.lastError) console.log(`  lastError: ${data.lastError}`)

  await new Promise((r) => setTimeout(r, 3000))

  // Look up reply by event ID
  console.log('[step 3] lookup reply')
  const snap = await db.collection('pa-messages')
    .where('rawMeta.eventId', '==', eid)
    .where('role', '==', 'assistant')
    .limit(5).get()
  console.log(`  matches by eventId: ${snap.size}`)
  for (const doc of snap.docs) {
    const d = doc.data()
    const body = (d.body || d.text || '').slice(0, 500)
    console.log(`  ⇒ ${body}`)
  }

  // Also look at user state
  const u = (await db.collection('pa-users').doc(TARGET_USER_ID).get()).data() ?? {}
  console.log(`\nuser state: onboardingState=${u.onboardingState} statedPrefs=${u.statedPreferences ? 'SET' : 'CLEARED'}`)

  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
