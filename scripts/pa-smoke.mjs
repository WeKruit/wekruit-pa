// Sprint-1 smoke test: synthetic pa_inbound_event -> Cloud Function -> outbound + Qdrant.
import { initializeApp, applicationDefault } from "firebase-admin/app"
import { getFirestore, FieldValue } from "firebase-admin/firestore"
import { randomUUID } from "node:crypto"

initializeApp({ credential: applicationDefault(), projectId: "wekruit-5f89b" })
const db = getFirestore()

const userId = process.env.PA_SMOKE_USER_ID || "smoke-test-user"
const sessionId = process.env.PA_SMOKE_SESSION_ID || "smoke-test-session"
const eventId = randomUUID()
const now = new Date().toISOString()
const fromE164 = process.env.PA_SMOKE_FROM_E164
const body = process.env.PA_SMOKE_BODY || "我喜欢拿铁"

if (!fromE164) {
  console.error("[pa-smoke] PA_SMOKE_FROM_E164 is required. Use a real testable handle (e.g. your own iMessage E.164).")
  console.error("[pa-smoke] Outbox will hard-block placeholder numbers like +19990000000 to prevent runaway sends.")
  process.exit(1)
}
if (!/^\+\d{8,15}$/.test(fromE164)) {
  console.error(`[pa-smoke] PA_SMOKE_FROM_E164 must be E.164 (e.g. +14155550123). Got: ${fromE164}`)
  process.exit(1)
}
if (fromE164 === "+19990000000" || fromE164 === "+10000000000") {
  console.error(`[pa-smoke] refusing to use placeholder ${fromE164}; supply a real handle`)
  process.exit(1)
}

// 1. Ensure a pa_user exists with a known agent (use default agent flow).
await db.collection("pa_users").doc(userId).set(
  {
    id: userId,
    e164: fromE164,
    email: "smoke@local",
    activeAgentId: null,
    createdAt: now,
    updatedAt: now,
  },
  { merge: true },
)

// 2. Pre-create the session (orchestrator will append messages and set lastMessageAt).
await db.collection("pa_sessions").doc(sessionId).set(
  {
    id: sessionId,
    userId,
    externalChatId: fromE164,
    channel: "imessage",
    createdAt: now,
    updatedAt: now,
  },
  { merge: true },
)

// 3. Insert a pending pa_inbound_event — this fires the Cloud Function.
await db.collection("pa_inbound_events").doc(eventId).set({
  id: eventId,
  userId,
  sessionId,
  from: fromE164,
  body,
  status: "pending",
  createdAt: now,
  updatedAt: now,
  idempotencyKey: `smoke-${eventId}`,
  rawMeta: { source: "p8-smoke" },
})

console.log("inserted event", eventId)
console.log("user", userId, "session", sessionId)
