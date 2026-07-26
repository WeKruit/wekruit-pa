/**
 * READ-ONLY: turns that produced NOTHING — empty finalText AND no pa-outbound row created AFTER
 * the turn. Split BEFORE/AFTER a deploy boundary. (Stricter than yc-guard-silence.mjs, which
 * credits outbound from the PREVIOUS turn because it looks back 90s.)
 *
 *   PA_ENV_PATH=$PWD/.env DEPLOY_AT=2026-07-25T17:44:00Z node .ops/zz-dead-turns.mjs [sinceIso]
 */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()

const DEPLOY_AT = process.env.DEPLOY_AT ?? "2026-07-25T17:44:00Z"
const since = process.argv[2] ?? "2026-07-25T15:00:00Z"
const cutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString() // ignore in-flight

const turns = await db.collection("pa-turns").where("createdAt", ">=", since).get()
const ob = await db.collection("pa-outbound").where("createdAt", ">=", since).get()
const byUser = new Map()
for (const d of ob.docs) {
  const x = d.data()
  if (!byUser.has(x.userId)) byUser.set(x.userId, [])
  byUser.get(x.userId).push(String(x.createdAt ?? ""))
}

const dead = []
for (const t of turns.docs) {
  const d = t.data()
  const at = String(d.createdAt ?? "")
  if (at > cutoff) continue
  const names = (d.toolCalls ?? []).map((c) => c.name ?? c)
  const finalText = String(d.finalText ?? d.replyText ?? "").trim()
  if (finalText.length > 0) continue
  const after = (byUser.get(d.userId) ?? []).filter((c) => c > at)
  if (after.length > 0) continue
  dead.push({ at, uid: d.userId, tools: names.join(","), err: String(d.error ?? "-").slice(0, 60) })
}
dead.sort((a, b) => a.at.localeCompare(b.at))
const before = dead.filter((x) => x.at < DEPLOY_AT)
const after = dead.filter((x) => x.at >= DEPLOY_AT)
console.log(`turns since ${since}: ${turns.size}`)
console.log(`DEAD turns (empty finalText AND no outbound after): ${dead.length}   BEFORE=${before.length} AFTER=${after.length}`)
for (const label of ["BEFORE", "AFTER"]) {
  const list = label === "BEFORE" ? before : after
  console.log(`\n--- ${label} deploy (${list.length}) ---`)
  for (const x of list) console.log(`  ${x.at.slice(11, 19)} ${x.uid} tools=[${x.tools}] err=${x.err}`)
}
process.exit(0)
