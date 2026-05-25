#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { cert, getApps, initializeApp } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import {
  PA_COLLECTIONS,
  createCandidateJobStateId,
} from "@pa/core-types"
import {
  prescreenReviewPendingAckText,
  prescreenSessionToEvaluationAttempt,
} from "@pa/pa-orchestrator"
import {
  applyCandidateJobEvent,
  saveEvaluationAttempt,
} from "@pa/pa-persistence"
import {
  enqueueOutbound,
  outboundMessageDocId,
} from "@pa/pa-broker"
import {
  classifyPrescreenSessionUser,
  summarizeExcludedPrescreenRows,
} from "./lib/real-prescreen-session-filter.mjs"

const TERMINALS = new Set(["PASS", "FAIL", "HARD_STOP"])
const PROJECT_ID = "wekruit-5f89b"

function parseArgs(argv) {
  const args = {
    apply: false,
    limit: 500,
    userId: null,
    sessionId: null,
    json: false,
    includeNonReal: false,
    repairUncommitted: false,
    skipAck: false,
  }
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--apply") args.apply = true
    else if (arg === "--json") args.json = true
    else if (arg === "--include-non-real") args.includeNonReal = true
    else if (arg === "--repair-uncommitted") args.repairUncommitted = true
    else if (arg === "--skip-ack") args.skipAck = true
    else if (arg === "--limit") args.limit = Number(argv[++i] ?? args.limit)
    else if (arg.startsWith("--limit=")) args.limit = Number(arg.slice("--limit=".length))
    else if (arg === "--user") args.userId = argv[++i] ?? null
    else if (arg.startsWith("--user=")) args.userId = arg.slice("--user=".length)
    else if (arg === "--session") args.sessionId = argv[++i] ?? null
    else if (arg.startsWith("--session=")) args.sessionId = arg.slice("--session=".length)
    else throw new Error(`Unknown argument: ${arg}`)
  }
  if (!Number.isFinite(args.limit) || args.limit < 1) args.limit = 500
  args.limit = Math.min(Math.floor(args.limit), 5000)
  return args
}

function loadServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
  }
  const envPath = resolve(process.cwd(), ".env")
  if (existsSync(envPath)) {
    const envText = readFileSync(envPath, "utf8")
    const match = envText.match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.+)$/m)
    if (match) return JSON.parse(match[1])
  }
  throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON missing. Run from repo root or export it.")
}

function initDb() {
  if (!getApps().length) {
    const sa = loadServiceAccount()
    initializeApp({ credential: cert(sa), projectId: sa.project_id ?? PROJECT_ID })
  }
  return getFirestore()
}

function cleanString(value, max = 500) {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.slice(0, max)
}

function committedState(state) {
  return state === "passed" || state === "not_passed" || state === "employer_visible"
}

function stateAllowsStartedEvent(state) {
  return (
    !state ||
    state === "candidate_matched" ||
    state === "outbound_queued" ||
    state === "outbound_sent" ||
    state === "candidate_interested" ||
    state === "paused" ||
    state === "not_passed"
  )
}

function eventBase(session, eventType, nowIso) {
  return {
    eventId: `${eventType.replaceAll("_", "-")}-${session.sessionId}`,
    candidateId: session.userId,
    jobId: session.jobId,
    actor: "orchestrator",
    occurredAt: nowIso,
    evidence: [{ source: "prescreen", summary: "Prescreen review-pending backfill", refId: session.sessionId }],
    prescreenSessionId: session.sessionId,
  }
}

async function listSessions(db, args) {
  if (args.sessionId) {
    const snap = await db.collection("pa-prescreen-sessions").doc(args.sessionId).get()
    return snap.exists ? [{ id: snap.id, data: snap.data() ?? {} }] : []
  }
  let query = db.collection("pa-prescreen-sessions")
  if (args.userId) query = query.where("userId", "==", args.userId)
  const snap = await query.limit(args.limit).get()
  return snap.docs.map((doc) => ({ id: doc.id, data: doc.data() ?? {} }))
}

async function inspectSession(db, row, args) {
  const session = { ...row.data, sessionId: cleanString(row.data.sessionId, 300) ?? row.id }
  const terminal = cleanString(session.terminal, 40)
  const userId = cleanString(session.userId, 300)
  const jobId = cleanString(session.jobId, 300)
  if (!TERMINALS.has(terminal) || !userId || !jobId) return null

  const userSnap = await db.collection(PA_COLLECTIONS.users).doc(userId).get()
  const classification = classifyPrescreenSessionUser({
    userId,
    userDoc: userSnap.exists ? userSnap.data() ?? {} : null,
    session,
  })
  if (!args.includeNonReal && !classification.included) {
    return {
      excluded: {
        sessionId: session.sessionId,
        userId,
        jobId,
        terminal,
        reason: classification.reason,
        source: classification.source,
      },
    }
  }

  const attemptId = cleanString(session.evaluationAttemptId, 300) ?? cleanString(session.review?.evaluationAttemptId, 300)
  const stateId = createCandidateJobStateId(userId, jobId)
  const ackKey = `prescreen_review_pending:${session.sessionId}`
  const ackId = outboundMessageDocId(ackKey)
  const [attemptSnap, stateSnap, ackSnap] = await Promise.all([
    attemptId ? db.collection(PA_COLLECTIONS.evaluationAttempts).doc(attemptId).get() : Promise.resolve(null),
    db.collection(PA_COLLECTIONS.candidateJobStates).doc(stateId).get(),
    db.collection(PA_COLLECTIONS.outbound).doc(ackId).get(),
  ])
  const stateDoc = stateSnap.exists ? stateSnap.data() ?? {} : {}
  const state = cleanString(stateDoc.state, 80)
  const review = session.review && typeof session.review === "object" ? session.review : {}
  const alreadyCommitted =
    committedState(state) ||
    Boolean(session.terminalActionFiredAt) ||
    Boolean(session.reviewDecisionOutboundId) ||
    review.status === "approved" ||
    review.status === "overridden"

  const ackSkippedReason = cleanString(review.pendingAckSkippedReason, 120)

  const issues = []
  if (!attemptId || !attemptSnap?.exists) issues.push("missing_evaluation_attempt")
  if (state !== "prescreen_review_pending") issues.push("missing_prescreen_review_pending_state")
  if (!ackSnap.exists && !ackSkippedReason) issues.push("missing_pending_ack_outbound")
  if (session.terminalActionPendingReview !== true || review.status !== "pending") issues.push("missing_session_review_metadata")
  if (alreadyCommitted) issues.push("stale_already_committed_session")
  if (!cleanString(session.e164, 80) && !ackSkippedReason) issues.push("missing_e164_for_ack")

  return {
    sessionId: session.sessionId,
    userId,
    jobId,
    terminal,
    attemptId,
    attemptExists: Boolean(attemptSnap?.exists),
    state,
    ackId,
    alreadyCommitted,
    pendingReview: session.terminalActionPendingReview === true || review.status === "pending",
    issues,
    session,
    classification,
  }
}

async function applyBackfill(db, report, args) {
  if (!Array.isArray(report.issues) || report.issues.length === 0) {
    return { applied: false, reason: "no_issues" }
  }
  if (report.alreadyCommitted || (!report.pendingReview && !args.repairUncommitted)) {
    return { applied: false, reason: "not_pending_review_or_already_committed" }
  }
  const nowIso = new Date().toISOString()
  let attemptId = report.attemptId
  if (!attemptId || !report.attemptExists) {
    const attempt = prescreenSessionToEvaluationAttempt({
      state: report.session,
      cfgSnapshot: report.session.cfgSnapshot,
      terminal: report.terminal,
      nowIso,
      evaluator: { kind: "hybrid", promptVersion: "prescreen-keyword-set-v2-strict" },
    })
    await saveEvaluationAttempt(db, attempt)
    attemptId = attempt.attemptId
  }

  if (report.state !== "prescreen_review_pending") {
    const repairEventSuffix = args.repairUncommitted
      ? `-repair-${nowIso.replace(/[^0-9]/g, "").slice(0, 14)}`
      : ""
    if (stateAllowsStartedEvent(report.state)) {
      const startedEvent = eventBase(report, "prescreen_started", nowIso)
      await applyCandidateJobEvent(db, {
        ...startedEvent,
        eventId: `${startedEvent.eventId}${repairEventSuffix}`,
        type: "prescreen_started",
      })
    }
    const pendingEvent = eventBase(report, "prescreen_review_pending", nowIso)
    await applyCandidateJobEvent(db, {
      ...pendingEvent,
      eventId: `${pendingEvent.eventId}${repairEventSuffix}`,
      type: "prescreen_review_pending",
      evidence: [{ source: "prescreen", summary: `Terminal ${report.terminal}; waiting for WeKruit review`, refId: report.sessionId }],
    })
  }

  let pendingAckOutboundId = null
  let ackCreated = false
  const e164 = cleanString(report.session.e164, 80)
  const pendingAckSkippedReason = args.skipAck ? "historical_repair_no_candidate_outbound" : null
  if (!pendingAckSkippedReason) {
    if (!e164) return { applied: false, reason: "missing_e164_for_ack" }
    const ack = await enqueueOutbound(db, {
      userId: report.userId,
      toE164: e164,
      body: prescreenReviewPendingAckText("en"),
      idempotencyKey: `prescreen_review_pending:${report.sessionId}`,
      runtimeApproved: true,
      runtimeSource: "pa_prescreen_runtime",
    })
    pendingAckOutboundId = ack.id
    ackCreated = ack.created
  }

  await db.collection("pa-prescreen-sessions").doc(report.sessionId).set(
    {
      evaluationAttemptId: attemptId,
      terminalActionPendingReview: true,
      postPrescreenRetention: null,
      review: {
        status: "pending",
        evaluationAttemptId: attemptId,
        proposedTerminal: report.terminal,
        pendingAt: cleanString(report.session.review?.pendingAt, 80) ?? nowIso,
        ...(pendingAckOutboundId ? { pendingAckOutboundId } : {}),
        ...(pendingAckSkippedReason ? {
          pendingAckSkippedReason,
          pendingAckSkippedAt: nowIso,
        } : {}),
        backfilledAt: nowIso,
        backfillMode: args.repairUncommitted ? "repair_uncommitted_terminal" : "pending_review_backfill",
        updatedAt: nowIso,
      },
      updatedAt: nowIso,
    },
    { merge: true },
  )
  await db.collection(PA_COLLECTIONS.users).doc(report.userId).set(
    {
      postMatchRetention: null,
      updatedAt: nowIso,
    },
    { merge: true },
  )
  return {
    applied: true,
    attemptId,
    pendingAckOutboundId,
    ackCreated,
    pendingAckSkippedReason,
  }
}

const args = parseArgs(process.argv)
const db = initDb()
const rows = await listSessions(db, args)
const reports = []
const excluded = []
for (const row of rows) {
  const inspected = await inspectSession(db, row, args)
  if (!inspected) continue
  if (inspected.excluded) {
    excluded.push(inspected.excluded)
    continue
  }
  const report = inspected
  if (args.apply) report.applyResult = await applyBackfill(db, report, args)
  reports.push(report)
}

const byUser = new Map()
for (const report of reports) {
  const current = byUser.get(report.userId) ?? { userId: report.userId, sessions: [], issueCounts: {} }
  current.sessions.push({
    sessionId: report.sessionId,
    jobId: report.jobId,
    terminal: report.terminal,
    state: report.state,
    issues: report.issues,
    applyResult: report.applyResult,
  })
  for (const issue of report.issues) current.issueCounts[issue] = (current.issueCounts[issue] ?? 0) + 1
  byUser.set(report.userId, current)
}

const summary = {
  mode: args.apply ? "apply" : "report",
  scanned: rows.length,
  terminalPrescreens: reports.length,
  users: byUser.size,
  excludedNonReal: excluded.length,
  excludedByReason: summarizeExcludedPrescreenRows(excluded),
  issueCounts: reports.reduce((acc, report) => {
    for (const issue of report.issues) acc[issue] = (acc[issue] ?? 0) + 1
    return acc
  }, {}),
  applied: reports.filter((report) => report.applyResult?.applied).length,
  skippedApply: reports.filter((report) => report.applyResult && !report.applyResult.applied).length,
}

if (args.json) {
  console.log(JSON.stringify({ summary, users: [...byUser.values()], excludedSamples: excluded.slice(0, 25) }, null, 2))
} else {
  console.log("Prescreen review-pending audit")
  console.log(JSON.stringify(summary, null, 2))
  for (const user of byUser.values()) {
    console.log(`\npa-users/${user.userId}`)
    console.log(`issues: ${JSON.stringify(user.issueCounts)}`)
    for (const session of user.sessions) {
      console.log(`- ${session.sessionId} job=${session.jobId} terminal=${session.terminal} state=${session.state ?? "missing"} issues=${session.issues.join(",") || "none"}`)
      if (session.applyResult) console.log(`  apply=${JSON.stringify(session.applyResult)}`)
    }
  }
}
