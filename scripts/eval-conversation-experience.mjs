#!/usr/bin/env node
/**
 * Claire conversation experience eval harness.
 *
 * This is intentionally production-state first: it reads the same Firestore
 * surfaces a live candidate turn touches, then grades transcript continuity,
 * context use, transcript integrity, and human-feel. Unit tests can still
 * cover pure functions, but this harness is the acceptance layer for the
 * bugs that show up in Messages.
 *
 * Usage:
 *   PA_RUN_EVAL=1 node scripts/eval-conversation-experience.mjs \
 *     --phone +14243201960 --since 2026-05-27T20:36:46.377Z
 */
import { readFileSync } from "node:fs"
import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { runJudge } from "../tests/scenarios/judge.mjs"

const PA_USERS = "pa-users"
const PA_MESSAGES = "pa-messages"
const PA_INBOUND_EVENTS = "pa-inbound-events"
const PA_TURN_TRACES = "pa-turn-traces"
const PA_CONVERSATION_EVIDENCE = "pa-conversation-evidence"
const PA_TOOL_CALLS = "pa-tool-calls"

const args = parseArgs(process.argv.slice(2))
if (!args.userId && !args.phone) usage("Provide --user-id <uid> or --phone <e164>.")

loadDotEnv(".env")
const db = getDb()
const user = args.userId
  ? await loadUserById(db, String(args.userId))
  : await loadUserByPhone(db, normalizeE164(String(args.phone)))
if (!user) throw new Error("No pa-users row found for requested user.")

const sinceIso = args.since ? normalizeSince(String(args.since)) : new Date(Date.now() - 20 * 60_000).toISOString()
const sinceMs = Date.parse(sinceIso)
const [messages, inboundEvents, traces, evidenceWrites, toolCalls] = await Promise.all([
  loadRecentRows(db, PA_MESSAGES, user.id, "createdAt", 160, sinceMs),
  loadRecentRows(db, PA_INBOUND_EVENTS, user.id, "createdAt", 80, sinceMs),
  loadRecentRows(db, PA_TURN_TRACES, user.id, "updatedAt", 80, sinceMs),
  loadRecentRows(db, PA_CONVERSATION_EVIDENCE, user.id, "createdAt", 80, sinceMs),
  loadRecentRows(db, PA_TOOL_CALLS, user.id, "createdAt", 80, sinceMs),
])

messages.sort((a, b) => rowMs(a, "createdAt") - rowMs(b, "createdAt"))
inboundEvents.sort((a, b) => rowMs(a, "createdAt") - rowMs(b, "createdAt"))
traces.sort((a, b) => rowMs(a, "updatedAt") - rowMs(b, "updatedAt"))

const deterministicChecks = buildDeterministicChecks({
  messages,
  traces,
  inboundEvents,
  evidenceWrites,
})
const llmEnabled = args.llm === true || process.env.PA_RUN_EVAL === "1"
const judgeResults = llmEnabled
  ? await runConversationJudges({ messages, userId: user.id, sinceIso })
  : []
const failedChecks = deterministicChecks.filter((check) => !check.pass)
const failedJudges = judgeResults.filter((judge) => judge.verdict !== "pass")

const output = {
  userId: user.id,
  since: sinceIso,
  source: "firestore_production_state",
  counts: {
    messages: messages.length,
    inboundEvents: inboundEvents.length,
    traces: traces.length,
    evidenceWrites: evidenceWrites.length,
    toolCalls: toolCalls.length,
  },
  latestInbound: summarizeInbound(inboundEvents.at(-1)),
  latestAssistant: summarizeMessage([...messages].reverse().find((row) => row.role === "assistant" && textOf(row).trim())),
  deterministicChecks,
  judgeResults,
  transcript: messages.map(summarizeMessage),
  traces: traces.map(summarizeTrace),
  evidenceWrites: evidenceWrites.map(summarizeEvidence),
  toolCalls: toolCalls.map(summarizeToolCall),
  pass: failedChecks.length === 0 && failedJudges.length === 0,
}

console.log(JSON.stringify(output, null, 2))
if (!output.pass) process.exitCode = 1

function buildDeterministicChecks({ messages, traces, inboundEvents, evidenceWrites }) {
  const assistantRows = messages.filter((row) => row.role === "assistant" && textOf(row).trim())
  const userRows = messages.filter((row) => row.role === "user" && textOf(row).trim())
  const syntheticUserRows = userRows.filter((row) => isSyntheticUserTranscript(row))
  const duplicateAssistantGroups = groupDuplicateAssistantRows(assistantRows)
  const badAssistantAsUserRows = userRows.filter((row) => looksLikeAssistantReply(textOf(row)))
  const restartRows = assistantRows.filter((row, idx) => idx > 0 && looksLikeRestart(textOf(row)))
  const longRows = assistantRows.filter((row) => textOf(row).length > 420)
  const completedTraceCount = traces.filter((row) => traceStatus(row) === "completed").length
  const latestTrace = traces.at(-1) ?? null

  return [
    check("has_recent_inbound", inboundEvents.length > 0, "No inbound event was found after --since."),
    check("has_assistant_or_reaction_trace", assistantRows.length > 0 || traces.some((row) => row.reactionSent === true || traceAction(row) === "tapback_only"), "No assistant text or tapback trace found after --since."),
    check("no_synthetic_user_prompt_in_messages", syntheticUserRows.length === 0, `Synthetic SDK user inputs persisted as transcript rows: ${syntheticUserRows.map((row) => row.id).join(", ")}`),
    check("no_assistant_reply_stored_as_user", badAssistantAsUserRows.length === 0, `Likely assistant replies stored as role=user: ${badAssistantAsUserRows.map((row) => row.id).join(", ")}`),
    check("no_duplicate_assistant_transcript_rows", duplicateAssistantGroups.length === 0, `Duplicate assistant rows with same body: ${duplicateAssistantGroups.map((group) => group.map((row) => row.id).join("+")).join(", ")}`),
    check("no_late_conversation_restart", restartRows.length === 0, `Assistant restarted/reintroduced after prior context: ${restartRows.map((row) => row.id).join(", ")}`),
    check("assistant_text_short_enough_for_sms", longRows.length === 0, `Assistant SMS too long: ${longRows.map((row) => `${row.id}:${textOf(row).length}`).join(", ")}`),
    check("trace_reaches_completed", completedTraceCount > 0 || latestTrace == null, `No completed trace found; latest status=${traceStatus(latestTrace) ?? "none"}.`),
    check("evidence_is_linked_when_written", evidenceWrites.every((row) => row.eventId || row.sourceTurnId || row.turnId), "At least one evidence row lacks event/turn linkage."),
  ]
}

async function runConversationJudges({ messages, userId, sinceIso }) {
  const latestAssistantIndex = findLatestAssistantIndex(messages)
  if (latestAssistantIndex < 0) return []
  const latestAssistant = messages[latestAssistantIndex]
  const reply = textOf(latestAssistant)
  const transcript = messages
    .slice(Math.max(0, latestAssistantIndex - 8), latestAssistantIndex)
    .filter((row) => row.role === "user" || row.role === "assistant")
    .map((row) => ({ role: row.role, content: textOf(row) }))
  const criteria = [
    {
      id: "continuity",
      criterion: [
        "Grade whether the assistant reply clearly continues the existing conversation.",
        "It must not restart onboarding, reintroduce Claire, repeat resume-intake language, or ignore the immediately previous user message.",
      ].join(" "),
    },
    {
      id: "context_use",
      criterion: [
        "Grade whether the assistant uses concrete context from the recent transcript when available.",
        "If the user volunteered preferences, role direction, location, prescreen answers, or asked a question, the reply should reflect that context before moving forward.",
      ].join(" "),
    },
    {
      id: "human_feel",
      criterion: [
        "Grade whether the reply feels like a concise human recruiter over SMS.",
        "It should be short, natural, one idea per bubble, not corporate, not templated, and not overly verbose.",
      ].join(" "),
    },
    {
      id: "answer_first",
      criterion: [
        "If the latest user message before the reply asks a direct question, grade whether the assistant answers that question first.",
        "If no direct question was asked, pass when the reply acknowledges or continues naturally without pretending a question was asked.",
      ].join(" "),
    },
  ]
  const results = []
  for (const item of criteria) {
    const verdict = await runJudge({
      criterion: item.criterion,
      threshold: 0.72,
      reply,
      transcript,
      metadata: {
        harness: "conversation_experience",
        criterionId: item.id,
        userId,
        since: sinceIso,
        assistantMessageId: latestAssistant.id,
      },
      skipFillerAutofail: true,
      skipImessageAutofail: false,
    })
    results.push({
      id: item.id,
      verdict: verdict.verdict,
      confidence: verdict.confidence,
      rationale: verdict.rationale,
      costUsd: verdict.costUsd,
      retryCount: verdict.retryCount,
      assistantMessageId: latestAssistant.id,
    })
  }
  return results
}

function findLatestAssistantIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant" && textOf(messages[i]).trim()) return i
  }
  return -1
}

function isSyntheticUserTranscript(row) {
  const body = textOf(row).trim()
  const meta = row.rawMeta && typeof row.rawMeta === "object" ? row.rawMeta : {}
  if (meta.source === "agents_sdk_session" && row.role === "user") return true
  return /^\[(ONBOARDING CONTINUATION|SYSTEM|TOOL|ROUTER)\]/i.test(body) ||
    /Do not extract tags; only compose the SMS/i.test(body) ||
    /Continue from the existing SMS thread\. Do not restart/i.test(body)
}

function looksLikeAssistantReply(body) {
  return /^(got it|makes sense|thanks, that helps|i found|one role worth|before i move|given you care|for this next phase|i'?m checking)/i.test(body.trim())
}

function looksLikeRestart(body) {
  return /\b(i[’']m Claire|welcome to|saw your resume come through|your resume came through|when I find a strong fit|for this next phase)\b/i.test(body)
}

function groupDuplicateAssistantRows(rows) {
  const byBody = new Map()
  for (const row of rows) {
    const body = textOf(row).replace(/\s+/g, " ").trim()
    if (!body) continue
    const bucket = byBody.get(body) ?? []
    bucket.push(row)
    byBody.set(body, bucket)
  }
  return [...byBody.values()].filter((group) => {
    if (group.length < 2) return false
    group.sort((a, b) => rowMs(a, "createdAt") - rowMs(b, "createdAt"))
    for (let i = 1; i < group.length; i++) {
      if (Math.abs(rowMs(group[i], "createdAt") - rowMs(group[i - 1], "createdAt")) <= 10_000) return true
    }
    return false
  })
}

function check(name, pass, detail) {
  return { name, pass: Boolean(pass), ...(pass ? {} : { detail }) }
}

async function loadRecentRows(db, collectionName, userId, orderField, limit, sinceMs) {
  let snap
  try {
    snap = await db.collection(collectionName).where("userId", "==", userId).orderBy(orderField, "desc").limit(limit).get()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!message.includes("requires an index")) throw err
    snap = await db.collection(collectionName).where("userId", "==", userId).limit(limit).get()
  }
  return snap.docs
    .map((doc) => ({ id: doc.id, ...stripFirestore(doc.data() ?? {}) }))
    .filter((row) => {
      const ms = rowMs(row, orderField) || rowMs(row, "createdAt") || rowMs(row, "updatedAt") || rowMs(row, "completedAt")
      return ms >= sinceMs
    })
}

async function loadUserById(db, userId) {
  const snap = await db.collection(PA_USERS).doc(userId).get()
  return snap.exists ? { id: snap.id, data: stripFirestore(snap.data() ?? {}) } : null
}

async function loadUserByPhone(db, phone) {
  const snap = await db.collection(PA_USERS).where("phoneE164", "==", phone).limit(1).get()
  if (snap.empty) return null
  return { id: snap.docs[0].id, data: stripFirestore(snap.docs[0].data() ?? {}) }
}

function getDb() {
  if (!getApps().length) {
    const jsonEnv = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    const path = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || process.env.GOOGLE_APPLICATION_CREDENTIALS
    if (jsonEnv && jsonEnv.trim()) {
      const serviceAccount = JSON.parse(jsonEnv)
      initializeApp({ credential: cert(serviceAccount), projectId: serviceAccount.project_id })
    } else if (path) {
      const serviceAccount = JSON.parse(readFileSync(path, "utf8"))
      initializeApp({ credential: cert(serviceAccount), projectId: serviceAccount.project_id })
    } else {
      initializeApp({ credential: applicationDefault(), projectId: process.env.GOOGLE_CLOUD_PROJECT || "wekruit-5f89b" })
    }
  }
  return getFirestore()
}

function loadDotEnv(path) {
  try {
    const text = readFileSync(path, "utf8")
    for (const raw of text.split("\n")) {
      const line = raw.trim()
      if (!line || line.startsWith("#")) continue
      const eq = line.indexOf("=")
      if (eq < 0) continue
      const key = line.slice(0, eq).trim()
      let value = line.slice(eq + 1).trim().replace(/\r$/, "")
      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      if (process.env[key] === undefined) process.env[key] = value
    }
  } catch {
    /* optional */
  }
}

function stripFirestore(value) {
  if (value == null) return value
  if (typeof value?.toDate === "function") return value.toDate().toISOString()
  if (Array.isArray(value)) return value.map(stripFirestore)
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, stripFirestore(item)]))
  }
  return value
}

function summarizeInbound(row) {
  if (!row) return null
  return {
    id: row.id,
    status: row.status ?? null,
    createdAt: row.createdAt ?? null,
    body: textOf(row).slice(0, 300),
    from: row.from ?? null,
    externalChatId: row.externalChatId ?? null,
  }
}

function summarizeTrace(row) {
  if (!row) return null
  return {
    id: row.id,
    eventId: row.eventId ?? null,
    status: traceStatus(row),
    owner: traceOwner(row),
    action: traceAction(row),
    noOutboundReason: row.noOutboundReason ?? row.conversationNoOutboundReason ?? null,
    evidenceCommitIds: row.evidenceCommitIds ?? [],
    reactionSent: row.reactionSent ?? null,
    reactionSkippedReason: row.reactionSkippedReason ?? null,
    updatedAt: row.updatedAt ?? null,
  }
}

function summarizeEvidence(row) {
  return {
    id: row.id,
    kind: row.kind ?? null,
    action: row.action ?? null,
    targetPath: row.targetPath ?? null,
    evidenceSpan: String(row.evidenceSpan ?? "").slice(0, 240),
    createdAt: row.createdAt ?? null,
  }
}

function summarizeToolCall(row) {
  return {
    id: row.id,
    connectorName: row.connectorName ?? row.name ?? null,
    status: row.status ?? null,
    createdAt: row.createdAt ?? null,
  }
}

function summarizeMessage(row) {
  if (!row) return null
  return {
    id: row.id,
    role: row.role ?? null,
    createdAt: row.createdAt ?? null,
    idempotencyKey: row.idempotencyKey ?? null,
    source: row.rawMeta?.source ?? null,
    body: textOf(row).slice(0, 500),
  }
}

function traceAction(trace) {
  return trace?.actionDecision?.selectedAction ?? trace?.conversationAction ?? null
}

function traceOwner(trace) {
  return trace?.decision?.selectedOwner ?? trace?.conversationArbiterOwner ?? null
}

function traceStatus(trace) {
  return trace?.status ?? null
}

function textOf(row) {
  return String(row?.body ?? row?.text ?? row?.message ?? "")
}

function rowMs(row, field) {
  const value = row?.[field]
  if (typeof value === "number") return value
  if (typeof value === "string") {
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? ms : 0
  }
  return 0
}

function normalizeE164(value) {
  const digits = value.replace(/[^\d+]/g, "")
  if (digits.startsWith("+")) return digits
  if (digits.length === 10) return `+1${digits}`
  return `+${digits}`
}

function normalizeSince(value) {
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) throw new Error(`Invalid --since timestamp: ${value}`)
  return new Date(ms).toISOString()
}

function parseArgs(argv) {
  const out = { expectEvidenceKind: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--user-id") out.userId = argv[++i]
    else if (arg === "--phone") out.phone = argv[++i]
    else if (arg === "--since") out.since = argv[++i]
    else if (arg === "--llm") out.llm = true
    else if (arg === "--no-llm") out.llm = false
    else if (arg === "-h" || arg === "--help") usage()
    else usage(`Unknown arg: ${arg}`)
  }
  return out
}

function usage(message) {
  if (message) console.error(message)
  console.error("Usage: node scripts/eval-conversation-experience.mjs --phone +14243201960 --since <ISO> [--llm]")
  process.exit(message ? 1 : 0)
}
