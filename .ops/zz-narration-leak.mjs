/**
 * READ-ONLY: count outbound bodies in a window containing internal-narration phrases.
 *   PA_ENV_PATH=$PWD/.env node .ops/zz-narration-leak.mjs [hours]
 */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()

const hours = Number(process.argv[2] ?? 2)
const since = new Date(Date.now() - hours * 3600 * 1000).toISOString()
const PHRASES = [
  "on your screen",
  "previous batch",
  "nothing new came through",
  "i tried to pull",
  "can't send another batch",
  "go deeper on",
  "dive deeper",
]

const scan = async (coll, bodyField) => {
  const snap = await db.collection(coll).where("createdAt", ">=", since).get()
  const hits = new Map(PHRASES.map((p) => [p, []]))
  let total = 0
  for (const d of snap.docs) {
    const x = d.data()
    if (coll === "pa-messages" && x.role !== "assistant") continue
    const body = String(x[bodyField] ?? x.text ?? x.body ?? "")
    if (!body) continue
    total++
    const lower = body.toLowerCase()
    for (const p of PHRASES) {
      if (lower.includes(p)) hits.get(p).push({ at: String(x.createdAt ?? ""), uid: x.userId, body: body.replace(/\n/g, " ").slice(0, 140) })
    }
  }
  console.log(`\n=== ${coll} last ${hours}h (since ${since}) — bodies scanned: ${total} ===`)
  let grand = 0
  for (const p of PHRASES) {
    const list = hits.get(p).sort((a, b) => a.at.localeCompare(b.at))
    grand += list.length
    const newest = list[list.length - 1]
    console.log(`  "${p}": ${list.length}${newest ? `   newest=${newest.at} uid=${newest.uid}` : ""}`)
    if (newest) console.log(`      "${newest.body}"`)
  }
  console.log(`  TOTAL leak bodies: ${grand}`)
  return grand
}

await scan("pa-outbound", "body")
await scan("pa-messages", "body")
process.exit(0)
