/**
 * Count pa-messages rows whose body is the RAW agent envelope `{"messages":[...]}`
 * instead of the delivered prose. Should read 0 for windows after the fix deploys.
 *
 *   PA_ENV_PATH=/path/to/.env node .ops/raw-envelope-rows.mjs [hours]
 */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()

const hours = Number(process.argv[2] ?? 24)
const since = new Date(Date.now() - hours * 3600 * 1000).toISOString()

const isEnvelope = (body) => {
  if (typeof body !== "string") return false
  const t = body.trim()
  if (!t.startsWith("{") || !t.includes('"messages"')) return false
  try {
    return Array.isArray(JSON.parse(t).messages)
  } catch {
    return false
  }
}

const snap = await db.collection("pa-messages").where("createdAt", ">=", since).get()
let assistant = 0
const bad = []
const bySource = {}
for (const d of snap.docs) {
  const m = d.data()
  if (m.role !== "assistant") continue
  assistant++
  if (!isEnvelope(m.body)) continue
  const src = String(m.rawMeta?.source ?? "(none)")
  bySource[src] = (bySource[src] || 0) + 1
  bad.push({ id: d.id, createdAt: m.createdAt, source: src, body: String(m.body).slice(0, 110) })
}

const pct = assistant ? ((bad.length / assistant) * 100).toFixed(1) : "0.0"
console.log(`window=${hours}h since=${since}`)
console.log(`assistant rows: ${assistant}`)
console.log(`raw-envelope rows: ${bad.length} (${pct}%)`)
console.log(`by rawMeta.source: ${JSON.stringify(bySource)}`)
for (const b of bad.slice(-10)) console.log(` ${b.createdAt} [${b.source}] ${b.body}`)
process.exit(0)
