// Minimal repro: set state=complete, fire ONE inbound, capture state mid-flight
import admin from 'firebase-admin'
import { randomUUID } from 'node:crypto'

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
admin.initializeApp({ credential: admin.credential.cert(sa) })
const db = admin.firestore()

const USER = 'e5d97cd8-1e1d-439d-8672-3008f8aeef2e'
const PHONE = '+14243201960'

function nowIso() { return new Date().toISOString() }

async function main() {
  // Set state=complete
  await db.collection('pa-users').doc(USER).set({
    onboardingState: 'complete',
    statedPreferences: { role: 'engineer', yoe: '5+', location: 'sf' },
    resumeAccepted: { at: nowIso(), expiresAt: new Date(Date.now()+86400000).toISOString(), triggerHash: 'preexisting' },
    testMode: true,
    updatedAt: nowIso(),
  }, { merge: true })

  // Re-read to confirm before firing
  const before = (await db.collection('pa-users').doc(USER).get()).data()
  console.log('BEFORE inbound:')
  console.log('  onboardingState:', before.onboardingState)
  console.log('  statedPreferences:', JSON.stringify(before.statedPreferences))

  // Fire ONE broker inbound
  const id = `qa_trace_${randomUUID()}`
  await db.collection('pa-inbound-events').doc(id).set({
    id,
    status: 'pending',
    idempotencyKey: `qa-trace:${id}`,
    createdAt: nowIso(),
    attemptCount: 0,
    maxAttempts: 1,
    channel: 'imessage',
    rawPayload: {
      kind: 'imessage',
      participant: PHONE,
      chatId: `iMessage;${PHONE}`,
      messageRowId: Date.now(),
      text: '帮我找份工作',
      harness: { runner: 'single-trace.mjs', suppressOutbound: true },
    },
  })
  console.log(`\nfired inbound ${id} text="帮我找份工作"`)

  // Poll for done
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1500))
    const snap = await db.collection('pa-inbound-events').doc(id).get()
    const d = snap.data()
    if (d?.status && d.status !== 'pending' && d.status !== 'running') {
      console.log(`\nINBOUND status=${d.status} after ${(i+1)*1.5}s`)
      if (d.lastError) console.log('  lastError:', d.lastError)
      break
    }
  }

  // Read user state AFTER processing
  const after = (await db.collection('pa-users').doc(USER).get()).data()
  console.log('\nAFTER inbound:')
  console.log('  onboardingState:', after.onboardingState)
  console.log('  statedPreferences:', JSON.stringify(after.statedPreferences))

  // Find the reply
  const msgSnap = await db.collection('pa-messages')
    .where('rawMeta.eventId', '==', id)
    .where('role', '==', 'assistant')
    .limit(1).get()
  if (!msgSnap.empty) {
    const m = msgSnap.docs[0].data()
    console.log('\nREPLY body:', m.body || m.text)
    console.log('REPLY rawMeta:', JSON.stringify(m.rawMeta || {}, null, 2).slice(0, 1500))
  } else {
    console.log('\nNo assistant reply found via rawMeta.eventId')
  }
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
