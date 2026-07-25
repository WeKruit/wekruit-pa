/**
 * READ-ONLY: users whose LATEST pa-message is their own inbound, with NO pa-outbound row created
 * after it. Excludes anything younger than MIN_AGE_MIN (in-flight).
 *
 *   PA_ENV_PATH=$PWD/.env node .ops/zz-silence.mjs [windowMinutes] [minAgeMinutes]
 */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()

const windowMin = Number(process.argv[2] ?? 120)
const minAgeMin = Number(process.argv[3] ?? 2)
const since = new Date(Date.now() - windowMin * 60 * 1000).toISOString()
const cutoff = new Date(Date.now() - minAgeMin * 60 * 1000).toISOString()

const msgs = await db.collection("pa-messages").where("createdAt", ">=", since).get()
const byUser = new Map()
for (const d of msgs.docs) {
  const x = d.data()
  if (!x.userId) continue
  if (!byUser.has(x.userId)) byUser.set(x.userId, [])
  byUser.get(x.userId).push(x)
}
const outSnap = await db.collection("pa-outbound").where("createdAt", ">=", since).get()
const outByUser = new Map()
for (const d of outSnap.docs) {
  const x = d.data()
  if (!outByUser.has(x.userId)) outByUser.set(x.userId, [])
  outByUser.get(x.userId).push(x)
}

const silent = []
for (const [uid, list] of byUser) {
  list.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  const last = list[list.length - 1]
  const dir = last.direction ?? last.role
  if (dir !== "user" && dir !== "inbound") continue
  const at = String(last.createdAt ?? "")
  if (at > cutoff) continue // in-flight
  const after = (outByUser.get(uid) ?? []).filter((r) => String(r.createdAt ?? "") > at)
  if (after.length > 0) continue
  const u = (await db.collection("pa-users").doc(uid).get()).data() ?? {}
  silent.push({
    uid,
    phone: u.phoneE164 ?? "-",
    name: u.displayName ?? "-",
    at,
    ageMin: ((Date.now() - Date.parse(at)) / 60000).toFixed(1),
    text: String(last.text ?? last.body ?? "").replace(/\n/g, " ").slice(0, 80),
    msgs: list.length,
  })
}
silent.sort((a, b) => a.at.localeCompare(b.at))
console.log(`window=${windowMin}min since=${since}  minAge=${minAgeMin}min`)
console.log(`users with messages: ${byUser.size}   UNANSWERED (last msg theirs, no outbound after): ${silent.length}`)
for (const s of silent) {
  console.log(`  ${s.at.slice(11, 19)} (+${s.ageMin}m) ${s.phone} ${s.uid} msgs=${s.msgs} "${s.text}"`)
}
process.exit(0)
