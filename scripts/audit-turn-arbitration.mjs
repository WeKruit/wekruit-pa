#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

const PA_USERS = "pa-users"
const PA_MESSAGES = "pa-messages"
const PA_OUTBOUND = "pa-outbound"
const PRESCREEN_MEMORY = "pa-prescreen-memory-events"

const args = parseArgs(process.argv.slice(2))
const {
  buildConversationEvidenceWrites,
  decideConversationDeliveryAction,
  decideConversationTurnOwner,
  summarizeConversationTurnTrace,
} = await loadArbiter()

if (args.fixtures) {
  await runFixtureAudit(resolve(String(args.fixtures)))
} else {
  if (!args.phone && !args.userId) {
    usage("Provide --phone <e164> or --user-id <uid>, or run --fixtures tests/scenarios/conversation-arbitration")
  }
  await runFirestoreDryRun()
}

async function runFirestoreDryRun() {
  loadDotEnv(".env")
  const db = getDb()
  const user = args.userId
    ? await loadUserById(db, String(args.userId))
    : await loadUserByPhone(db, normalizeE164(String(args.phone)))
  if (!user) throw new Error("No pa-users row found for requested user.")

  const inboundMessage = typeof args.text === "string" && args.text.trim()
    ? { body: args.text.trim(), createdAt: new Date().toISOString() }
    : await loadLatestUserMessage(db, user.id)
  const inboundText = inboundMessage?.body
  if (!inboundText) {
    throw new Error("No inbound text found. Pass --text to replay a specific turn.")
  }

  const context = await buildContextFromFirestore(db, user.id, user.data, inboundMessage)
  const decision = decideConversationTurnOwner(context)
  const action = decideConversationDeliveryAction(context, decision)
  const evidenceWrites = buildConversationEvidenceWrites(context, decision, action)
  const trace = summarizeConversationTurnTrace(context, decision, action, evidenceWrites)
  const currentQuestionId = context.sharedOnboarding?.currentQuestionId
  const currentAnswer = currentQuestionId
    ? user.data.sharedOnboarding?.answers?.[currentQuestionId]?.answer
    : null
  const wouldFlagExistingForbiddenMutation =
    typeof currentAnswer === "string" &&
    currentAnswer.trim() === inboundText.trim() &&
    decision.forbiddenMutations.includes(`sharedOnboarding.answers.${currentQuestionId}`)

  console.log(JSON.stringify({
    mode: args.dryRun === false ? "read_only" : "dry_run",
    userId: user.id,
    inboundText,
    selectedOwner: decision.selectedOwner,
    selectedAction: action.selectedAction,
    rejectedOwners: decision.rejectedOwners,
    rejectedActions: action.rejectedActions,
    requiredTools: decision.requiredTools,
    forbiddenMutations: decision.forbiddenMutations,
    noOutboundReason: action.noOutboundReason ?? null,
    toolCallIds: action.toolCallIds,
    evidenceWrites,
    orderedActions: decision.orderedActions,
    traceStates: trace.states,
    wouldFlagExistingForbiddenMutation,
    note: "This script is read-only; it does not replay or mutate Firestore.",
  }, null, 2))
}

async function runFixtureAudit(dir) {
  const files = (await readdir(dir)).filter((file) => file.endsWith(".json")).sort()
  const results = []
  for (const file of files) {
    const fixture = JSON.parse(await readFile(join(dir, file), "utf8"))
    const context = buildContextFromFixture(fixture)
    const decision = decideConversationTurnOwner(context)
    const action = decideConversationDeliveryAction(context, decision)
    const evidenceWrites = buildConversationEvidenceWrites(context, decision, action)
    const missingTools = (fixture.expected.requiredTools ?? []).filter((tool) => !decision.requiredTools.includes(tool))
    const missingForbidden = (fixture.expected.forbiddenMutations ?? []).filter((mutation) => !decision.forbiddenMutations.includes(mutation))
    const missingEvidenceWrites = (fixture.expected.evidenceWriteKinds ?? []).filter(
      (kind) => !evidenceWrites.some((write) => write.kind === kind),
    )
    const ordered = decision.orderedActions.map((action) => action.kind)
    const orderedOk = fixture.expected.orderedActionKinds
      ? JSON.stringify(ordered) === JSON.stringify(fixture.expected.orderedActionKinds)
      : true
    const actionOk = fixture.expected.action ? action.selectedAction === fixture.expected.action : true
    const pass =
      decision.selectedOwner === fixture.expected.owner &&
      actionOk &&
      missingTools.length === 0 &&
      missingForbidden.length === 0 &&
      missingEvidenceWrites.length === 0 &&
      orderedOk
    results.push({
      id: fixture.id,
      pass,
      expectedOwner: fixture.expected.owner,
      actualOwner: decision.selectedOwner,
      expectedAction: fixture.expected.action ?? null,
      actualAction: action.selectedAction,
      missingTools,
      missingForbidden,
      missingEvidenceWrites,
      noOutboundReason: action.noOutboundReason ?? null,
      orderedActions: ordered,
    })
  }
  console.log(JSON.stringify({
    fixtureDir: dir,
    passed: results.filter((result) => result.pass).length,
    failed: results.filter((result) => !result.pass).length,
    results,
  }, null, 2))
  if (results.some((result) => !result.pass)) process.exitCode = 1
}

async function buildContextFromFirestore(db, userId, user, inboundMessage) {
  const inboundText = inboundMessage.body
  const workSession = readObject(user.workSession)
  const shared = readObject(user.sharedOnboarding)
  const sharedActive = shared?.status === "active" && shared.completed !== true
  const sharedQuestionId = typeof shared?.currentQuestionId === "string"
    ? shared.currentQuestionId
    : typeof workSession?.currentQuestionId === "string"
      ? workSession.currentQuestionId
      : null
  const activeWorkflow = workSession?.kind === "job_prescreen" && workSession.status === "active"
    ? {
        kind: "job_prescreen",
        status: "active",
        currentQuestionId: typeof workSession.currentQuestionId === "string" ? workSession.currentQuestionId : null,
      }
    : sharedActive
      ? { kind: "shared_onboarding", status: "active", currentQuestionId: sharedQuestionId }
      : null
  const prescreenEvidence = await loadPrescreenEvidence(db, user, workSession)
  const recentMessages = mergeRecentMessages(
    await loadRecentConversationMessages(db, userId, inboundMessage.sessionId, inboundMessage.createdAt),
    await loadRecentOutboundMessages(db, userId, inboundMessage.createdAt),
  )
  const recentOutbound = recentMessages.filter((message) => message.role === "assistant")
  return {
    turnId: "dry-run",
    userId,
    inbound: {
      text: inboundText,
      createdAt: inboundMessage.createdAt ?? new Date().toISOString(),
      channel: "imessage",
    },
    activeWorkflow,
    recentMessages,
    recentOutbound,
    prescreenEvidence,
    sharedOnboarding: {
      active: Boolean(sharedActive),
      currentQuestionId: sharedQuestionId,
    },
    preferenceState: readObject(user.statedPreferences),
  }
}

async function loadPrescreenEvidence(db, user, workSession) {
  const lastMemory = readObject(user.lastPrescreenMemoryUpdate)
  const sessionId = typeof workSession?.sessionId === "string"
    ? workSession.sessionId
    : typeof lastMemory?.sessionId === "string"
      ? lastMemory.sessionId
      : null
  if (!sessionId) return null
  const snap = await db.collection(PRESCREEN_MEMORY).doc(sessionId).get()
  const memory = snap.exists ? snap.data() ?? {} : lastMemory ?? {}
  const evidenceTags = Array.isArray(memory.evidenceTags)
    ? memory.evidenceTags.filter((tag) => typeof tag === "string")
    : Array.isArray(lastMemory?.evidenceTags)
      ? lastMemory.evidenceTags.filter((tag) => typeof tag === "string")
      : []
  return {
    sessionId,
    ...(typeof workSession?.jobId === "string" ? { jobId: workSession.jobId } : typeof memory.jobId === "string" ? { jobId: memory.jobId } : {}),
    ...(typeof workSession?.terminal === "string" ? { terminal: workSession.terminal } : typeof memory.terminal === "string" ? { terminal: memory.terminal } : {}),
    ...(typeof memory.summary === "string" ? { summary: memory.summary } : {}),
    ...(evidenceTags.length ? { evidenceTags } : {}),
  }
}

function buildContextFromFixture(fixture) {
  const user = fixture.initialFirestoreState[`pa-users/${fixture.inbound.userId}`] ?? {}
  const workSession = readObject(user.workSession)
  const shared = readObject(user.sharedOnboarding)
  const sessionId = typeof workSession?.sessionId === "string" ? workSession.sessionId : null
  const memory = sessionId ? fixture.initialFirestoreState[`pa-prescreen-memory-events/${sessionId}`] : null
  const sharedActive = shared?.status === "active" && shared.completed !== true
  const sharedQuestionId = typeof shared?.currentQuestionId === "string"
    ? shared.currentQuestionId
    : typeof workSession?.currentQuestionId === "string"
      ? workSession.currentQuestionId
      : null
  return {
    turnId: fixture.id,
    userId: fixture.inbound.userId,
    inbound: {
      text: fixture.inbound.text,
      createdAt: fixture.inbound.createdAt,
      channel: fixture.inbound.channel,
    },
    activeWorkflow: workSession?.kind === "job_prescreen" && workSession.status === "active"
      ? { kind: "job_prescreen", status: "active", currentQuestionId: workSession.currentQuestionId ?? null }
      : null,
    recentMessages: [],
    recentOutbound: Array.isArray(fixture.recentOutbound) ? fixture.recentOutbound : [],
    prescreenEvidence: sessionId && memory
      ? {
          sessionId,
          ...(typeof memory.jobId === "string" ? { jobId: memory.jobId } : {}),
          ...(typeof memory.terminal === "string" ? { terminal: memory.terminal } : {}),
          ...(typeof memory.summary === "string" ? { summary: memory.summary } : {}),
          ...(Array.isArray(memory.evidenceTags) ? { evidenceTags: memory.evidenceTags.filter((tag) => typeof tag === "string") } : {}),
        }
      : null,
    sharedOnboarding: {
      active: Boolean(sharedActive),
      currentQuestionId: sharedQuestionId,
    },
    preferenceState: readObject(user.statedPreferences),
    toolResults: Array.isArray(fixture.toolResults) ? fixture.toolResults : undefined,
  }
}

async function loadUserById(db, userId) {
  const snap = await db.collection(PA_USERS).doc(userId).get()
  return snap.exists ? { id: snap.id, data: snap.data() ?? {} } : null
}

async function loadUserByPhone(db, phone) {
  const snap = await db.collection(PA_USERS).where("phoneE164", "==", phone).limit(1).get()
  if (snap.empty) return null
  return { id: snap.docs[0].id, data: snap.docs[0].data() ?? {} }
}

async function loadLatestUserMessage(db, userId) {
  let snap
  try {
    snap = await db
      .collection(PA_MESSAGES)
      .where("userId", "==", userId)
      .where("role", "==", "user")
      .orderBy("createdAt", "desc")
      .limit(1)
      .get()
  } catch (err) {
    if (!String(err instanceof Error ? err.message : err).includes("requires an index")) throw err
    snap = await db
      .collection(PA_MESSAGES)
      .where("userId", "==", userId)
      .limit(80)
      .get()
  }
  if (snap.empty) return null
  const latest = snap.docs
    .map((doc) => doc.data() ?? {})
    .filter((row) => row.role === "user" && typeof row.body === "string")
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))[0]
  const body = latest?.body
  if (typeof body !== "string") return null
  return {
    body,
    sessionId: typeof latest.sessionId === "string" ? latest.sessionId : undefined,
    createdAt: normalizeCreatedAt(latest.createdAt),
    messageId: typeof latest.id === "string" ? latest.id : undefined,
  }
}

async function loadRecentConversationMessages(db, userId, sessionId, beforeIso) {
  let snap
  try {
    const query = sessionId
      ? db.collection(PA_MESSAGES).where("sessionId", "==", sessionId).limit(200)
      : db.collection(PA_MESSAGES).where("userId", "==", userId).orderBy("createdAt", "desc").limit(80)
    snap = await query.get()
  } catch (err) {
    if (!String(err instanceof Error ? err.message : err).includes("requires an index")) throw err
    snap = await db
      .collection(PA_MESSAGES)
      .where("userId", "==", userId)
      .limit(80)
      .get()
  }
  return snap.docs
    .map((doc) => {
      const row = doc.data() ?? {}
      const body = typeof row.body === "string"
        ? row.body
        : typeof row.text === "string"
          ? row.text
          : ""
      const role = row.role === "assistant" || row.role === "user" || row.role === "system"
        ? row.role
        : undefined
      return {
        role,
        body,
        createdAt: normalizeCreatedAt(row.createdAt),
      }
    })
    .filter((message) => message.body.trim())
    .filter((message) => isBeforeReplayInbound(message.createdAt, beforeIso))
    .sort((a, b) => createdAtMillis(a.createdAt) - createdAtMillis(b.createdAt))
    .slice(-16)
}

async function loadRecentOutboundMessages(db, userId, beforeIso) {
  let snap
  try {
    snap = await db
      .collection(PA_OUTBOUND)
      .where("userId", "==", userId)
      .orderBy("createdAt", "desc")
      .limit(80)
      .get()
  } catch (err) {
    if (!String(err instanceof Error ? err.message : err).includes("requires an index")) throw err
    snap = await db
      .collection(PA_OUTBOUND)
      .where("userId", "==", userId)
      .limit(80)
      .get()
  }
  return snap.docs
    .map((doc) => {
      const row = doc.data() ?? {}
      const body = typeof row.body === "string"
        ? row.body
        : typeof row.text === "string"
          ? row.text
          : ""
      return {
        role: "assistant",
        body,
        createdAt: normalizeCreatedAt(row.createdAt),
      }
    })
    .filter((message) => message.body.trim())
    .filter((message) => isBeforeReplayInbound(message.createdAt, beforeIso))
    .sort((a, b) => createdAtMillis(a.createdAt) - createdAtMillis(b.createdAt))
    .slice(-16)
}

function getDb() {
  if (!getApps().length) {
    const jsonEnv = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    const path = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || process.env.GOOGLE_APPLICATION_CREDENTIALS
    if (jsonEnv && jsonEnv.trim()) {
      const sa = JSON.parse(jsonEnv)
      initializeApp({ credential: cert(sa), projectId: sa.project_id })
    } else if (path) {
      const sa = JSON.parse(readFileSync(path, "utf8"))
      initializeApp({ credential: cert(sa), projectId: sa.project_id })
    } else {
      initializeApp({ credential: applicationDefault(), projectId: process.env.GOOGLE_CLOUD_PROJECT || "wekruit-5f89b" })
    }
  }
  return getFirestore()
}

async function loadArbiter() {
  try {
    const turn = await import("../packages/pa-orchestrator/dist/conversation-turn-arbiter.js")
    const action = await import("../packages/pa-orchestrator/dist/conversation-action-arbiter.js")
    return { ...turn, ...action }
  } catch (err) {
    throw new Error(
      `Cannot load built arbiter. Run "npm run build --workspace=@pa/pa-orchestrator" first. ${err instanceof Error ? err.message : String(err)}`
    )
  }
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
  const out = { dryRun: true }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--dry-run") out.dryRun = true
    else if (arg === "--phone") out.phone = argv[++i]
    else if (arg === "--user-id") out.userId = argv[++i]
    else if (arg === "--text") out.text = argv[++i]
    else if (arg === "--fixtures") out.fixtures = argv[++i]
    else usage(`Unknown argument: ${arg}`)
  }
  return out
}

function normalizeE164(value) {
  const raw = String(value ?? "").trim()
  const digits = raw.replace(/\D/g, "")
  if (raw.startsWith("+")) return `+${digits}`
  return digits.length === 10 ? `+1${digits}` : `+${digits}`
}

function readObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null
}

function normalizeCreatedAt(value) {
  if (value && typeof value.toDate === "function") return value.toDate().toISOString()
  if (typeof value === "string") return value
  if (typeof value === "number") return new Date(value).toISOString()
  return undefined
}

function createdAtMillis(value) {
  if (!value) return 0
  const millis = Date.parse(value)
  return Number.isFinite(millis) ? millis : 0
}

function isBeforeReplayInbound(messageCreatedAt, inboundCreatedAt) {
  const inboundMillis = createdAtMillis(inboundCreatedAt)
  if (!inboundMillis) return true
  const messageMillis = createdAtMillis(messageCreatedAt)
  if (!messageMillis) return true
  return messageMillis <= inboundMillis
}

function mergeRecentMessages(...messageLists) {
  const seen = new Map()
  for (const message of messageLists.flat()) {
    const key = [
      message.role ?? "",
      message.createdAt ?? "",
      message.body.trim(),
    ].join("\u0000")
    if (!seen.has(key)) seen.set(key, message)
  }
  return [...seen.values()]
    .sort((a, b) => createdAtMillis(a.createdAt) - createdAtMillis(b.createdAt))
    .slice(-16)
}

function usage(message) {
  if (message) console.error(message)
  console.error("Usage: node scripts/audit-turn-arbitration.mjs --phone +15109136602 --dry-run")
  console.error("       node scripts/audit-turn-arbitration.mjs --fixtures tests/scenarios/conversation-arbitration")
  process.exit(2)
}
