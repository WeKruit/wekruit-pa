// iter30 final closure E2E — verify __PA_RESET__ + cold-start 6Q chain.
//
// Uses the SAME broker-event inbound shape as tests/scenarios/runner.mjs so
// the deployed onPaInbound function receives a valid pa-inbound-events doc
// (rawPayload.kind=imessage + harness:{suppressOutbound}).
import admin from 'firebase-admin'
import { randomUUID } from 'node:crypto'
import { assertProductionPaUserCreationAllowed } from './lib/prod-test-user-guard.mjs'

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
admin.initializeApp({ credential: admin.credential.cert(sa) })
const db = admin.firestore()

const TEST_PHONE = '+19999998001'
const POLL_INTERVAL_MS = 1500
const POLL_MAX_WAIT_MS = 90000

function nowIso() { return new Date().toISOString() }

function brokerEvent({ participant, chatId, text }) {
  const id = `harness_${randomUUID()}`
  const idempotencyKey = `harness:${id}`
  return {
    id,
    docData: {
      id,
      status: 'pending',
      idempotencyKey,
      createdAt: nowIso(),
      attemptCount: 0,
      maxAttempts: 1,
      channel: 'imessage',
      rawPayload: {
        kind: 'imessage',
        participant,
        chatId,
        messageRowId: Date.now(),
        text,
        harness: {
          runner: 'apps/functions/scripts/e2e-reset-cold-start.mjs',
          suppressOutbound: true,
        },
      },
    },
  }
}

async function pollUntilStatus(eventId, label, timeoutMs = POLL_MAX_WAIT_MS) {
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
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
  throw new Error(`timeout after ${timeoutMs}ms: ${label}`)
}

async function findReplyForEvent(userId, eventId) {
  // pa-messages is canonical transcript; rawMeta.eventId links back to inbound
  const snap = await db.collection('pa-messages')
    .where('rawMeta.eventId', '==', eventId)
    .where('role', '==', 'assistant')
    .limit(1).get()
  if (!snap.empty) return snap.docs[0].data()
  // fallback: latest assistant message for user
  const fb = await db.collection('pa-messages')
    .where('userId', '==', userId)
    .where('role', '==', 'assistant')
    .orderBy('createdAt', 'desc').limit(1).get()
  return fb.empty ? null : fb.docs[0].data()
}

async function findOrCreateTestUser(phone) {
  const snap = await db.collection('pa-users').where('phoneE164', '==', phone).limit(1).get()
  if (!snap.empty) {
    const id = snap.docs[0].id
    // Reset to a known seeded state for repeatable test
    await db.collection('pa-users').doc(id).set({
      onboardingState: 'complete',
      statedPreferences: { role: 'engineer', yoe: '5+', location: 'sf' },
      resumeAccepted: { at: nowIso(), expiresAt: new Date(Date.now() + 86400000).toISOString(), triggerHash: 'preexisting' },
      testMode: true,
      updatedAt: nowIso(),
    }, { merge: true })
    return id
  }
  const id = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  assertProductionPaUserCreationAllowed({
    projectId: 'wekruit-5f89b',
    scriptName: 'apps/functions/scripts/e2e-reset-cold-start.mjs',
    userId: id,
    phoneE164: phone,
    reason: 'reset cold-start probe creates a fallback synthetic pa-users row when the fixed test phone is missing',
  })
  await db.collection('pa-users').doc(id).set({
    id,
    phoneE164: phone,
    channels: { imessageHandle: phone },
    onboardingStatus: 'active',
    onboardingState: 'complete',
    statedPreferences: { role: 'engineer', yoe: '5+', location: 'sf' },
    resumeAccepted: { at: nowIso(), expiresAt: new Date(Date.now() + 86400000).toISOString(), triggerHash: 'preexisting' },
    testMode: true,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  })
  return id
}

async function seedDataForReset(userId) {
  // Seed across every PA-namespaced surface that clearUserMemory should clear
  // so each iteration's reset closure is verifiable end-to-end.
  await db.collection('pa-memory-facts').doc(`e2e-fact-${userId}`).set({
    id: `e2e-fact-${userId}`, userId, body: 'pre-reset test fact', kind: 'preference',
    createdAt: nowIso(),
  })
  await db.collection('pa-tag-events').doc(`e2e-evt-${userId}`).set({
    id: `e2e-evt-${userId}`, userId, source: 'manual-backfill', sourceDocId: userId,
    rawText: 'python', type: 'skill', entityRef: { kind: 'pa-user', id: userId },
    sourceField: 'rawTag', context: null, status: 'pending', schemaVersion: 'v1',
    createdAt: nowIso(), normalizedTo: null, decision: null, workerConfidence: null,
    processedAt: null, processingDurationMs: null,
  })
  await db.collection(`pa-entity-tags/pa-user:${userId}/items`).doc('python').set({
    canonicalKey: 'python', userId, lastSeen: nowIso(), confidence: 0.9, status: 'accepted',
  })
  // iter30 closure — biz-test isolation surfaces.
  await db.collection('pa-abuse-events').doc(`e2e-abuse-${userId}`).set({
    userId, kind: 'rate_limit', createdAt: nowIso(),
  })
  await db.collection('pa-rate-limits').doc(`e2e-rl-${userId}`).set({
    userId, count: 5, windowStart: nowIso(),
  })
  await db.collection('pa-job-profiles').doc(`e2e-jp-${userId}`).set({
    userId, profileVersion: 'v1', createdAt: nowIso(),
  })
  await db.collection('pa-job-rec-explanations').doc(`e2e-jre-${userId}`).set({
    userId, jobId: 'fake-job-1', createdAt: nowIso(),
  })
  await db.collection('pa-tapback-events').doc(`e2e-tap-${userId}`).set({
    userId, messageId: 'fake-msg-1', emoji: '👍', createdAt: nowIso(),
  })
  await db.collection('pa-scheduled-jobs').doc(`e2e-sched-${userId}`).set({
    userId, kind: 'silence-anchor', scheduledFor: nowIso(),
  })
  await db.collection('pa-cv-pending').doc(`e2e-cvp-${userId}`).set({
    userId, status: 'awaiting_user', createdAt: nowIso(),
  })
}

async function countUserData(userId) {
  const counts = {}
  for (const c of [
    'pa-memory-facts', 'pa-memory-actions', 'pa-memory-events',
    'pa-memory-profiles', 'pa-memory-evolution-events',
    'pa-conversation-summaries', 'pa-message-archives', 'pa-surprise-events',
    'pa-tag-events',
    // iter30 closure — biz-test isolation surfaces
    'pa-abuse-events', 'pa-rate-limits', 'pa-job-profiles',
    'pa-job-rec-explanations', 'pa-tapback-events', 'pa-scheduled-jobs',
    'pa-cv-pending',
  ]) {
    const snap = await db.collection(c).where('userId', '==', userId).limit(50).get()
    counts[c] = snap.size
  }
  const items = await db.collection(`pa-entity-tags/pa-user:${userId}/items`).limit(50).get()
  counts['pa-entity-tags-items'] = items.size
  const u = (await db.collection('pa-users').doc(userId).get()).data() ?? {}
  counts.__user_onboardingState = u.onboardingState ?? 'NULL'
  counts.__user_resumeAccepted = u.resumeAccepted ? 'SET' : 'CLEARED'
  counts.__user_statedPreferences = u.statedPreferences ? 'SET' : 'CLEARED'
  return counts
}

async function sendBrokerInbound(text) {
  const ev = brokerEvent({
    participant: TEST_PHONE,
    chatId: `iMessage;${TEST_PHONE}`,
    text,
  })
  await db.collection('pa-inbound-events').doc(ev.id).set(ev.docData)
  return ev.id
}

async function main() {
  console.log('═══ iter30 E2E — RESET闭环 + 6Q COLD-START (broker shape) ═══')

  console.log('\n[step 1] find/seed test user')
  const userId = await findOrCreateTestUser(TEST_PHONE)
  console.log(`  userId: ${userId}`)

  console.log('\n[step 2] seed memory-fact + tag-event + entity-tags item for reset to clear')
  await seedDataForReset(userId)

  console.log('\n[step 3] BEFORE-reset state:')
  const before = await countUserData(userId)
  for (const [k, v] of Object.entries(before)) console.log(`  ${k}: ${v}`)

  console.log('\n[step 4] send __PA_RESET__ via broker shape, wait for inbound succeeded')
  const resetEventId = await sendBrokerInbound('__PA_RESET__')
  console.log(`  inbound event: ${resetEventId}`)
  await pollUntilStatus(resetEventId, 'reset inbound')
  console.log(`  inbound succeeded`)

  // give async clear writes a moment
  await new Promise((r) => setTimeout(r, 4000))

  console.log('\n[step 5] AFTER-reset state:')
  const after = await countUserData(userId)
  for (const [k, v] of Object.entries(after)) console.log(`  ${k}: ${v}`)

  console.log('\n[step 6] reset verdicts:')
  const checks = [
    ['pa-memory-facts cleared', after['pa-memory-facts'] === 0],
    ['pa-tag-events cleared', after['pa-tag-events'] === 0],
    ['pa-entity-tags-items cleared', after['pa-entity-tags-items'] === 0],
    ['pa-abuse-events cleared', after['pa-abuse-events'] === 0],
    ['pa-rate-limits cleared', after['pa-rate-limits'] === 0],
    ['pa-job-profiles cleared', after['pa-job-profiles'] === 0],
    ['pa-job-rec-explanations cleared', after['pa-job-rec-explanations'] === 0],
    ['pa-tapback-events cleared', after['pa-tapback-events'] === 0],
    ['pa-scheduled-jobs cleared', after['pa-scheduled-jobs'] === 0],
    ['pa-cv-pending cleared', after['pa-cv-pending'] === 0],
    ['onboardingState = pending', after.__user_onboardingState === 'pending'],
    ['resumeAccepted CLEARED', after.__user_resumeAccepted === 'CLEARED'],
    ['statedPreferences CLEARED', after.__user_statedPreferences === 'CLEARED'],
  ]
  let pass = 0
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? '✓' : '❌'} ${label}`)
    if (ok) pass++
  }
  console.log(`\n  RESET闭环: ${pass}/${checks.length} pass`)

  console.log('\n[step 7] cold-start: send 6 turns to walk 6Q chain')
  const userMessages = [
    '我想找份工作', // expect role question (or first_mes + role chained)
    '我想做工程', // role answer → expect yoe
    '工作 5 年了', // yoe answer → expect visa
    '我有 OPT', // visa answer → expect startup_pref
    '想去大厂', // startup_pref answer → expect location
    '湾区', // location answer → expect ask_q_resume (NEW)
  ]
  for (let i = 0; i < userMessages.length; i++) {
    const text = userMessages[i]
    console.log(`\n  T${i} user: ${text}`)
    const eid = await sendBrokerInbound(text)
    await pollUntilStatus(eid, `T${i} inbound`)
    await new Promise((r) => setTimeout(r, 1500))
    const reply = await findReplyForEvent(userId, eid)
    const replyBody = (reply?.body || reply?.text || '').slice(0, 200)
    console.log(`     C: ${replyBody || '<NO REPLY FOUND>'}`)
    const u = (await db.collection('pa-users').doc(userId).get()).data() ?? {}
    console.log(`     onboardingState now: ${u.onboardingState}`)
  }

  console.log('\n[step 8] final user state:')
  const final = await countUserData(userId)
  console.log(`  onboardingState: ${final.__user_onboardingState}`)
  console.log(`  statedPreferences: ${final.__user_statedPreferences}`)

  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
