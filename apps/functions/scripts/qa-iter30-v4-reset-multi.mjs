// iter30 V4 — RESET multi-iter QA driver.
// Runs 3 consecutive __PA_RESET__ → fresh-onboard cycles against the deployed
// Cloud Functions to verify reset is fully idempotent + 13 PA surfaces clear
// each iter + 7Q onboarding chain replays end-to-end.
//
// Test user: e5d97cd8-1e1d-439d-8672-3008f8aeef2e (admin, +14243201960).
// Pattern follows e2e-reset-cold-start.mjs + qa-iter30-v5-edges.mjs.
import admin from 'firebase-admin'
import { randomUUID } from 'node:crypto'
import { assertProductionPaUserCreationAllowed } from './lib/prod-test-user-guard.mjs'

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
admin.initializeApp({ credential: admin.credential.cert(sa) })
const db = admin.firestore()

// Use isolated test phone +19999998002 (NOT +14243201960 admin which has
// concurrent QA harness traffic from iter30 6h continuous mandate). We
// dynamically find/seed a distinct user. Phone must be admin-allowlisted
// or testMode=true for __PA_RESET__ gating.
const ISOLATED_TEST_PHONE = '+19999998002'
let TEST_USER_ID = null  // resolved at runtime
const TEST_PHONE = ISOLATED_TEST_PHONE
const POLL_INTERVAL_MS = 1500
const POLL_MAX_WAIT_MS = 90000

function nowIso() { return new Date().toISOString() }

function brokerEvent({ participant, chatId, text }) {
  const id = `qa30v4_${randomUUID()}`
  const idempotencyKey = `qa30v4:${id}`
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
          runner: 'apps/functions/scripts/qa-iter30-v4-reset-multi.mjs',
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
      if (d.status === 'succeeded' || d.status === 'completed') return { status: d.status, doc: d }
      if (d.status === 'failed' || d.status === 'dead_letter') return { status: d.status, doc: d }
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
  return { status: 'timeout', doc: null }
}

async function findReplyForEvent(userId, eventId) {
  const snap = await db.collection('pa-messages')
    .where('rawMeta.eventId', '==', eventId)
    .where('role', '==', 'assistant')
    .limit(1).get()
  if (!snap.empty) return snap.docs[0].data()
  const fb = await db.collection('pa-messages')
    .where('userId', '==', userId)
    .where('role', '==', 'assistant')
    .orderBy('createdAt', 'desc').limit(1).get()
  return fb.empty ? null : fb.docs[0].data()
}

async function sendBroker(text) {
  const ev = brokerEvent({
    participant: TEST_PHONE,
    chatId: `iMessage;${TEST_PHONE}`,
    text,
  })
  await db.collection('pa-inbound-events').doc(ev.id).set(ev.docData)
  return ev.id
}

// 13 PA-namespaced surfaces (per CLAUDE.md V4 mission).
const SURFACES = [
  'pa-memory-facts',
  'pa-memory-actions',
  'pa-memory-events',
  'pa-memory-profiles',
  'pa-memory-evolution-events',
  'pa-conversation-summaries',
  'pa-message-archives',
  'pa-surprise-events',
  'pa-tag-events',
  'pa-abuse-events',
  'pa-rate-limits',
  'pa-job-profiles',
  'pa-job-rec-explanations',
  'pa-tapback-events',
  'pa-scheduled-jobs',
  'pa-cv-pending',
]

async function seedAllSurfaces(userId, iterTag) {
  // Seed 1 doc per surface so reset has something to clear each iter.
  const w = []
  w.push(db.collection('pa-memory-facts').doc(`v4-${iterTag}-fact-${userId}`).set({
    id: `v4-${iterTag}-fact-${userId}`, userId, body: `iter${iterTag} pre-reset fact`, kind: 'preference', createdAt: nowIso(),
  }))
  w.push(db.collection('pa-memory-actions').doc(`v4-${iterTag}-action-${userId}`).set({
    id: `v4-${iterTag}-action-${userId}`, userId, kind: 'send_resource', createdAt: nowIso(),
  }))
  w.push(db.collection('pa-memory-events').doc(`v4-${iterTag}-evt-${userId}`).set({
    id: `v4-${iterTag}-evt-${userId}`, userId, kind: 'job_offer', createdAt: nowIso(),
  }))
  w.push(db.collection('pa-memory-profiles').doc(`v4-${iterTag}-prof-${userId}`).set({
    id: `v4-${iterTag}-prof-${userId}`, userId, traits: { test: true }, createdAt: nowIso(),
  }))
  w.push(db.collection('pa-memory-evolution-events').doc(`v4-${iterTag}-evo-${userId}`).set({
    id: `v4-${iterTag}-evo-${userId}`, userId, kind: 'value_shift', createdAt: nowIso(),
  }))
  w.push(db.collection('pa-conversation-summaries').doc(`v4-${iterTag}-sum-${userId}`).set({
    id: `v4-${iterTag}-sum-${userId}`, userId, body: 'test summary', createdAt: nowIso(),
  }))
  w.push(db.collection('pa-message-archives').doc(`v4-${iterTag}-arch-${userId}`).set({
    id: `v4-${iterTag}-arch-${userId}`, userId, archivedCount: 5, createdAt: nowIso(),
  }))
  w.push(db.collection('pa-surprise-events').doc(`v4-${iterTag}-surp-${userId}`).set({
    id: `v4-${iterTag}-surp-${userId}`, userId, kind: 'unexpected_topic', createdAt: nowIso(),
  }))
  w.push(db.collection('pa-tag-events').doc(`v4-${iterTag}-tag-${userId}`).set({
    id: `v4-${iterTag}-tag-${userId}`, userId, source: 'manual-backfill', sourceDocId: userId,
    rawText: 'python', type: 'skill', entityRef: { kind: 'pa-user', id: userId },
    sourceField: 'rawTag', context: null, status: 'pending', schemaVersion: 'v1', createdAt: nowIso(),
    normalizedTo: null, decision: null, workerConfidence: null, processedAt: null, processingDurationMs: null,
  }))
  w.push(db.collection('pa-abuse-events').doc(`v4-${iterTag}-abuse-${userId}`).set({
    userId, kind: 'rate_limit', createdAt: nowIso(),
  }))
  w.push(db.collection('pa-rate-limits').doc(`v4-${iterTag}-rl-${userId}`).set({
    userId, count: 5, windowStart: nowIso(),
  }))
  w.push(db.collection('pa-job-profiles').doc(`v4-${iterTag}-jp-${userId}`).set({
    userId, profileVersion: 'v1', createdAt: nowIso(),
  }))
  w.push(db.collection('pa-job-rec-explanations').doc(`v4-${iterTag}-jre-${userId}`).set({
    userId, jobId: 'fake-job-1', createdAt: nowIso(),
  }))
  w.push(db.collection('pa-tapback-events').doc(`v4-${iterTag}-tap-${userId}`).set({
    userId, messageId: 'fake-msg-1', emoji: '👍', createdAt: nowIso(),
  }))
  w.push(db.collection('pa-scheduled-jobs').doc(`v4-${iterTag}-sched-${userId}`).set({
    userId, kind: 'silence-anchor', scheduledFor: nowIso(),
  }))
  w.push(db.collection('pa-cv-pending').doc(`v4-${iterTag}-cvp-${userId}`).set({
    userId, status: 'awaiting_user', createdAt: nowIso(),
  }))
  // entity-tags subcoll item
  w.push(db.collection(`pa-entity-tags/pa-user:${userId}/items`).doc(`v4-${iterTag}-skill`).set({
    canonicalKey: `v4-${iterTag}-skill`, userId, lastSeen: nowIso(), confidence: 0.9, status: 'accepted',
  }))
  await Promise.all(w)
}

async function countAllSurfaces(userId) {
  const counts = {}
  for (const c of SURFACES) {
    const snap = await db.collection(c).where('userId', '==', userId).limit(50).get()
    counts[c] = snap.size
  }
  const items = await db.collection(`pa-entity-tags/pa-user:${userId}/items`).limit(50).get()
  counts['pa-entity-tags-items'] = items.size
  const u = (await db.collection('pa-users').doc(userId).get()).data() ?? {}
  counts.__user_onboardingState = u.onboardingState ?? 'NULL'
  counts.__user_resumeAccepted = u.resumeAccepted ? 'SET' : 'CLEARED'
  counts.__user_statedPreferences = u.statedPreferences ? 'SET' : 'CLEARED'
  counts.__user_resumeId = u.resumeId ? 'SET' : 'CLEARED'
  return counts
}

// 7Q onboarding chain spec — text → expected state-after + reply substring.
const CHAIN_STEPS = [
  { send: '你好',                  expectState: 'q_role_asked',         expectSub: '想找啥方向的活',  label: 'hello → role' },
  { send: '工程',                  expectState: 'q_yoe_asked',          expectSub: '工作几年',         label: 'role → yoe' },
  { send: '5年',                   expectState: 'q_visa_asked',         expectSub: '身份',             label: 'yoe → visa' },
  { send: 'OPT',                   expectState: 'q_startup_pref_asked', expectSub: 'startup',          label: 'visa → startup' },
  { send: '大厂',                  expectState: 'q_location_asked',     expectSub: '哪边',             label: 'startup → location' },
  { send: '湾区',                  expectState: 'q_resume_asked',       expectSub: '简历方便发我',     label: 'location → resume' },
  { send: '好',                    expectState: 'q_email_asked',        expectSub: '邮箱',             label: 'resume → email' },
  { send: 'test@example.com',     expectState: 'complete',             expectSub: null,                label: 'email → complete' },
]

async function getUserState(userId) {
  const u = (await db.collection('pa-users').doc(userId).get()).data() ?? {}
  return {
    onboardingState: u.onboardingState ?? 'NULL',
    resumeAccepted: u.resumeAccepted ?? null,
    statedPreferences: u.statedPreferences ?? null,
    resumeId: u.resumeId ?? null,
  }
}

async function runIter(iterTag) {
  console.log(`\n══════════ ITER ${iterTag} ══════════`)
  const out = { iterTag, surfacesCleared: 0, surfacesTotal: 0, chainPassed: 0, chainTotal: CHAIN_STEPS.length, details: [] }

  // 1. Seed all 13+ surfaces
  console.log(`[iter${iterTag}/seed] writing 17 docs across 13 surfaces + entity-tags items`)
  await seedAllSurfaces(TEST_USER_ID, iterTag)

  // 2. Pre-reset state (sanity: surfaces should be ≥ 1 each)
  const before = await countAllSurfaces(TEST_USER_ID)
  console.log(`[iter${iterTag}/before] sample counts: facts=${before['pa-memory-facts']} tag-events=${before['pa-tag-events']} entity-tags-items=${before['pa-entity-tags-items']} job-profiles=${before['pa-job-profiles']}`)

  // 3. Send __PA_RESET__
  console.log(`[iter${iterTag}/reset] sending __PA_RESET__ via broker`)
  const resetEid = await sendBroker('__PA_RESET__')
  const { status: resetStatus, doc: resetDoc } = await pollUntilStatus(resetEid, `iter${iterTag} reset`)
  console.log(`[iter${iterTag}/reset] inbound status: ${resetStatus}`)
  if (resetStatus !== 'succeeded' && resetStatus !== 'completed') {
    console.log(`[iter${iterTag}/reset] FAIL — last error: ${resetDoc?.lastError ?? resetDoc?.error ?? 'unknown'}`)
    out.details.push({ step: 'reset-inbound', ok: false })
    return out
  }
  // give async clears time to settle
  await new Promise((r) => setTimeout(r, 5000))

  // 4. Verify all 13 surfaces cleared
  const after = await countAllSurfaces(TEST_USER_ID)
  console.log(`[iter${iterTag}/after] surface counts:`)
  const checks = []
  for (const surface of SURFACES) {
    const cleared = after[surface] === 0
    checks.push({ label: surface, ok: cleared, val: after[surface] })
    console.log(`  ${cleared ? '✓' : '✗'} ${surface}: ${after[surface]}`)
  }
  const itemsCleared = after['pa-entity-tags-items'] === 0
  checks.push({ label: 'pa-entity-tags-items', ok: itemsCleared, val: after['pa-entity-tags-items'] })
  console.log(`  ${itemsCleared ? '✓' : '✗'} pa-entity-tags-items: ${after['pa-entity-tags-items']}`)
  const userOk = after.__user_onboardingState === 'pending'
    && after.__user_resumeAccepted === 'CLEARED'
    && after.__user_statedPreferences === 'CLEARED'
  checks.push({ label: 'user record (pending+resumeAccepted/statedPreferences cleared)', ok: userOk })
  console.log(`  ${userOk ? '✓' : '✗'} user: onboardingState=${after.__user_onboardingState} resumeAccepted=${after.__user_resumeAccepted} statedPreferences=${after.__user_statedPreferences} resumeId=${after.__user_resumeId}`)

  out.surfacesCleared = checks.filter(c => c.ok).length
  out.surfacesTotal = checks.length

  // 5. Walk 7Q chain
  console.log(`[iter${iterTag}/chain] walking 8 turns: hello → role → yoe → visa → startup → location → resume → email`)
  for (let i = 0; i < CHAIN_STEPS.length; i++) {
    const step = CHAIN_STEPS[i]
    console.log(`\n  T${i} ${step.label} — send: ${step.send.slice(0, 40)}`)
    const eid = await sendBroker(step.send)
    const { status: s, doc: d } = await pollUntilStatus(eid, `iter${iterTag} T${i}`)
    if (s !== 'succeeded' && s !== 'completed') {
      console.log(`     ✗ inbound failed: ${s} / ${d?.lastError ?? 'unknown'}`)
      out.details.push({ step: `chain-T${i}`, ok: false, reason: 'inbound-failed' })
      continue
    }
    await new Promise((r) => setTimeout(r, 2000))
    const reply = await findReplyForEvent(TEST_USER_ID, eid)
    const replyText = (reply?.body || reply?.text || '').slice(0, 300)
    const userState = await getUserState(TEST_USER_ID)

    const stateOk = userState.onboardingState === step.expectState
    const subOk = step.expectSub == null
      ? true
      : replyText.toLowerCase().includes(step.expectSub.toLowerCase())
    const ok = stateOk && subOk

    console.log(`     reply: ${replyText.slice(0, 200)}`)
    console.log(`     state: ${userState.onboardingState}  expect: ${step.expectState}  ${stateOk ? '✓' : '✗'}`)
    if (step.expectSub) console.log(`     sub: "${step.expectSub}"  ${subOk ? '✓' : '✗'}`)
    if (i === 6 /* after location → resume */) {
      const ra = userState.resumeAccepted
      const gateOk = ra && ra.triggerHash === 'onboarding_ask_q_resume'
      console.log(`     resumeAccepted gate: ${gateOk ? '✓' : '✗'} (triggerHash=${ra?.triggerHash ?? 'NULL'})`)
    }
    if (i === 7 /* email final */) {
      const sp = userState.statedPreferences
      const emailOk = sp && sp.contactEmail === 'test@example.com'
      console.log(`     contactEmail saved: ${emailOk ? '✓' : '✗'} (got=${sp?.contactEmail ?? 'NULL'})`)
    }

    if (ok) out.chainPassed++
    out.details.push({ step: `T${i}-${step.label}`, ok, state: userState.onboardingState, expectState: step.expectState })
  }

  console.log(`\n[iter${iterTag}/summary] surfaces ${out.surfacesCleared}/${out.surfacesTotal} cleared, chain ${out.chainPassed}/${out.chainTotal} pass`)
  return out
}

async function findOrCreateIsolatedUser() {
  const snap = await db.collection('pa-users').where('phoneE164', '==', ISOLATED_TEST_PHONE).limit(1).get()
  if (!snap.empty) return snap.docs[0].id
  const id = `qa30v4-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  assertProductionPaUserCreationAllowed({
    projectId: 'wekruit-5f89b',
    scriptName: 'apps/functions/scripts/qa-iter30-v4-reset-multi.mjs',
    userId: id,
    phoneE164: ISOLATED_TEST_PHONE,
    reason: 'reset QA driver creates a fallback synthetic pa-users row when the fixed test phone is missing',
  })
  await db.collection('pa-users').doc(id).set({
    id,
    phoneE164: ISOLATED_TEST_PHONE,
    channels: { imessageHandle: ISOLATED_TEST_PHONE },
    onboardingStatus: 'active',
    onboardingState: 'pending',
    testMode: true,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  })
  return id
}

async function main() {
  console.log('═══ iter30 V4 — RESET MULTI-ITER (3 cycles) ═══')
  TEST_USER_ID = await findOrCreateIsolatedUser()
  console.log(`user: ${TEST_USER_ID} (${TEST_PHONE})`)

  const results = []
  for (const tag of ['1', '2', '3']) {
    const r = await runIter(tag)
    results.push(r)
  }

  console.log('\n══════════ FINAL ══════════')
  for (const r of results) {
    const surfacesOk = r.surfacesCleared === r.surfacesTotal
    const chainOk = r.chainPassed === r.chainTotal
    console.log(`  iter-${r.iterTag}: surfaces ${r.surfacesCleared}/${r.surfacesTotal} ${surfacesOk ? 'OK' : 'BUG'}, chain ${r.chainPassed}/${r.chainTotal} ${chainOk ? 'OK' : 'BUG'}`)
  }
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
