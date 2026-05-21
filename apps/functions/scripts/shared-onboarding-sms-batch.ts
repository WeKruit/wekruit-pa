/**
 * Production Firestore shared-onboarding SMS/iMessage batch harness.
 *
 * Drives the real onPaInbound production trigger by writing worker-shaped
 * `pa-inbound-events` documents. Outbound sends are suppressed through the
 * existing orchestrator harness flag, but assistant replies are still written
 * to `pa-messages` for transcript inspection.
 *
 * This intentionally reuses an existing allowlisted pa-users row. It does not
 * create production users or send through the local Messages app.
 *
 * Run:
 *   IMESSAGE_PEERS=+14243201960 \
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json \
 *   SHARED_ONBOARDING_BATCH_COUNT=5 \
 *   SHARED_ONBOARDING_BATCH_COMPLETE_COUNT=2 \
 *   node --import tsx apps/functions/scripts/shared-onboarding-sms-batch.ts
 */
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { config as loadDotenv } from "dotenv"
import { applicationDefault, getApps, initializeApp } from "firebase-admin/app"
import { getFirestore, type Firestore } from "firebase-admin/firestore"

import { acquireProductionTestRunLock, productionTestRunLockId } from "./lib/prod-test-run-lock.mjs"
import { requireExistingPaUserWithAllowedPhoneForProductionTest } from "./lib/prod-test-user-guard.mjs"

for (const envPath of [
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "apps/functions/.env"),
  path.resolve(process.cwd(), "../..", ".env"),
  path.resolve(process.cwd(), "../..", "apps/functions/.env"),
]) {
  if (existsSync(envPath)) loadDotenv({ path: envPath, override: false })
}

const PROJECT_ID = "wekruit-5f89b"
const SCRIPT_NAME = "shared-onboarding-sms-batch.ts"
const USER_ID = process.env.SHARED_ONBOARDING_BATCH_USER_ID ?? "UThMpnAGzjaWnxDsKEMH"
const PHONE = process.env.SHARED_ONBOARDING_BATCH_PHONE ?? "+14243201960"
const COUNT = positiveInt(process.env.SHARED_ONBOARDING_BATCH_COUNT, 5)
const COMPLETE_COUNT = Math.min(nonNegativeInt(process.env.SHARED_ONBOARDING_BATCH_COMPLETE_COUNT, 2), COUNT)
const TURN_TIMEOUT_MS = positiveInt(process.env.SHARED_ONBOARDING_BATCH_TURN_TIMEOUT_MS, 120_000)
const TURN_DELAY_MS = nonNegativeInt(process.env.SHARED_ONBOARDING_BATCH_TURN_DELAY_MS, 0)
const CONVERSATION_DELAY_MS = nonNegativeInt(process.env.SHARED_ONBOARDING_BATCH_CONVERSATION_DELAY_MS, 0)
const RESTORE_MODE = process.env.SHARED_ONBOARDING_BATCH_RESTORE_MODE === "clean" ? "clean" : "before"
const ARTIFACT_DIR = path.resolve(".planning/shared-onboarding-sms-batch/artifacts")

type PaUserDoc = FirebaseFirestore.DocumentData

type AssistantMessage = {
  id: string
  body: string
  createdAt?: unknown
  rawMeta?: unknown
}

type TurnResult = {
  label: string
  eventId: string
  userText: string
  assistantReplies: string[]
  turnDoc?: Record<string, unknown> | null
  inboundStatus: string
  state?: StateSnapshot
  failures: string[]
}

type StateSnapshot = {
  onboardingState?: unknown
  onboardingStatus?: unknown
  workSessionKind?: unknown
  workSessionStatus?: unknown
  currentQuestionId?: unknown
  sharedStatus?: unknown
  completed?: unknown
  answerKeys: string[]
  promptContext?: unknown
  statedPreferences?: unknown
  tagKeys: string[]
}

type ScenarioPlan = {
  id: string
  complete: boolean
  q1: string
  q2: string
  q3: string
  q4: string
  q5: string
  q2Junk: string
  normalChat: string
}

type ConversationResult = {
  id: string
  complete: boolean
  passed: boolean
  turns: TurnResult[]
  failures: string[]
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function nonNegativeInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
}

function nowIso(): string {
  return new Date().toISOString()
}

function nowStamp(): string {
  return nowIso().replace(/[:.]/g, "-")
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getDb(): Firestore {
  if (!getApps().length) {
    initializeApp({
      credential: applicationDefault(),
      projectId: PROJECT_ID,
    })
  }
  return getFirestore()
}

async function pollUntil<T>(
  probe: () => Promise<T | false | null | undefined>,
  opts: { timeoutMs: number; intervalMs?: number; label: string },
): Promise<T> {
  const start = Date.now()
  const intervalMs = opts.intervalMs ?? 500
  while (Date.now() - start < opts.timeoutMs) {
    const result = await probe()
    if (result) return result
    await sleep(intervalMs)
  }
  throw new Error(`Timeout after ${opts.timeoutMs}ms waiting for ${opts.label}`)
}

function safeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function stateSnapshot(user: PaUserDoc | null): StateSnapshot {
  const shared = user?.sharedOnboarding && typeof user.sharedOnboarding === "object"
    ? user.sharedOnboarding as Record<string, unknown>
    : {}
  const workSession = user?.workSession && typeof user.workSession === "object"
    ? user.workSession as Record<string, unknown>
    : {}
  const answers = shared.answers && typeof shared.answers === "object"
    ? shared.answers as Record<string, unknown>
    : {}
  const tags = user?.tags && typeof user.tags === "object"
    ? user.tags as Record<string, unknown>
    : {}
  return {
    onboardingState: user?.onboardingState,
    onboardingStatus: user?.onboardingStatus,
    workSessionKind: workSession.kind,
    workSessionStatus: workSession.status,
    currentQuestionId: shared.currentQuestionId ?? workSession.currentQuestionId,
    sharedStatus: shared.status,
    completed: shared.completed,
    answerKeys: Object.keys(answers).sort(),
    promptContext: shared.promptContext,
    statedPreferences: user?.statedPreferences,
    tagKeys: Object.keys(tags).sort(),
  }
}

async function readUser(db: Firestore): Promise<PaUserDoc> {
  const snap = await db.collection("pa-users").doc(USER_ID).get()
  if (!snap.exists) throw new Error(`pa-users/${USER_ID} disappeared during harness run`)
  return snap.data() ?? {}
}

function baselineForConversation(beforeUser: PaUserDoc, runId: string, scenarioId: string): PaUserDoc {
  const next = { ...beforeUser }
  delete next.sharedOnboarding
  delete next.workSession
  delete next.smsState
  delete next.pendingSmsKickoff
  delete next.layoffOnboardingSessionKind
  next.onboardingState = "pending"
  next.onboardingStatus = "invited"
  next.testMode = true
  next.updatedAt = nowIso()
  next.harnessLastSharedOnboardingBatch = {
    runId,
    scenarioId,
    scriptName: SCRIPT_NAME,
    resetAt: nowIso(),
  }
  return next
}

async function seedConversationUser(
  db: Firestore,
  beforeUser: PaUserDoc,
  runId: string,
  scenarioId: string,
): Promise<void> {
  await db.collection("pa-users").doc(USER_ID).set(
    baselineForConversation(beforeUser, runId, scenarioId),
    { merge: false },
  )
}

async function restoreUser(db: Firestore, beforeUser: PaUserDoc): Promise<void> {
  const restored = RESTORE_MODE === "clean"
    ? baselineForConversation(beforeUser, "post-run-cleanup", "clean-baseline")
    : beforeUser
  await db.collection("pa-users").doc(USER_ID).set(restored, { merge: false })
}

function brokerEvent(runId: string, scenarioId: string, turnLabel: string, text: string) {
  const id = `harness_shared_onboarding_${randomUUID()}`
  return {
    id,
    docData: {
      id,
      status: "pending",
      idempotencyKey: `shared-onboarding-batch:${runId}:${scenarioId}:${turnLabel}:${randomUUID()}`,
      createdAt: nowIso(),
      attemptCount: 0,
      maxAttempts: 1,
      channel: "imessage",
      rawPayload: {
        kind: "imessage",
        participant: PHONE,
        chatId: `iMessage;${PHONE}`,
        messageRowId: Date.now(),
        text,
        e2eTest: true,
        harness: {
          runner: SCRIPT_NAME,
          runId,
          scenarioId,
          turnLabel,
          suppressOutbound: true,
        },
      },
    },
  }
}

async function waitInboundCompleted(db: Firestore, eventId: string): Promise<Record<string, unknown>> {
  const ref = db.collection("pa-inbound-events").doc(eventId)
  return pollUntil(async () => {
    const snap = await ref.get()
    const data = snap.data()
    if (!data) return false
    const status = data.status
    if (status === "completed" || status === "succeeded") return data
    if (status === "failed" || status === "dead_letter") {
      throw new Error(`Inbound ${eventId} failed: ${safeText(data.lastError ?? data.error ?? data.deadLetterReason)}`)
    }
    return false
  }, { timeoutMs: TURN_TIMEOUT_MS, intervalMs: 750, label: `inbound ${eventId}` })
}

async function assistantMessagesForEvent(db: Firestore, eventId: string): Promise<AssistantMessage[]> {
  const snap = await db
    .collection("pa-messages")
    .where("rawMeta.eventId", "==", eventId)
    .limit(20)
    .get()
  const rows = snap.docs
    .map((doc) => ({ id: doc.id, ...(doc.data() as Record<string, unknown>) }))
    .filter((row) => row.role === "assistant" && typeof row.body === "string" && row.body.trim().length > 0)
    .map((row) => ({
      id: row.id as string,
      body: row.body as string,
      createdAt: row.createdAt,
      rawMeta: row.rawMeta,
    }))
  rows.sort((a, b) => {
    const left = typeof a.createdAt === "string" ? Date.parse(a.createdAt) : 0
    const right = typeof b.createdAt === "string" ? Date.parse(b.createdAt) : 0
    return left - right
  })
  return rows
}

async function turnDocForEvent(db: Firestore, eventId: string): Promise<Record<string, unknown> | null> {
  const snap = await db.collection("pa-turns").where("eventId", "==", eventId).limit(1).get()
  return snap.empty ? null : snap.docs[0].data()
}

async function assertNoOutbound(db: Firestore, eventId: string): Promise<string[]> {
  const snap = await db
    .collection("pa-outbound")
    .where("idempotencyKey", "==", `outbound-${eventId}`)
    .limit(1)
    .get()
  return snap.empty ? [] : [`pa-outbound was created for suppressed event ${eventId}`]
}

function textQaFailures(text: string): string[] {
  const failures: string[] = []
  if (/\bWeKruit_(?:LAID_OFF|Laid_Off|CANDIDATE_HI|rain-software)/.test(text)) {
    failures.push("assistant leaked internal source token")
  }
  if (/\bq_(?:role|yoe|visa|startup_pref|location)\b|main_goal|culture_stage|industry_interest|location_relocation|special_context/i.test(text)) {
    failures.push("assistant leaked internal question id")
  }
  if (/\b__PA_RESET__\b/.test(text)) failures.push("assistant leaked reset token")
  if (/^as an ai\b/i.test(text.trim())) failures.push("assistant used generic AI disclaimer voice")
  if (/\b(I am Claire\. How may I assist|How may I assist you today|leverage|synergy)\b/i.test(text)) {
    failures.push("assistant used robotic or corporate phrasing")
  }
  if (/\b(tech_swe|software_engineering|job_title)\b/i.test(text)) {
    failures.push("assistant leaked internal enum/token language")
  }
  if (/\b(timeline|dealbreaker|deal-breaker)\b/i.test(text)) {
    failures.push("assistant asked forbidden timeline/dealbreaker wording")
  }
  if (/^\s*(#{1,6}|[-*]\s+|\d+[.)]\s+)/m.test(text)) {
    failures.push("assistant used markdown/list/header formatting")
  }
  const questionMarks = text.match(/\?/g)?.length ?? 0
  if (questionMarks > 1) failures.push(`assistant asked more than one question (${questionMarks})`)
  if (text.length > 1400) failures.push("assistant reply is too long for conversational SMS")
  return failures
}

async function sendTurn(
  db: Firestore,
  runId: string,
  scenarioId: string,
  label: string,
  userText: string,
  opts: { expectAssistant: boolean; noReplyWindowMs?: number } = { expectAssistant: true },
): Promise<TurnResult> {
  const event = brokerEvent(runId, scenarioId, label, userText)
  await db.collection("pa-inbound-events").doc(event.id).set(event.docData)

  const inbound = await waitInboundCompleted(db, event.id)
  let messages = await assistantMessagesForEvent(db, event.id)
  if (!opts.expectAssistant) {
    await sleep(opts.noReplyWindowMs ?? 2500)
    messages = await assistantMessagesForEvent(db, event.id)
  } else {
    messages = await pollUntil(async () => {
      const found = await assistantMessagesForEvent(db, event.id)
      return found.length > 0 ? found : false
    }, {
      timeoutMs: TURN_TIMEOUT_MS,
      intervalMs: 750,
      label: `assistant reply for ${event.id}`,
    })
  }
  const turnDoc = await turnDocForEvent(db, event.id)
  const state = stateSnapshot(await readUser(db))
  const failures = [
    ...(opts.expectAssistant && messages.length === 0 ? ["expected assistant reply but none was recorded"] : []),
    ...(!opts.expectAssistant && messages.length > 0 ? ["expected no assistant reply, but one was recorded"] : []),
    ...(await assertNoOutbound(db, event.id)),
    ...messages.flatMap((msg) => textQaFailures(msg.body)),
  ]
  if (TURN_DELAY_MS > 0) await sleep(TURN_DELAY_MS)
  return {
    label,
    eventId: event.id,
    userText,
    assistantReplies: messages.map((msg) => msg.body),
    turnDoc,
    inboundStatus: safeText(inbound.status),
    state,
    failures,
  }
}

function expectState(turn: TurnResult, expectedQuestionId: string | null, failures: string[], label: string): void {
  const got = turn.state?.currentQuestionId ?? null
  if (got !== expectedQuestionId) {
    failures.push(`${label}: expected currentQuestionId=${expectedQuestionId}, got ${String(got)}`)
  }
}

function expectAnswerKeys(turn: TurnResult, expected: string[], failures: string[], label: string): void {
  const got = turn.state?.answerKeys ?? []
  const gotKey = got.join(",")
  const expectedKey = [...expected].sort().join(",")
  if (gotKey !== expectedKey) {
    failures.push(`${label}: expected answers [${expectedKey}], got [${gotKey}]`)
  }
}

function expectReplyIncludes(turn: TurnResult, patterns: RegExp[], failures: string[], label: string): void {
  const text = turn.assistantReplies.join("\n")
  for (const pattern of patterns) {
    if (!pattern.test(text)) failures.push(`${label}: reply did not match ${pattern}`)
  }
}

function expectTurnDirectIntent(
  turn: TurnResult,
  expectedResult: string,
  failures: string[],
  label: string,
): void {
  const result = turn.turnDoc?.directIntentResult
  if (result !== expectedResult) {
    failures.push(`${label}: expected directIntentResult=${expectedResult}, got ${String(result)}`)
  }
}

function expectPromptContextGrounded(turn: TurnResult, failures: string[]): void {
  const ctx = turn.state?.promptContext && typeof turn.state.promptContext === "object"
    ? turn.state.promptContext as Record<string, unknown>
    : {}
  const titles = Array.isArray(ctx.recentTitles) ? ctx.recentTitles.join(" ") : ""
  const companies = Array.isArray(ctx.recentCompanies) ? ctx.recentCompanies.join(" ") : ""
  if (!/Software Engineer Intern/i.test(titles)) {
    failures.push("bootstrap: promptContext missing Software Engineer Intern title")
  }
  if (!/Tesla Inc/i.test(companies)) {
    failures.push("bootstrap: promptContext missing Tesla Inc company")
  }
}

function scenarioPlan(index: number, complete: boolean): ScenarioPlan {
  const q1 = [
    "Backend or full-stack software engineering roles would be ideal.",
    "I am mostly looking for SWE roles, especially backend or infrastructure.",
    "Product engineering roles sound best, but I am open to full-stack work.",
    "Data engineering or backend software engineering would be strongest.",
    "I want a software engineering role with room to own product work too.",
  ]
  const q2 = [
    "A scale-up with high ownership and a calm, collaborative team works best.",
    "Early startup is fine if the team is kind and there is real mentorship.",
    "A larger company or mature scale-up with less chaos would be best.",
    "I prefer high ownership, open communication, and a mid-sized engineering team.",
    "I am open, but not a chaotic seed-stage team.",
  ]
  const q3 = [
    "Fintech and AI infrastructure are most interesting right now.",
    "Developer tools, SaaS, and backend infrastructure are interesting.",
    "AI, payments, and data infrastructure would be strongest.",
    "Open to software broadly, but security and cloud infra sound good.",
    "Healthcare tech and AI products are interesting, but I am flexible.",
  ]
  const q4 = [
    "NYC or remote would be ideal, and I am open to Seattle.",
    "Remote US is ideal, but hybrid in the Bay Area can work.",
    "New York onsite or hybrid is fine. I can relocate for the right role.",
    "Seattle or remote, no full relocation unless the role is very strong.",
    "Austin, NYC, or remote. I can relocate if timing works.",
  ]
  const q5 = [
    "$150k to $180k base would be ideal, but I can flex for a strong role.",
    "I am hoping for around $160k base or higher.",
    "$140k to $170k base is the range I would keep in mind.",
    "For total comp, I would like to be in the $170k to $220k range.",
    "I am flexible, but $150k+ base would feel right.",
  ]
  const q2Junk = ["hi", "Hello, WeKruit!", "what?", "lol", "okay"][index % 5]
  const normalChat = [
    "Can you remind me what kinds of roles you would prioritize for me?",
    "Based on what I told you, what should I focus on next?",
    "Can you summarize the role fit you see for me?",
    "What job direction would you recommend from this profile?",
    "Can you help me think through the strongest next role?",
  ]
  return {
    id: `shared-onboarding-${String(index + 1).padStart(3, "0")}`,
    complete,
    q1: q1[index % q1.length],
    q2: q2[index % q2.length],
    q3: q3[index % q3.length],
    q4: q4[index % q4.length],
    q5: q5[index % q5.length],
    q2Junk,
    normalChat: normalChat[index % normalChat.length],
  }
}

async function runConversation(
  db: Firestore,
  beforeUser: PaUserDoc,
  runId: string,
  plan: ScenarioPlan,
): Promise<ConversationResult> {
  const turns: TurnResult[] = []
  const failures: string[] = []
  await seedConversationUser(db, beforeUser, runId, plan.id)

  const bootstrap = await sendTurn(db, runId, plan.id, "bootstrap-hello", "Hello, WeKruit!")
  turns.push(bootstrap)
  expectState(bootstrap, "main_goal", failures, "bootstrap")
  expectReplyIncludes(
    bootstrap,
    [/candidate\.wekruit\.com\/me\/profile/i, /tell me here/i, /Software Engineer Intern|Tesla Inc/i, /hiring manager/i, /role|SWE|software engineering/i],
    failures,
    "bootstrap",
  )
  expectPromptContextGrounded(bootstrap, failures)

  const duplicate = await sendTurn(db, runId, plan.id, "duplicate-hello", "Hello, WeKruit!", {
    expectAssistant: false,
  })
  turns.push(duplicate)
  expectState(duplicate, "main_goal", failures, "duplicate")
  expectAnswerKeys(duplicate, [], failures, "duplicate")
  expectTurnDirectIntent(duplicate, "ignored_non_answer", failures, "duplicate")

  const q1 = await sendTurn(db, runId, plan.id, "answer-main-goal", plan.q1)
  turns.push(q1)
  expectState(q1, "culture_stage", failures, "q1")
  expectAnswerKeys(q1, ["main_goal"], failures, "q1")
  expectReplyIncludes(q1, [/company size|company.*vibe|early startup|scale-up|bigger company/i], failures, "q1")

  const q2Junk = await sendTurn(db, runId, plan.id, "junk-culture-stage", plan.q2Junk)
  turns.push(q2Junk)
  expectState(q2Junk, "culture_stage", failures, "q2 junk")
  expectAnswerKeys(q2Junk, ["main_goal"], failures, "q2 junk")
  expectTurnDirectIntent(q2Junk, "reasked_question", failures, "q2 junk")
  expectReplyIncludes(q2Junk, [/need this part|company culture|culture.*stage|company.*stage/i], failures, "q2 junk")

  const q2 = await sendTurn(db, runId, plan.id, "answer-culture-stage", plan.q2)
  turns.push(q2)
  expectState(q2, "industry_interest", failures, "q2")
  expectAnswerKeys(q2, ["culture_stage", "main_goal"], failures, "q2")
  expectReplyIncludes(q2, [/industries or domains/i], failures, "q2")

  if (!plan.complete) {
    return {
      id: plan.id,
      complete: false,
      passed: failures.length === 0 && turns.every((turn) => turn.failures.length === 0),
      turns,
      failures: [...failures, ...turns.flatMap((turn) => turn.failures.map((failure) => `${turn.label}: ${failure}`))],
    }
  }

  const q3 = await sendTurn(db, runId, plan.id, "answer-industry-interest", plan.q3)
  turns.push(q3)
  expectState(q3, "location_relocation", failures, "q3")
  expectReplyIncludes(q3, [/where do you want to work|remote|hybrid|in-office|cities/i], failures, "q3")

  const q4 = await sendTurn(db, runId, plan.id, "answer-location-relocation", plan.q4)
  turns.push(q4)
  expectState(q4, "special_context", failures, "q4")
  expectReplyIncludes(q4, [/salary|comp|range/i], failures, "q4")

  const q5 = await sendTurn(db, runId, plan.id, "answer-special-context", plan.q5)
  turns.push(q5)
  expectState(q5, null, failures, "q5")
  expectTurnDirectIntent(q5, "sent_recs", failures, "q5")
  const recCount = Number(q5.turnDoc?.directIntentRecCount ?? 0)
  if (recCount < 2) failures.push(`q5: expected at least 2 job recs, got ${recCount}`)
  expectReplyIncludes(q5, [/role|job|fit|recommend/i], failures, "q5")

  const normal = await sendTurn(db, runId, plan.id, "normal-chat-after-onboarding", plan.normalChat)
  turns.push(normal)
  if (normal.assistantReplies.join("\n").trim().length < 20) {
    failures.push("normal chat: assistant reply was too short or empty")
  }

  return {
    id: plan.id,
    complete: true,
    passed: failures.length === 0 && turns.every((turn) => turn.failures.length === 0),
    turns,
    failures: [...failures, ...turns.flatMap((turn) => turn.failures.map((failure) => `${turn.label}: ${failure}`))],
  }
}

async function main(): Promise<void> {
  const db = getDb()
  const runId = `shared-onboarding-sms-batch-${nowStamp()}`
  const lockId = productionTestRunLockId({
    scope: "shared-onboarding-sms-batch",
    userId: USER_ID,
  })
  const releaseLock = await acquireProductionTestRunLock(db, {
    lockId,
    runId,
    scriptName: SCRIPT_NAME,
    projectId: PROJECT_ID,
    ttlMs: Math.max(15 * 60 * 1000, COUNT * 90_000),
  })
  const guard = await requireExistingPaUserWithAllowedPhoneForProductionTest(db, {
    projectId: PROJECT_ID,
    scriptName: SCRIPT_NAME,
    userId: USER_ID,
    phoneE164: PHONE,
  })
  const beforeUser = guard.data
  const conversations: ConversationResult[] = []
  let restored = false

  try {
    for (let i = 0; i < COUNT; i += 1) {
      const plan = scenarioPlan(i, i < COMPLETE_COUNT)
      const result = await runConversation(db, beforeUser, runId, plan)
      conversations.push(result)
      const status = result.passed ? "pass" : "FAIL"
      console.log(`[${status}] ${plan.id} complete=${plan.complete} turns=${result.turns.length}`)
      for (const failure of result.failures) console.log(`  - ${failure}`)
      if (CONVERSATION_DELAY_MS > 0 && i < COUNT - 1) await sleep(CONVERSATION_DELAY_MS)
    }
  } finally {
    await restoreUser(db, beforeUser)
    restored = true
    await releaseLock()
  }

  const passed = conversations.every((conversation) => conversation.passed)
  const artifact = {
    runId,
    scriptName: SCRIPT_NAME,
    projectId: PROJECT_ID,
    userId: USER_ID,
    phone: PHONE,
    count: COUNT,
    completeCount: COMPLETE_COUNT,
    turnDelayMs: TURN_DELAY_MS,
    conversationDelayMs: CONVERSATION_DELAY_MS,
    restoreMode: RESTORE_MODE,
    passed,
    userRestored: restored,
    startedAt: runId.replace("shared-onboarding-sms-batch-", ""),
    completedAt: nowIso(),
    conversations,
    summary: {
      passedConversations: conversations.filter((conversation) => conversation.passed).length,
      failedConversations: conversations.filter((conversation) => !conversation.passed).length,
      totalTurns: conversations.reduce((sum, conversation) => sum + conversation.turns.length, 0),
      totalAssistantReplies: conversations.reduce(
        (sum, conversation) => sum + conversation.turns.reduce((inner, turn) => inner + turn.assistantReplies.length, 0),
        0,
      ),
      failures: conversations.flatMap((conversation) =>
        conversation.failures.map((failure) => `${conversation.id}: ${failure}`),
      ),
    },
  }

  mkdirSync(ARTIFACT_DIR, { recursive: true })
  const artifactPath = path.join(ARTIFACT_DIR, `${runId}.json`)
  writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`)
  console.log(JSON.stringify({
    runId,
    artifactPath,
    passed,
    userRestored: restored,
    restoreMode: RESTORE_MODE,
    count: COUNT,
    completeCount: COMPLETE_COUNT,
    turnDelayMs: TURN_DELAY_MS,
    conversationDelayMs: CONVERSATION_DELAY_MS,
    failed: artifact.summary.failures,
  }, null, 2))

  if (!passed) process.exitCode = 1
}

main().catch((err) => {
  console.error(`[${SCRIPT_NAME}] fatal`, err)
  process.exitCode = 1
})
