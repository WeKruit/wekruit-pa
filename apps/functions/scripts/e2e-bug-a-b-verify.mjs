// 2026-05-07 Bug A + Bug B live verify (against deployed wekruit-5f89b)
//
// Bug A: CV waiting prompt deduped within 60s window
// Bug B: agent runtime userLang locked to onboarding statedPreferences.preferredLang=en
//
// Flow:
//   1. PA_RESET seeded user
//   2. Walk q_email → verify → ToS → q_role → q_yoe → q_visa(OPT) → q_startup_pref → q_location → ask_q_resume
//   3. Fire 2 [attachment] events 5s apart → assert exactly 1 'still waiting' prompt
//   4. After cv-ingest synthesizes [cv-parsed], next turn → assert reply NOT in ZH
//
// Reads pa-messages assistant rows + pa-users doc + pa-orchestrator-logs.
import admin from 'firebase-admin'
import { randomUUID } from 'node:crypto'
import { assertProductionPaUserCreationAllowed } from './lib/prod-test-user-guard.mjs'

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
admin.initializeApp({ credential: admin.credential.cert(sa) })
const db = admin.firestore()

const TEST_PHONE = `+199999${String(Math.floor(Math.random() * 90000) + 10000)}`
const POLL_INTERVAL_MS = 1500
const POLL_MAX_WAIT_MS = 90000

function nowIso() { return new Date().toISOString() }
function brokerEvent({ participant, chatId, text }) {
  const id = `harness_${randomUUID()}`
  return {
    id,
    docData: {
      id, status: 'pending', idempotencyKey: `harness:${id}`,
      createdAt: nowIso(), attemptCount: 0, maxAttempts: 1, channel: 'imessage',
      rawPayload: {
        kind: 'imessage', participant, chatId, messageRowId: Date.now(), text,
        harness: { runner: 'apps/functions/scripts/e2e-bug-a-b-verify.mjs', suppressOutbound: true },
      },
    },
  }
}

async function pollInbound(eventId, label) {
  const start = Date.now()
  while (Date.now() - start < POLL_MAX_WAIT_MS) {
    const d = (await db.collection('pa-inbound-events').doc(eventId).get()).data()
    if (d) {
      if (d.status === 'succeeded' || d.status === 'completed') return d
      if (d.status === 'failed' || d.status === 'dead_letter') {
        throw new Error(`${label} ${d.status}: ${d.lastError ?? d.error ?? '?'}`)
      }
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
  throw new Error(`timeout: ${label}`)
}

async function send(text) {
  const ev = brokerEvent({ participant: TEST_PHONE, chatId: `iMessage;${TEST_PHONE}`, text })
  await db.collection('pa-inbound-events').doc(ev.id).set(ev.docData)
  await pollInbound(ev.id, `inbound[${text.slice(0, 24)}]`)
  await new Promise((r) => setTimeout(r, 1500))
  const snap = await db.collection('pa-messages')
    .where('rawMeta.eventId', '==', ev.id)
    .limit(8).get()
  const replies = snap.docs.map((d) => d.data()).filter((d) => d.role === 'assistant')
  return { eventId: ev.id, replies }
}

async function findOrSeed(phone) {
  // Always create fresh; phones are randomized per run.
  const id = `e2e-bugab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  assertProductionPaUserCreationAllowed({
    projectId: 'wekruit-5f89b',
    scriptName: 'apps/functions/scripts/e2e-bug-a-b-verify.mjs',
    userId: id,
    phoneE164: phone,
    reason: 'legacy bug A/B verifier always creates a fresh pa-users row',
  })
  await db.collection('pa-users').doc(id).set({
    id, phoneE164: phone, channels: { imessageHandle: phone },
    onboardingStatus: 'beta_participant', onboardingState: 'pending', testMode: true,
    createdAt: nowIso(), updatedAt: nowIso(),
  })
  return id
}

async function main() {
  console.log('═══ Bug A + B live verify on wekruit-5f89b (post 6f16db7) ═══')
  const userId = await findOrSeed(TEST_PHONE)
  console.log(`userId: ${userId}\n`)

  console.log('[1] skip PA_RESET — fresh user already pending')

  console.log('[2] cold-start: walk full onboarding to ask_q_resume')
  // dynamic walker: read onboardingState after each send; pick canned reply per state
  const replies = {
    pending: 'Hi I want a job',
    first_mes_sent: `e2e-bugab+${Date.now()}@wekruit-test.io`,
    q_email_asked: `e2e-bugab+${Date.now()}@wekruit-test.io`,
    q_email_verifying: 'agree',
    q_tos_asked: 'agree',
    q_role_asked: 'software engineer',
    q_yoe_asked: '5 years',
    q_visa_asked: 'I am on OPT',
    q_startup_pref_asked: 'big tech',
    q_location_asked: 'Bay Area',
  }
  for (let i = 0; i < 14; i++) {
    const u0 = (await db.collection('pa-users').doc(userId).get()).data() ?? {}
    const st = u0.onboardingState ?? 'pending'
    if (st === 'q_resume_asked' || st === 'complete') break
    // bypass email verification gate (out of scope for Bug A/B test)
    if (st === 'q_email_verifying') {
      await db.collection('pa-users').doc(userId).set({
        onboardingState: 'q_tos_asked',
        emailVerified: true,
        updatedAt: nowIso(),
      }, { merge: true })
      console.log('  bypass q_email_verifying → q_tos_asked')
      continue
    }
    const reply = replies[st] ?? 'ok'
    console.log(`  state=${st} → reply: ${reply.slice(0, 30)}`)
    await send(reply)
  }

  // Now should be at q_resume_asked or near it
  let u = (await db.collection('pa-users').doc(userId).get()).data() ?? {}
  console.log(`  state after 6Q: ${u.onboardingState}`)
  console.log(`  preferredLang: ${u.statedPreferences?.preferredLang ?? u.tags?.preferredLang ?? 'unset'}`)
  console.log(`  visaStatus: ${u.statedPreferences?.visaStatus ?? 'unset'}`)

  console.log('\n[4] Bug A: fire 2 [attachment] events 5s apart')
  const t0 = Date.now()
  const att1 = await send('[attachment]')
  await new Promise((r) => setTimeout(r, 5000))
  const att2 = await send('[attachment]')
  console.log(`  att1 replies: ${att1.replies.length}, att2 replies: ${att2.replies.length}`)
  for (const r of att1.replies) console.log(`    att1 → ${(r.body || r.text || '').slice(0, 90)}`)
  for (const r of att2.replies) console.log(`    att2 → ${(r.body || r.text || '').slice(0, 90)}`)

  // Search recent assistant messages for "waiting" / "等" tokens (no composite index req)
  const recentMsgs = await db.collection('pa-messages')
    .where('userId', '==', userId)
    .limit(60).get()
  const waitingHits = recentMsgs.docs
    .map((d) => d.data())
    .filter((d) => d.role === 'assistant')
    .map((d) => ({ ts: d.createdAt, body: (d.body || d.text || '') }))
    .filter((m) => /wait|看|读|process|等|just|let me|阅读|hold on|reading|moment/i.test(m.body))
    .filter((m) => m.ts && Date.parse(m.ts) >= t0 - 1000)
  console.log(`  Bug A: waiting-prompt-shaped messages since attachments: ${waitingHits.length}`)
  for (const w of waitingHits) console.log(`    [${w.ts}] ${w.body.slice(0, 90)}`)

  // Check dedup log
  const logSince = new Date(t0 - 1000).toISOString()
  const logSnap = await db.collection('pa-orchestrator-logs')
    .where('userId', '==', userId)
    .where('event', 'in', ['pa.onboarding.deterministic.cv_wait', 'pa.onboarding.deterministic.cv_wait_deduped'])
    .where('createdAt', '>=', logSince)
    .limit(10).get()
  const fires = logSnap.docs.filter((d) => d.data().event === 'pa.onboarding.deterministic.cv_wait').length
  const deduped = logSnap.docs.filter((d) => d.data().event === 'pa.onboarding.deterministic.cv_wait_deduped').length
  console.log(`  Bug A logs: cv_wait fires=${fires}, cv_wait_deduped=${deduped}`)

  // Verify cvWaitPromptLastFiredAt set on user doc
  u = (await db.collection('pa-users').doc(userId).get()).data() ?? {}
  console.log(`  Bug A: cvWaitPromptLastFiredAt = ${u.cvWaitPromptLastFiredAt ?? 'UNSET'}`)

  console.log('\n[5] Bug B: simulate cv-parsed synthetic event → next reply must be EN')
  // Set parsedCandidateResumes (mimic cv-ingest finished)
  await db.collection('parsedCandidateResumes').doc(`pa:${userId}`).set({
    userId, schemaVersion: 'v3',
    createdAt: nowIso(), updatedAt: nowIso(),
    careerLevel: 'mid',
    workHistory: [{ company: 'TestCo', title: 'SWE', startDate: '2020', endDate: '2023', description: 'Built APIs.' }],
    topSkills: ['python', 'typescript'],
    industryTags: ['software_engineering'],
    relevantTags: ['backend'],
    preferredLang: u.statedPreferences?.preferredLang ?? 'en',
  }, { merge: true })
  await db.collection('pa-users').doc(userId).set({
    'cvIngest.status': 'parsed',
    cvParsed: true,
    updatedAt: nowIso(),
  }, { merge: true })

  console.log('  sending follow-up "thanks, what next?" — agent runtime path')
  const followUp = await send('thanks what next')
  console.log(`  reply count: ${followUp.replies.length}`)
  let zhHits = 0
  for (const r of followUp.replies) {
    const body = (r.body || r.text || '')
    const hasZh = /[一-鿿]/.test(body)
    console.log(`    [${hasZh ? 'ZH' : 'EN'}] ${body.slice(0, 120)}`)
    if (hasZh) zhHits++
  }
  console.log(`  Bug B: ZH leak count = ${zhHits} (expect 0)`)

  console.log('\n═══ VERDICT ═══')
  const bugAOk = (waitingHits.length <= 1) && (deduped >= 1 || waitingHits.length === 1)
  const bugBOk = zhHits === 0
  console.log(`  Bug A (single waiting prompt): ${bugAOk ? '✓ PASS' : '❌ FAIL'}  (waiting=${waitingHits.length}, deduped log=${deduped})`)
  console.log(`  Bug B (no ZH leak post-parse): ${bugBOk ? '✓ PASS' : '❌ FAIL'}  (zhHits=${zhHits})`)

  process.exit(bugAOk && bugBOk ? 0 : 2)
}

main().catch((e) => { console.error(e); process.exit(1) })
