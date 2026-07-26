/**
 * YC Startup School — funnel stats for TODAY's users (Adam 2026-07-25).
 *
 * Field names are the ones the docs ACTUALLY carry (probed, not guessed): `linkedinOauthLinked`,
 * `coresignalEmployeeId`, `experienceHighlights`, `ycIntake`, `ycPeopleMatchSent`.
 *
 * "Answered?" is measured by CAUSAL linkage, not timestamps: a pa-turns row whose `inboundText`
 * is the user's last message and which produced either `finalText` or `deliveredViaTool`.
 * Timestamp comparison is unusable here — measured pa-outbound-vs-pa-messages write skew is
 * about -0.2s (outbound row written BEFORE the inbound it answers), so both a strict ">" and a
 * tolerance window give wrong answers in opposite directions.
 */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env", "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()

const since = process.env.SINCE ?? new Date(Date.now() - 20 * 3600 * 1000).toISOString()

const users = await db.collection("pa-users").where("createdAt", ">=", since).get()
const rows = users.docs.map((d) => ({ id: d.id, ...d.data() }))
const yc = rows.filter((u) => Boolean(u.ycIntake) || String(u.source ?? "").includes("yc") || String(u.firstTouchCampaign ?? "").includes("yc"))

const hasBg = (u) => (u.experienceHighlights?.length > 0) || typeof u.coresignalEmployeeId === "number"
const oauth = (u) => u.linkedinOauthLinked === true || Boolean(u.linkedinOauthSub)
const pasted = (u) => u.linkedinEnrichSource === "typed_url" || Boolean(u.linkedinEnrichedAt)

// ---- per-user message + outbound + turn aggregation ----
const S = new Map(yc.map((u) => [u.id, { in: 0, out: 0, lastIn: null, lastInText: "", people: (u.ycPeopleMatchSent ?? []).length }]))
const msgs = await db.collection("pa-messages").where("createdAt", ">=", since).get()
for (const d of msgs.docs) {
  const x = d.data(); const s = S.get(String(x.userId)); if (!s) continue
  if ((x.direction ?? x.role) === "user") {
    s.in++
    const t = String(x.createdAt)
    if (!s.lastIn || t > s.lastIn) { s.lastIn = t; s.lastInText = String(x.text ?? x.body ?? "") }
  }
}
const ob = await db.collection("pa-outbound").where("createdAt", ">=", since).get()
for (const d of ob.docs) {
  const x = d.data(); const s = S.get(String(x.userId)); if (!s) continue
  if (x.status === "sent" || x.status === "delivered") s.out++
}
// causal answer index: userId -> set of inboundText that produced a reply
const answeredText = new Map()
const turns = await db.collection("pa-turns").where("createdAt", ">=", since).get()
let turnsTotal = 0, turnsDead = 0
for (const d of turns.docs) {
  const t = d.data(); if (!S.has(String(t.userId))) continue
  turnsTotal++
  const produced = Boolean(String(t.finalText ?? "").trim()) || t.deliveredViaTool === true
  if (!produced) { turnsDead++; continue }
  if (!answeredText.has(String(t.userId))) answeredText.set(String(t.userId), new Set())
  answeredText.get(String(t.userId)).add(String(t.inboundText ?? "").trim())
}
const isAnswered = (u) => {
  const s = S.get(u.id); if (!s?.lastInText) return true // never spoke -> nothing owed
  return answeredText.get(u.id)?.has(s.lastInText.trim()) ?? false
}

const n = yc.length
const pct = (k) => `${String(k).padStart(3)} (${n ? Math.round((k / n) * 100) : 0}%)`
const g = (f) => yc.filter(f)
const unanswered = g((u) => (S.get(u.id)?.in ?? 0) > 0 && !isAnswered(u))
const peopleSent = yc.reduce((a, u) => a + (S.get(u.id)?.people ?? 0), 0)

console.log(`\n════ YC STARTUP SCHOOL — since ${since.slice(0, 16)}Z ════`)
console.log(`new users (all sources) ${rows.length}   ·   YC ${n}\n`)
console.log(`── profile unlock ──`)
console.log(`  LinkedIn OAuth linked       ${pct(g(oauth).length)}`)
console.log(`  pasted their URL instead    ${pct(g(pasted).length)}`)
console.log(`  real background on file     ${pct(g(hasBg).length)}`)
console.log(`  pitched back to them        ${pct(g((u) => u.pitchedAt).length)}`)
console.log(`  OAuth'd but STILL no bg     ${pct(g((u) => oauth(u) && !hasBg(u)).length)}   <- linkedin gave us nothing`)
console.log(`\n── conversation ──`)
console.log(`  replied at least once       ${pct(g((u) => (S.get(u.id)?.in ?? 0) > 0).length)}`)
console.log(`  never replied               ${pct(g((u) => (S.get(u.id)?.in ?? 0) === 0).length)}`)
console.log(`  told us what they build     ${pct(g((u) => u.ycIntake?.building).length)}`)
console.log(`  told us who to meet         ${pct(g((u) => u.ycIntake?.wantsToMeet).length)}`)
console.log(`  both answers (matchable)    ${pct(g((u) => u.ycIntake?.building && u.ycIntake?.wantsToMeet).length)}`)
console.log(`\n── matching ──`)
console.log(`  got >=1 person              ${pct(g((u) => (S.get(u.id)?.people ?? 0) > 0).length)}`)
console.log(`  people cards sent           ${peopleSent}  (avg ${(peopleSent / Math.max(1, g((u) => (S.get(u.id)?.people ?? 0) > 0).length)).toFixed(1)}/user)`)
console.log(`\n── health ──`)
console.log(`  inbound msgs                ${yc.reduce((a, u) => a + (S.get(u.id)?.in ?? 0), 0)}`)
console.log(`  outbound delivered          ${yc.reduce((a, u) => a + (S.get(u.id)?.out ?? 0), 0)}`)
console.log(`  agent turns                 ${turnsTotal}  (produced nothing: ${turnsDead})`)
console.log(`  opted out (STOP)            ${g((u) => u.doNotContact === true).length}`)
console.log(`  UNANSWERED right now        ${unanswered.length}`)
for (const u of unanswered.slice(0, 30)) {
  console.log(`     ${(u.phoneE164 ?? u.id).padEnd(16)} ${String(S.get(u.id).lastIn).slice(11, 19)}  "${S.get(u.id).lastInText.replace(/\n/g, " ").slice(0, 46)}"`)
}
if (unanswered.length > 30) console.log(`     ... +${unanswered.length - 30} more`)
process.exit(0)
