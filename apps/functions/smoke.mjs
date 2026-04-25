import { getAccessToken, getGlobalDefaultAccount } from "firebase-tools/lib/auth.js"

const projectId = process.env.FIREBASE_PROJECT_ID || "wekruit-5f89b"
const databaseId = "(default)"
const now = new Date().toISOString()
const id = `pa-smoke-${Date.now()}`
const userId = process.env.PA_SMOKE_USER_ID || "user-smoke"
const from = process.env.PA_SMOKE_FROM || "admin1@wekruit.com"
const sessionId = process.env.PA_SMOKE_SESSION_ID || `session-smoke-${from.replace(/[^a-zA-Z0-9_-]/g, "-")}`
const body =
  process.env.PA_SMOKE_BODY ||
  `Smoke ${id}: remember my verification codename is vector-lantern. Reply with one short sentence.`

function field(value) {
  if (value === null) return { nullValue: null }
  if (typeof value === "string") return { stringValue: value }
  if (typeof value === "number" && Number.isInteger(value)) return { integerValue: String(value) }
  if (typeof value === "number") return { doubleValue: value }
  if (typeof value === "boolean") return { booleanValue: value }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(field) } }
  if (typeof value === "object") {
    return {
      mapValue: {
        fields: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, field(v)])),
      },
    }
  }
  throw new Error(`Unsupported Firestore field value: ${String(value)}`)
}

function docBody(fields) {
  return { fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, field(v)])) }
}

async function accessToken() {
  const account = getGlobalDefaultAccount()
  if (!account?.tokens?.refresh_token) throw new Error("No Firebase CLI refresh token found")
  const token = await getAccessToken(account.tokens.refresh_token, [
    "email",
    "openid",
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/firebase",
  ])
  if (!token?.access_token) throw new Error("Could not mint Firebase access token")
  return token.access_token
}

const token = await accessToken()
const url =
  `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${databaseId}` +
  `/documents/pa_inbound_events/${encodeURIComponent(id)}`

const event = {
  id,
  userId,
  sessionId,
  channel: "imessage",
  externalChatId: from,
  from,
  body,
  status: "pending",
  createdAt: now,
  idempotencyKey: `smoke-in-${id}`,
  rawMeta: { source: "smoke", origin: "codex", kind: "mem0-qdrant" },
}

const resp = await fetch(url, {
  method: "PATCH",
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  },
  body: JSON.stringify(docBody(event)),
})

const text = await resp.text()
if (!resp.ok) {
  throw new Error(`Smoke write failed ${resp.status}: ${text.slice(0, 500)}`)
}

console.log(JSON.stringify({ id, userId, sessionId, from, body }))
