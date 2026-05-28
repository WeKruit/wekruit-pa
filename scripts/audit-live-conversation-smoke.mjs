#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs"
import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

const PA_USERS = "pa-users"
const PA_MESSAGES = "pa-messages"
const PA_INBOUND_EVENTS = "pa-inbound-events"
const PA_TURN_TRACES = "pa-turn-traces"
const PA_CONVERSATION_EVIDENCE = "pa-conversation-evidence"

const args = parseArgs(process.argv.slice(2))

if (!args.userId && !args.phone) {
  usage("Provide --user-id <uid> or --phone <e164>.")
}

loadDotEnv(".env")
const db = getDb()
const user = args.userId
  ? await loadUserById(db, String(args.userId))
  : await loadUserByPhone(db, normalizeE164(String(args.phone)))
if (!user) throw new Error("No pa-users row found for requested user.")

const sinceIso = args.since ? normalizeSince(String(args.since)) : new Date(Date.now() - 15 * 60_000).toISOString()
const sinceMs = Date.parse(sinceIso)
const [messages, inboundEvents, traces, evidenceWrites] = await Promise.all([
  loadRecentRows(db, PA_MESSAGES, user.id, "createdAt", 80, sinceMs),
  loadRecentRows(db, PA_INBOUND_EVENTS, user.id, "createdAt", 80, sinceMs),
  loadRecentRows(db, PA_TURN_TRACES, user.id, "updatedAt", 80, sinceMs),
  loadRecentRows(db, PA_CONVERSATION_EVIDENCE, user.id, "createdAt", 80, sinceMs),
])

const latestTrace = traces
  .filter((row) => row.status === "completed" || row.actionDecision || row.conversationAction)
  .sort((a, b) => rowMs(b, "updatedAt") - rowMs(a, "updatedAt"))[0] ?? null
const latestInbound = inboundEvents.sort((a, b) => rowMs(b, "createdAt") - rowMs(a, "createdAt"))[0] ?? null
const assistantTextMessages = messages.filter((row) => row.role === "assistant" && textOf(row).trim())
const badAssistantRoleMessages = messages.filter((row) => {
  if (row.role !== "user") return false
  const body = textOf(row).trim()
  return /^(hey .*i found|ok so i found|got it[.!]?\s*i[’']m checking|thanks, that helps|makes sense)/i.test(body)
})

const checks = []
if (!args.allowEmpty) {
  checks.push(assertCheck("has_recent_inbound", Boolean(latestInbound), "No recent inbound event found after --since."))
  checks.push(assertCheck("has_recent_trace", Boolean(latestTrace), "No recent completed turn trace found after --since."))
}
if (args.expectAction) {
  checks.push(assertCheck(
    `action_${args.expectAction}`,
    traceAction(latestTrace) === args.expectAction,
    `Expected latest trace action ${args.expectAction}, got ${traceAction(latestTrace) ?? "none"}.`,
  ))
}
if (args.expectOwner) {
  checks.push(assertCheck(
    `owner_${args.expectOwner}`,
    traceOwner(latestTrace) === args.expectOwner,
    `Expected latest trace owner ${args.expectOwner}, got ${traceOwner(latestTrace) ?? "none"}.`,
  ))
}
for (const kind of args.expectEvidenceKind) {
  checks.push(assertCheck(
    `evidence_${kind}`,
    evidenceWrites.some((row) => row.kind === kind),
    `Expected evidence kind ${kind} after --since.`,
  ))
}
for (const mutation of args.requireForbiddenMutation) {
  checks.push(assertCheck(
    `forbidden_${mutation}`,
    traceForbiddenMutations(latestTrace).includes(mutation),
    `Expected latest trace to forbid ${mutation}.`,
  ))
}
if (args.expectNoAssistantText) {
  checks.push(assertCheck(
    "no_assistant_text",
    assistantTextMessages.length === 0,
    `Expected no assistant text messages after --since, found ${assistantTextMessages.length}.`,
  ))
}
if (args.expectNoBadAssistantRole) {
  checks.push(assertCheck(
    "no_bad_assistant_role",
    badAssistantRoleMessages.length === 0,
    `Found likely assistant outbound stored as role=user after --since: ${badAssistantRoleMessages.map((row) => row.id).join(", ")}.`,
  ))
}
for (const slot of args.expectSharedAnswerAbsent) {
  const answer = readPath(user.data, ["sharedOnboarding", "answers", slot])
  checks.push(assertCheck(
    `shared_answer_absent_${slot}`,
    answer == null,
    `Expected sharedOnboarding.answers.${slot} to remain absent, got ${JSON.stringify(answer)}.`,
  ))
}
if (args.expectReactionSent) {
  checks.push(assertCheck(
    "reaction_sent",
    latestTrace?.reactionSent === true,
    `Expected latest trace reactionSent=true, got ${String(latestTrace?.reactionSent)} (${latestTrace?.reactionSkippedReason ?? "no skip reason"}).`,
  ))
}

const failed = checks.filter((check) => !check.pass)
const output = {
  userId: user.id,
  since: sinceIso,
  counts: {
    messages: messages.length,
    inboundEvents: inboundEvents.length,
    traces: traces.length,
    evidenceWrites: evidenceWrites.length,
    assistantTextMessages: assistantTextMessages.length,
    badAssistantRoleMessages: badAssistantRoleMessages.length,
  },
  latestInbound: summarizeInbound(latestInbound),
  latestTrace: summarizeTrace(latestTrace),
  evidenceWrites: evidenceWrites.map(summarizeEvidence),
  assistantTextMessages: assistantTextMessages.map(summarizeMessage),
  badAssistantRoleMessages: badAssistantRoleMessages.map(summarizeMessage),
  checks,
  pass: failed.length === 0,
}

console.log(JSON.stringify(output, null, 2))
if (failed.length > 0) process.exitCode = 1

async function loadRecentRows(db, collectionName, userId, orderField, limit, sinceMs) {
  let snap
  try {
    snap = await db
      .collection(collectionName)
      .where("userId", "==", userId)
      .orderBy(orderField, "desc")
      .limit(limit)
      .get()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!message.includes("requires an index")) throw err
    snap = await db
      .collection(collectionName)
      .where("userId", "==", userId)
      .limit(limit)
      .get()
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

function stripFirestore(value) {
  if (value == null) return value
  if (typeof value?.toDate === "function") return value.toDate().toISOString()
  if (Array.isArray(value)) return value.map(stripFirestore)
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, stripFirestore(item)]))
  }
  return value
}

function traceAction(trace) {
  return trace?.actionDecision?.selectedAction ?? trace?.conversationAction ?? null
}

function traceOwner(trace) {
  return trace?.decision?.selectedOwner ?? trace?.conversationArbiterOwner ?? null
}

function traceForbiddenMutations(trace) {
  return Array.isArray(trace?.decision?.forbiddenMutations)
    ? trace.decision.forbiddenMutations
    : Array.isArray(trace?.conversationArbiterForbiddenMutations)
      ? trace.conversationArbiterForbiddenMutations
      : []
}

function summarizeInbound(row) {
  if (!row) return null
  return {
    id: row.id,
    status: row.status ?? null,
    createdAt: row.createdAt ?? null,
    body: textOf(row).slice(0, 240),
    from: row.from ?? null,
    externalChatId: row.externalChatId ?? null,
  }
}

function summarizeTrace(row) {
  if (!row) return null
  return {
    id: row.id,
    eventId: row.eventId ?? null,
    status: row.status ?? null,
    owner: traceOwner(row),
    action: traceAction(row),
    noOutboundReason: row.noOutboundReason ?? row.conversationNoOutboundReason ?? null,
    forbiddenMutations: traceForbiddenMutations(row),
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
    evidenceSpan: row.evidenceSpan ?? null,
    createdAt: row.createdAt ?? null,
  }
}

function summarizeMessage(row) {
  return {
    id: row.id,
    role: row.role ?? null,
    createdAt: row.createdAt ?? null,
    body: textOf(row).slice(0, 240),
  }
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

function readPath(value, path) {
  let current = value
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined
    current = current[key]
  }
  return current
}

function assertCheck(name, pass, message) {
  return { name, pass, ...(pass ? {} : { message }) }
}

function normalizeSince(value) {
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) throw new Error(`Invalid --since value: ${value}`)
  return new Date(ms).toISOString()
}

function normalizeE164(value) {
  const raw = String(value ?? "").trim()
  const digits = raw.replace(/\D/g, "")
  if (raw.startsWith("+")) return `+${digits}`
  return digits.length === 10 ? `+1${digits}` : `+${digits}`
}

function loadDotEnv(path) {
  if (!existsSync(path)) return
  const raw = readFileSync(path, "utf8")
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (!match) continue
    if (process.env[match[1]] == null) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "")
  }
}

function parseArgs(argv) {
  const out = {
    expectEvidenceKind: [],
    requireForbiddenMutation: [],
    expectSharedAnswerAbsent: [],
    allowEmpty: false,
    expectNoAssistantText: false,
    expectNoBadAssistantRole: false,
    expectReactionSent: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--user-id") out.userId = argv[++i]
    else if (arg === "--phone") out.phone = argv[++i]
    else if (arg === "--since") out.since = argv[++i]
    else if (arg === "--expect-action") out.expectAction = argv[++i]
    else if (arg === "--expect-owner") out.expectOwner = argv[++i]
    else if (arg === "--expect-evidence-kind") out.expectEvidenceKind.push(argv[++i])
    else if (arg === "--require-forbidden-mutation") out.requireForbiddenMutation.push(argv[++i])
    else if (arg === "--expect-shared-answer-absent") out.expectSharedAnswerAbsent.push(argv[++i])
    else if (arg === "--expect-no-assistant-text") out.expectNoAssistantText = true
    else if (arg === "--expect-no-bad-assistant-role") out.expectNoBadAssistantRole = true
    else if (arg === "--expect-reaction-sent") out.expectReactionSent = true
    else if (arg === "--allow-empty") out.allowEmpty = true
    else usage(`Unknown argument: ${arg}`)
  }
  return out
}

function usage(message) {
  if (message) console.error(message)
  console.error("Usage:")
  console.error("  node scripts/audit-live-conversation-smoke.mjs --user-id <uid> --since <iso> --expect-action tapback_only --expect-evidence-kind job_interest --expect-no-assistant-text")
  process.exit(2)
}
