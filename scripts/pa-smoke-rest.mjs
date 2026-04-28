// Sprint-1 smoke test using Firestore REST API + Firebase CLI's OAuth token.
// We avoid `firebase-admin` because ADC is unavailable in this env.
import fs from "node:fs"
import os from "node:os"
import { randomUUID } from "node:crypto"

const cfg = JSON.parse(
  fs.readFileSync(os.homedir() + "/.config/configstore/firebase-tools.json", "utf8"),
)
const accessToken = cfg.tokens.access_token

const PROJECT = "wekruit-5f89b"
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`

async function setDoc(path, fields) {
  const url = `${BASE}/${path}`
  const r = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields }),
  })
  if (!r.ok) throw new Error(`set ${path} ${r.status}: ${await r.text()}`)
  return r.json()
}

async function getCollection(name, opts = {}) {
  const params = new URLSearchParams()
  if (opts.pageSize) params.set("pageSize", String(opts.pageSize))
  const url = `${BASE}/${name}?${params}`
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!r.ok) throw new Error(`get ${name} ${r.status}: ${await r.text()}`)
  return r.json()
}

const s = (v) => ({ stringValue: v })
const m = (obj) => ({ mapValue: { fields: obj } })

const userId = "smoke-test-user"
const sessionId = "smoke-test-session"
const eventId = randomUUID()
const now = new Date().toISOString()
const fromE164 = "+19990000000"

await setDoc(`pa-users/${userId}`, {
  id: s(userId),
  e164: s(fromE164),
  email: s("smoke@local"),
  createdAt: s(now),
  updatedAt: s(now),
})

await setDoc(`pa-sessions/${sessionId}`, {
  id: s(sessionId),
  userId: s(userId),
  externalChatId: s(fromE164),
  channel: s("imessage"),
  createdAt: s(now),
  updatedAt: s(now),
})

await setDoc(`pa-inbound-events/${eventId}`, {
  id: s(eventId),
  userId: s(userId),
  sessionId: s(sessionId),
  from: s(fromE164),
  body: s("我喜欢拿铁"),
  status: s("pending"),
  createdAt: s(now),
  updatedAt: s(now),
  idempotencyKey: s(`smoke-${eventId}`),
  rawMeta: m({ source: s("p8-smoke") }),
})

console.log("inserted event", eventId)
console.log("user", userId, "session", sessionId)
process.stdout.write(eventId + "\n")
fs.writeFileSync("/tmp/smoke-event-id.txt", eventId)
