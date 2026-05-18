#!/usr/bin/env node
import admin from "firebase-admin"
import fs from "node:fs"
import { setTimeout as delay } from "node:timers/promises"

const args = new Map()
for (const raw of process.argv.slice(2)) {
  const [key, ...rest] = raw.replace(/^--/, "").split("=")
  args.set(key, rest.join("=") || "1")
}

const repo = args.get("repo") ?? process.cwd()
const envRepo = args.get("env-repo") ?? "/Users/adam/Desktop/WeKruit/wekruit-pa"
const userId = args.get("user") ?? "U7AwKT8nLDRa35DkuBxq"
const limit = Number.parseInt(args.get("limit") ?? "3", 10)
const send = args.get("send") === "1"
const idempotencyKey = args.get("idempotency-key") ?? `${userId}-${Date.now()}-job-rec-interface-proof`

function loadEnv(path) {
  if (!fs.existsSync(path)) return
  const text = fs.readFileSync(path, "utf8")
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z_0-9]*)=(.*)$/)
    if (!m) continue
    let value = m[2] ?? ""
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!process.env[m[1]]) process.env[m[1]] = value
  }
}

loadEnv(`${envRepo}/.env`)

if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON missing")
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: "wekruit-5f89b",
})
const db = admin.firestore()

const { queryMatchingJobsV16, sendImessage } = await import("@pa/job-rec")
const {
  collectJobRecommendationMessageItems,
  composeJobRecommendationMessage,
  compactJobRecContext,
} = await import(`${repo}/apps/functions/src/job-rec-copy.ts`)

const log = (event, payload) => {
  if (event === "pa.match.hard_filter_applied" || event === "pa.match.query_final") {
    console.log(`[v16] ${event}`, JSON.stringify(payload ?? {}))
  }
}

const userSnap = await db.collection("pa-users").doc(userId).get()
if (!userSnap.exists) throw new Error(`pa-users/${userId} missing`)
const user = userSnap.data() ?? {}
console.log("[live-job-rec] user", JSON.stringify({
  userId,
  email: user.email ?? user.primaryEmail ?? null,
  phoneE164: user.phoneE164 ?? null,
}))

const result = await queryMatchingJobsV16({ userId, limit: 10, lang: "en" }, { db, log })
console.log("[live-job-rec] query", JSON.stringify({
  noUserTags: !!result.noUserTags,
  jobs: result.jobs?.length ?? 0,
  total: result.total,
  dropped: result.dropped,
  hardFilter: result.hardFilter,
}))

const requestedCount = Number.isFinite(limit) && limit > 0 ? limit : 3
const items = collectJobRecommendationMessageItems(result.jobs, "en", { limit: requestedCount })
if (items.length === 0) {
  throw new Error("No linkable job recommendations available")
}

const context = compactJobRecContext(user.tags)
const body = composeJobRecommendationMessage(items, "en", context, {
  footer: "See if these fit. If not, tell me what is off and I will keep looking.",
})

const itemBlocks = body.split(/\n\n/).filter((block) => block.startsWith("• "))
for (const block of itemBlocks) {
  if (!/https?:\/\//.test(block)) throw new Error(`recommendation missing URL: ${block}`)
  if (!/requirements:/i.test(block)) throw new Error(`recommendation missing requirements: ${block}`)
}
if (itemBlocks.length !== items.length) {
  throw new Error(`rendered ${itemBlocks.length} blocks for ${items.length} items`)
}

console.log("[live-job-rec] rendered-body-start")
console.log(body)
console.log("[live-job-rec] rendered-body-end")

if (send) {
  const sent = await sendImessage(
    { userId, content: body, idempotencyKey },
    { db, log: (...parts) => console.log("[sendImessage]", ...parts) },
  )
  console.log("[live-job-rec] enqueued", JSON.stringify(sent))
  const runtimeEventId = sent.runtimeEventId ?? sent.messageHandle
  if (!sent.ok || !runtimeEventId) throw new Error("sendImessage did not enqueue runtime event")

  for (let attempt = 1; attempt <= 12; attempt++) {
    await delay(5000)
    const outboundSnap = await db
      .collection("pa-outbound")
      .where("idempotencyKey", "==", `outbound-${runtimeEventId}`)
      .limit(1)
      .get()
    const first = outboundSnap.docs[0]
    const data = first?.data() ?? {}
    console.log("[live-job-rec] outbound", JSON.stringify({
      attempt,
      runtimeEventId,
      id: first?.id ?? null,
      status: data.status,
      toE164: data.toE164,
      bodyHasUrl: /https?:\/\//.test(data.body ?? ""),
      bodyHasRequirements: /requirements:/i.test(data.body ?? ""),
      providerMessageId: data.providerMessageId ?? data.sendblueMessageId ?? null,
      error: data.error ?? null,
    }))
    if (["sent", "delivered", "failed"].includes(data.status)) break
  }
}
