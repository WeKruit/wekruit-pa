// Recover replies for the 4 turns where findReplyForEvent missed (likely
// timing race) by re-querying pa-messages with the eventIds from the JSON
// report.
import admin from 'firebase-admin'
import { readFileSync, writeFileSync } from 'node:fs'

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
admin.initializeApp({ credential: admin.credential.cert(sa) })
const db = admin.firestore()

const r = JSON.parse(readFileSync('/Users/adam/Desktop/WeKruit/wekruit-pa/.planning/iter30/qa-reports/v2-longcontext-50turn.json', 'utf8'))

const empties = r.turns.filter((t) => t.replyLen === 0)
console.log(`Recovering ${empties.length} empty-reply turns`)
let recovered = 0
for (const t of empties) {
  const snap = await db.collection('pa-messages')
    .where('rawMeta.eventId', '==', t.eventId || '')
    .where('role', '==', 'assistant')
    .limit(1).get()
  if (!snap.empty) {
    const d = snap.docs[0].data()
    const body = (d?.body || d?.text || '').trim()
    if (body.length > 0) {
      console.log(`  T${t.idx} RECOVERED: ${body.slice(0, 200)}`)
      t.reply = body
      t.replyLen = body.length
      t.sentences = body.split(/[.!?。！？\n]+/).filter((s) => s.trim().length > 0).length
      const wo = (body.match(/卧/g) || []).length
      const woCao = (body.match(/卧槽/g) || []).length
      const cao = (body.match(/草(?!莓|地|原|稿)/g) || []).length
      t.repeatWords = { wo, woCao, cao, total: wo + woCao + cao }
      recovered++
    } else {
      console.log(`  T${t.idx} found doc but body empty`)
    }
  } else {
    // try via idempotencyKey out-${eventId}
    const sn2 = await db.collection('pa-messages').doc(`out-${t.eventId}`).get()
    if (sn2.exists) {
      const d = sn2.data()
      const body = (d?.body || d?.text || '').trim()
      if (body.length > 0) {
        console.log(`  T${t.idx} RECOVERED-via-docId: ${body.slice(0, 200)}`)
        t.reply = body
        t.replyLen = body.length
        t.sentences = body.split(/[.!?。！？\n]+/).filter((s) => s.trim().length > 0).length
        recovered++
        continue
      }
    }
    // try latest assistant message with createdAt within 60s
    const sn3 = await db.collection('pa-messages')
      .where('userId', '==', r.userId)
      .where('role', '==', 'assistant')
      .limit(200).get()
    let found = null
    for (const doc of sn3.docs) {
      const dd = doc.data()
      if (dd?.rawMeta?.eventId === t.eventId) { found = dd; break }
    }
    if (found) {
      const body = (found?.body || found?.text || '').trim()
      console.log(`  T${t.idx} RECOVERED-via-recent-scan: ${body.slice(0, 200)}`)
      t.reply = body
      t.replyLen = body.length
      t.sentences = body.split(/[.!?。！？\n]+/).filter((s) => s.trim().length > 0).length
      recovered++
    } else {
      console.log(`  T${t.idx} STILL_EMPTY eventId=${t.eventId}`)
    }
  }
}

console.log(`\nRecovered ${recovered}/${empties.length} replies`)

// Recompute summary
const total = r.turns.length
const validReplies = r.turns.filter((t) => t.replyLen > 0)
const distinctSkills = new Set()
const skillsByTurn = {}
for (const t of r.turns) {
  for (const s of t.skills) distinctSkills.add(s)
  if (t.skills.length > 0) {
    const k = t.skills[0]
    if (!skillsByTurn[k]) skillsByTurn[k] = []
    skillsByTurn[k].push(t.idx)
  }
}
const turnsWithRepeat = r.turns.filter((t) => (t.repeatWords?.total ?? 0) > 0).length
const turnsLeq3Sent = validReplies.filter((t) => t.sentences <= 3).length
const lengthPct = validReplies.length > 0 ? (turnsLeq3Sent / validReplies.length) * 100 : 0
let consecutiveIdentical = 0
let prev = ''
for (const t of r.turns) {
  if (prev !== '' && t.reply === prev) consecutiveIdentical++
  prev = t.reply
}
const slowInbound = r.turns.filter((t) => (t.inboundElapsedMs ?? 0) > 5000).length
const inboundErrors = r.turns.filter((t) => !t.inboundOk).length

r.summary.skillRotation = { pass: distinctSkills.size >= 4, distinct: distinctSkills.size, keys: [...distinctSkills], byTurn: skillsByTurn }
r.summary.repetitionCap = { pass: turnsWithRepeat <= 15, turnsWithRepeat, total, pct: Number(((turnsWithRepeat / total) * 100).toFixed(2)) }
r.summary.lengthCompliance = { pass: lengthPct >= 90, leq3Sent: turnsLeq3Sent, validReplies: validReplies.length, pct: Number(lengthPct.toFixed(2)) }
r.summary.noIdenticalConsecutive = { pass: consecutiveIdentical === 0, consecutiveIdentical }
r.summary.noErrors = { pass: inboundErrors === 0 && slowInbound === 0, inboundErrors, slowInbound }
const allPass = r.summary.skillRotation.pass && r.summary.repetitionCap.pass && r.summary.lengthCompliance.pass && r.summary.noIdenticalConsecutive.pass && r.summary.noStateCorruption.pass && r.summary.noErrors.pass
r.summary.overall = allPass ? 'PASS' : 'FAIL'
r.recoveredEmpty = recovered

writeFileSync('/Users/adam/Desktop/WeKruit/wekruit-pa/.planning/iter30/qa-reports/v2-longcontext-50turn.json', JSON.stringify(r, null, 2))

console.log('\n=== UPDATED SUMMARY ===')
console.log(JSON.stringify(r.summary, null, 2))

process.exit(0)
