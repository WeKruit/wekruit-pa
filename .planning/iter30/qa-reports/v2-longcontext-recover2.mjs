// Recover replies for empty-reply turns by finding the user message
// (matched by body text) and then taking the next assistant message after it.
import admin from 'firebase-admin'
import { readFileSync, writeFileSync } from 'node:fs'

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
admin.initializeApp({ credential: admin.credential.cert(sa) })
const db = admin.firestore()

const r = JSON.parse(readFileSync('/Users/adam/Desktop/WeKruit/wekruit-pa/.planning/iter30/qa-reports/v2-longcontext-50turn.json', 'utf8'))
const ADMIN_USER_ID = r.userId

const empties = r.turns.filter((t) => t.replyLen === 0)
console.log(`Recovering ${empties.length} empty-reply turns via body-text scan`)

// Pull all assistant messages for this user (post-test cutoff)
const cutoff = new Date(r.runAt).getTime() - 60_000
const snap = await db.collection('pa-messages')
  .where('userId', '==', ADMIN_USER_ID)
  .limit(500).get()

// Filter to messages after our test start
const allMsgs = snap.docs
  .map((d) => ({ id: d.id, ...d.data() }))
  .filter((m) => {
    const ts = typeof m.createdAt === 'string' ? new Date(m.createdAt).getTime() : (m.createdAt?.toDate ? m.createdAt.toDate().getTime() : 0)
    return ts >= cutoff
  })
  .sort((a, b) => {
    const ta = typeof a.createdAt === 'string' ? new Date(a.createdAt).getTime() : (a.createdAt?.toDate ? a.createdAt.toDate().getTime() : 0)
    const tb = typeof b.createdAt === 'string' ? new Date(b.createdAt).getTime() : (b.createdAt?.toDate ? b.createdAt.toDate().getTime() : 0)
    return ta - tb
  })

console.log(`  fetched ${allMsgs.length} messages for user since cutoff`)

let recovered = 0
for (const t of empties) {
  // find the user message with matching body
  const userIdx = allMsgs.findIndex((m) => m.role === 'user' && (m.body || '').trim() === t.user)
  if (userIdx < 0) {
    console.log(`  T${t.idx} no user msg with body="${t.user}"`)
    continue
  }
  // find next assistant after it
  let asst = null
  for (let j = userIdx + 1; j < allMsgs.length; j++) {
    if (allMsgs[j].role === 'assistant') { asst = allMsgs[j]; break }
  }
  if (asst) {
    const body = (asst.body || asst.text || '').trim()
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
    }
  } else {
    console.log(`  T${t.idx} no assistant after user`)
  }
}

console.log(`\nRecovered ${recovered}/${empties.length}`)

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
