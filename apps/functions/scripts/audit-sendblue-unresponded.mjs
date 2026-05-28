#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { cert, getApps, initializeApp } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

const PROJECT_ID = "wekruit-5f89b"
const WEKRUIT_SENDER = "+17174919939"
const PRESCREEN_TOKEN_RE = /WeKruit_([A-Za-z0-9-]+)_([A-Za-z0-9_-]+)_Job/i
const E164_RE = /^\+[1-9]\d{7,14}$/

const args = parseArgs(process.argv.slice(2))

if (args.help) {
  console.log(`Usage: node apps/functions/scripts/audit-sendblue-unresponded.mjs [--limit=5000] [--json]

Read-only. Scans pa-sendblue-webhook-raw for conversations where the latest
candidate inbound has no later Sendblue outbound, then classifies prescreen
trigger holes separately from ordinary follow-up messages.`)
  process.exit(0)
}

const db = initDb()
const report = await runAudit(db, args)

if (args.json) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`Read-only Sendblue unresponded audit`)
  console.log(`Scanned raw rows: ${report.scannedRaw}; conversations: ${report.conversations}; unresponded: ${report.unrespondedCount}`)
  console.log(JSON.stringify(report.countsByClass, null, 2))
  for (const row of report.rows) {
    console.log(`- ${row.phone} ${row.latestInboundAt} ${row.className}`)
    console.log(`  ${row.latestInboundText}`)
    console.log(`  action: ${row.recommendedAction}`)
  }
}

async function runAudit(db, opts) {
  const rawSnap = await db
    .collection("pa-sendblue-webhook-raw")
    .orderBy("receivedAt", "desc")
    .limit(opts.limit)
    .get()

  const conversations = new Map()
  for (const doc of rawSnap.docs) {
    const parsed = parseRawWebhookDoc(doc)
    if (!parsed?.peer || !E164_RE.test(parsed.peer)) continue
    const current = conversations.get(parsed.peer) ?? {
      phone: parsed.peer,
      latestInbound: null,
      latestOutbound: null,
    }
    if (!parsed.outbound && (!current.latestInbound || parsed.messageAt > current.latestInbound.messageAt)) {
      current.latestInbound = parsed
    }
    if (parsed.outbound && (!current.latestOutbound || parsed.messageAt > current.latestOutbound.messageAt)) {
      current.latestOutbound = parsed
    }
    conversations.set(parsed.peer, current)
  }

  const unresponded = [...conversations.values()]
    .filter((conversation) => {
      if (!conversation.latestInbound) return false
      if (!conversation.latestOutbound) return true
      return conversation.latestInbound.messageAt > conversation.latestOutbound.messageAt
    })
    .sort((a, b) => b.latestInbound.messageAt.localeCompare(a.latestInbound.messageAt))

  const rows = []
  for (const conversation of unresponded.slice(0, opts.samples)) {
    rows.push(await classifyConversation(db, conversation))
  }

  const countsByClass = rows.reduce((acc, row) => {
    acc[row.className] = (acc[row.className] ?? 0) + 1
    return acc
  }, {})

  return {
    readOnly: true,
    scannedRaw: rawSnap.size,
    conversations: conversations.size,
    unrespondedCount: unresponded.length,
    countsByClass,
    rows,
  }
}

function parseRawWebhookDoc(doc) {
  const data = doc.data() ?? {}
  let payload = null
  if (typeof data.bodyText === "string") {
    try {
      payload = JSON.parse(data.bodyText)
    } catch {
      payload = null
    }
  } else if (data.payload && typeof data.payload === "object") {
    payload = data.payload
  }
  if (!payload || typeof payload !== "object") return null

  const from = cleanString(payload.from_number, 120)
  const to = cleanString(payload.to_number, 120)
  const content = cleanString(payload.content, 4_000) ?? ""
  const outbound = payload.is_outbound === true || from === WEKRUIT_SENDER
  const peer = outbound ? to : from
  if (!peer) return null
  const webhookReceivedAt = cleanString(data.receivedAt, 80) ?? timestampToIso(data.receivedAt) ?? ""
  const providerSentAt = cleanString(payload.date_sent, 80)
  const messageAt = providerSentAt ?? webhookReceivedAt

  return {
    rawId: doc.id,
    receivedAt: webhookReceivedAt,
    messageAt,
    from,
    to,
    peer,
    content,
    outbound,
    status: cleanString(payload.status, 80),
    messageHandle: cleanString(payload.message_handle, 240),
  }
}

async function classifyConversation(db, conversation) {
  const inbound = conversation.latestInbound
  const latestOutbound = conversation.latestOutbound
  const token = inbound.content.match(PRESCREEN_TOKEN_RE)
  const base = {
    phone: conversation.phone,
    latestInboundAt: inbound.messageAt,
    latestInboundRawId: inbound.rawId,
    latestInboundText: inbound.content.slice(0, 240),
    latestOutboundAt: latestOutbound?.messageAt ?? null,
    latestOutboundText: latestOutbound?.content?.slice(0, 160) ?? null,
    messageHandle: inbound.messageHandle ?? null,
  }

  if (!token) {
    return {
      ...base,
      className: "ordinary_inbound_no_later_outbound",
      recommendedAction: "Route or replay through the normal Claire inbound path after checking transcript context; not a prescreen-start recovery.",
    }
  }

  const [, jobId, userId] = token
  const userSnap = await db.collection("pa-users").doc(userId).get()
  const user = userSnap.exists ? userSnap.data() ?? {} : {}
  const idempotencyKey = `${jobId}_${userId}_${inbound.messageHandle || "missing_message_handle"}`
  const [idempotencySnap, outboundSnap, auditSnap] = await Promise.all([
    db.collection("pa-prescreen-trigger-idempotency").doc(idempotencyKey).get(),
    E164_RE.test(inbound.from ?? "")
      ? db.collection("pa-outbound").where("toE164", "==", inbound.from).limit(50).get()
      : Promise.resolve({ docs: [] }),
    inbound.messageHandle
      ? db.collection("pa-audit-events").where("correlationId", "==", inbound.messageHandle).limit(20).get()
      : Promise.resolve({ docs: [] }),
  ])

  const sessionSnap = userSnap.exists
    ? await db.collection("pa-prescreen-sessions").where("userId", "==", userId).limit(50).get()
    : { docs: [] }
  const stateSnap = userSnap.exists
    ? await db.collection("pa-candidate-job-states").where("userId", "==", userId).where("jobId", "==", jobId).limit(20).get()
    : { docs: [] }

  const sessionsForJob = sessionSnap.docs
    .map((doc) => ({ id: doc.id, ...(doc.data() ?? {}) }))
    .filter((session) => session.jobId === jobId || session.paJobId === jobId)
  const outboundAfterInbound = outboundSnap.docs
    .map((doc) => ({ id: doc.id, ...(doc.data() ?? {}) }))
    .filter((outbound) => isAtOrAfter(outbound.createdAt ?? outbound.queuedAt ?? outbound.updatedAt, inbound.messageAt))
  const auditTypes = auditSnap.docs.map((doc) => {
    const data = doc.data() ?? {}
    return data.type ?? data.reason ?? data.payload?.type ?? null
  }).filter(Boolean)

  let className = "prescreen_token_unresponded_unknown"
  let recommendedAction = "Inspect raw/audit/session records before sending anything."
  const userPhone = cleanString(user.phoneE164, 120)
  const phoneMismatch = Boolean(userPhone && userPhone !== inbound.from)

  if (!E164_RE.test(inbound.from ?? "")) {
    className = "non_e164_sender_rejected"
    recommendedAction = "No SMS recovery target exists for this inbound sender; candidate used an email/Apple-ID handle."
  } else if (phoneMismatch) {
    className = "phone_identity_mismatch"
    recommendedAction = "Do not start prescreen for this phone as the parsed candidate; send only an identity-conflict notice if Adam approves a real SMS."
  } else if (idempotencySnap.exists && sessionsForJob.length === 0 && outboundAfterInbound.length === 0 && stateSnap.empty) {
    className = "prescreen_idempotent_no_session_or_outbound"
    recommendedAction = "Safe recovery class: manually start the prescreen for this user/job after Adam approves the real candidate SMS."
  } else if (sessionsForJob.length > 0 && outboundAfterInbound.length === 0) {
    className = "prescreen_session_exists_no_later_outbound_to_this_phone"
    recommendedAction = "Check whether the session belongs to a different phone/thread before sending a follow-up."
  }

  return {
    ...base,
    className,
    recommendedAction,
    jobId,
    userId,
    userExists: userSnap.exists,
    userPhoneE164: userPhone,
    phoneMismatch,
    idempotencyExists: idempotencySnap.exists,
    sessionCount: sessionsForJob.length,
    outboundAfterInbound: outboundAfterInbound.length,
    candidateJobStateCount: stateSnap.size,
    auditTypes,
  }
}

function isAtOrAfter(value, floorIso) {
  const iso = timestampToIso(value) ?? cleanString(value, 80)
  if (!iso || !floorIso) return true
  return iso >= floorIso
}

function cleanString(value, max) {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, max) : null
}

function timestampToIso(value) {
  if (value && typeof value.toDate === "function") return value.toDate().toISOString()
  if (value && typeof value._seconds === "number") return new Date(value._seconds * 1000).toISOString()
  return null
}

function initDb() {
  if (!getApps().length) {
    const sa = loadServiceAccount()
    initializeApp({ credential: cert(sa), projectId: sa.project_id ?? PROJECT_ID })
  }
  return getFirestore()
}

function loadServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
  const envPath = resolve(process.cwd(), ".env")
  if (existsSync(envPath)) {
    const envText = readFileSync(envPath, "utf8")
    const match = envText.match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.+)$/m)
    if (match) return JSON.parse(match[1])
  }
  throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON missing. Run from repo root or export it.")
}

function parseArgs(argv) {
  const parsed = {
    limit: 5000,
    samples: 100,
    json: false,
    help: false,
  }
  for (const arg of argv) {
    if (arg === "--json") parsed.json = true
    else if (arg === "--help" || arg === "-h") parsed.help = true
    else if (arg.startsWith("--limit=")) parsed.limit = clampInt(arg.slice("--limit=".length), 1, 10000, 5000)
    else if (arg.startsWith("--samples=")) parsed.samples = clampInt(arg.slice("--samples=".length), 1, 500, 100)
    else throw new Error(`Unknown arg: ${arg}`)
  }
  return parsed
}

function clampInt(raw, min, max, fallback) {
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}
