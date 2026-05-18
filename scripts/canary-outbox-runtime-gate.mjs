import { readFileSync } from "node:fs"
import { createRequire } from "node:module"

const require = createRequire(new URL("../apps/functions/package.json", import.meta.url))
const { cert, getApps, initializeApp } = require("firebase-admin/app")
const { getFirestore } = require("firebase-admin/firestore")

function loadServiceAccount() {
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  if (inline?.trim()) return JSON.parse(inline)
  const env = readFileSync(".env", "utf8")
  const line = env.split(/\r?\n/).find((entry) => entry.startsWith("FIREBASE_SERVICE_ACCOUNT_JSON="))
  if (!line) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON missing")
  return JSON.parse(line.slice("FIREBASE_SERVICE_ACCOUNT_JSON=".length))
}

if (!getApps().length) {
  const serviceAccount = loadServiceAccount()
  initializeApp({ credential: cert(serviceAccount), projectId: serviceAccount.project_id })
}

const db = getFirestore()
const id = `canary-runtime-gate-${Date.now()}`
const ref = db.collection("pa-outbound").doc(id)
const now = new Date().toISOString()

await ref.set({
  userId: "runtime-gate-canary",
  toE164: "+13054507715",
  body: "Runtime gate canary. This should be blocked before send.",
  status: "pending",
  runtimeApproved: true,
  runtimeSource: "pa_proactive_turn",
  idempotencyKey: id,
  createdAt: now,
  updatedAt: now,
})

let finalData = null
for (let i = 0; i < 24; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 2500))
  const snap = await ref.get()
  const data = snap.data() ?? {}
  if (data.status === "failed" || data.status === "sent") {
    finalData = data
    break
  }
}

const data = finalData ?? ((await ref.get()).data() ?? {})
const projection = {
  id,
  status: data.status ?? null,
  blockedByRuntimeGate: data.blockedByRuntimeGate ?? null,
  error: data.error ?? null,
  runtimeSource: data.runtimeSource ?? null,
  messageHandle: data.messageHandle ?? null,
  uuid: data.uuid ?? null,
  sendblueStatus: data.sendblueStatus ?? null,
}
console.log(JSON.stringify(projection, null, 2))

if (
  projection.status !== "failed" ||
  projection.blockedByRuntimeGate !== true ||
  projection.error !== "blocked: outbound row was not approved by runtime" ||
  projection.messageHandle ||
  projection.uuid
) {
  process.exit(1)
}
