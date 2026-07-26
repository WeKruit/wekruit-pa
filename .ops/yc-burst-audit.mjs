// READ-ONLY. Evidence for "users get >5 people-match bubbles in one go".
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH ?? ".env", "utf8")
  .match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()

const PHONE = "+18176878717"
if (process.argv[2] === "shape") {
  const s = await db.collection("pa-outbound").where("userId", "==", "7b71a300-5d82-4a6d-b6c5-9c18b136a631").limit(2).get()
  for (const d of s.docs) console.log(d.id, JSON.stringify(Object.fromEntries(Object.entries(d.data()).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 40) : v]))).slice(0, 1200))
  process.exit(0)
}
const ms = (v) => (v?.toDate ? v.toDate().getTime() : v?._seconds ? v._seconds * 1000 : Date.parse(v ?? "") || 0)
const iso = (v) => { const t = typeof v === "number" ? v : ms(v); return t ? new Date(t).toISOString().slice(5, 19) : "?" }

// ---- 1. the user
const us = await db.collection("pa-users").where("phoneE164", "==", PHONE).get()
console.log(`\n=== pa-users for ${PHONE}: ${us.size} doc(s) ===`)
const uids = []
for (const d of us.docs) {
  const u = d.data()
  uids.push(d.id)
  console.log(`uid=${d.id} name=${u.fullName ?? u.name ?? "?"} sent=${(u.ycPeopleMatchSent ?? []).length} lastAt=${u.ycPeopleMatchLastAt ?? "-"}`)
  console.log(`  ycIntake=${JSON.stringify(u.ycIntake ?? {})}`)
}

for (const uid of uids) {
  // ---- 2. inbound/outbound interleaved
  const [outs, msgs] = await Promise.all([
    db.collection("pa-outbound").where("userId", "==", uid).get(),
    db.collection("pa-messages").where("userId", "==", uid).get(),
  ])
  const rows = []
  for (const d of outs.docs) {
    const o = d.data()
    rows.push({ t: ms(o.createdAt ?? o.sentAt), dir: "OUT", status: o.status ?? "", body: String(o.body ?? "") })
  }
  for (const d of msgs.docs) {
    const m = d.data()
    rows.push({ t: ms(m.createdAt ?? m.timestamp), dir: (m.direction ?? m.role ?? "IN").toUpperCase().slice(0, 3), status: "", body: String(m.text ?? m.body ?? m.content ?? "") })
  }
  rows.sort((a, b) => a.t - b.t)
  console.log(`\n=== timeline uid=${uid} (${rows.length} rows) ===`)
  for (const r of rows) {
    const isPerson = r.dir === "OUT" && /linkedin\.com\/in\//.test(r.body)
    console.log(`${iso(r.t)} ${r.dir}${isPerson ? "*PERSON*" : "       "} ${r.status.padEnd(9)} ${r.body.replace(/\n/g, " | ").slice(0, 90)}`)
  }

  // ---- 3. tool calls: the actual `limit` the model passed
  const turns = await db.collection("pa-turns").where("userId", "==", uid).get()
  console.log(`\n=== pa-turns uid=${uid} (${turns.size}) ===`)
  const tr = turns.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => ms(a.createdAt) - ms(b.createdAt))
  for (const t of tr) {
    const calls = Array.isArray(t.toolCalls) ? t.toolCalls : []
    const yc = calls.filter((c) => String(c.name ?? c.tool ?? "").includes("yc_people"))
    if (yc.length === 0 && calls.length === 0) continue
    console.log(`${iso(t.createdAt)} inbound="${String(t.inboundText ?? t.userText ?? t.text ?? "").slice(0, 70)}" calls=${calls.length} ycCalls=${yc.length}`)
    for (const c of yc) console.log(`    → ${JSON.stringify(c).slice(0, 500)}`)
  }
}

// ---- 4. fleet-wide: bursts in last 20h. createdAt is an ISO STRING → compare as string.
const sinceIso = new Date(Date.now() - 20 * 3600e3).toISOString()
const all = await db.collection("pa-outbound").where("createdAt", ">=", sinceIso).get()
const byUser = new Map()
const perDelivery = new Map() // idempotencyKey → person-bubble count (one tool call = one key)
for (const d of all.docs) {
  const o = d.data()
  if (!/linkedin\.com\/in\//.test(String(o.body ?? ""))) continue
  const k = o.userId ?? "?"
  if (!byUser.has(k)) byUser.set(k, [])
  byUser.get(k).push(ms(o.createdAt))
  const key = `${k}|${o.idempotencyKey ?? d.id}`
  perDelivery.set(key, (perDelivery.get(key) ?? 0) + 1)
}
const dist = { "1-5": 0, "6-10": 0, "11-15": 0, "16+": 0 }
const offenders = []
for (const [uid, ts] of byUser) {
  ts.sort((a, b) => a - b)
  let max = 0
  for (let i = 0; i < ts.length; i++) {
    let j = i
    while (j < ts.length && ts[j] - ts[i] <= 5 * 60e3) j++
    max = Math.max(max, j - i)
  }
  dist[max <= 5 ? "1-5" : max <= 10 ? "6-10" : max <= 15 ? "11-15" : "16+"]++
  if (max > 5) offenders.push({ uid, max, total: ts.length })
}
console.log(`\n=== fleet: ${byUser.size} users got person-bubbles in last 20h ===`)
console.log(`users by MAX person-bubbles in any 5-min window: ${JSON.stringify(dist)}`)
offenders.sort((a, b) => b.max - a.max)
for (const o of offenders) console.log(`  ${o.uid} burst=${o.max} total20h=${o.total}`)
// per-SINGLE-tool-call sizes — separates "one call sent 10" from "two calls of 5"
const callDist = {}
for (const n of perDelivery.values()) callDist[n] = (callDist[n] ?? 0) + 1
console.log(`\nperson-bubbles per SINGLE delivery (idempotencyKey): ${JSON.stringify(callDist)}`)
console.log(`deliveries >5 in one call: ${[...perDelivery.values()].filter((n) => n > 5).length} of ${perDelivery.size}`)
process.exit(0)
