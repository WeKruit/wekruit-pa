/**
 * Production Firestore prescreen stress runner.
 *
 * Exercises the real prescreen start/turn/terminal code against production
 * Firestore while stubbing outbound SMS. This creates auditable backend state
 * without sending test traffic to a real phone.
 *
 * Run:
 *   PATH=/Users/adam/.nvm/versions/node/v24.3.0/bin:$PATH \
 *   GOOGLE_APPLICATION_CREDENTIALS=/Users/adam/Downloads/service_account_key.json \
 *   node --import tsx apps/functions/scripts/prescreen-stress-firestore.ts
 */
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { config as loadDotenv } from "dotenv"
import { initializeApp, applicationDefault, getApps } from "firebase-admin/app"
import { FieldValue, getFirestore, type Firestore } from "firebase-admin/firestore"
import { runPreScreenForUser } from "../src/prescreen-session-start.js"
import { runPrescreenTurnIfActive } from "../src/prescreen-turn-handler.js"
import {
  runPrescreenTerminalAction,
  type PrescreenTerminalKind,
} from "../src/prescreen-terminal-action.js"
import { requireExistingPaUserForProductionTest } from "./lib/prod-test-user-guard.mjs"

loadDotenv({ path: ".env" })
loadDotenv({ path: "apps/functions/.env", override: false })

const PROJECT_ID = "wekruit-5f89b"
const JOB_ID = process.env.PRESCREEN_STRESS_JOB_ID ?? "rain-software-engineer-fullstack-8849f6ef"
const STRESS_USER_ID = process.env.PRESCREEN_STRESS_USER_ID ?? "verify-prescreen-stress-user"
const STRESS_PHONE = process.env.PRESCREEN_STRESS_PHONE ?? "+19995550000"
const ARTIFACT_DIR = path.resolve(".planning/prescreen-stress/artifacts")

type Scenario = {
  slug: string
  label: string
  expected: {
    terminal?: PrescreenTerminalKind
    minClarifies?: number
    maxClarifies?: number
    terminalMustNotBeforeTurn?: number
  }
  replies: string[]
}

const scenarios: Scenario[] = [
  {
    slug: "strong_fullstack_pass",
    label: "Strong fullstack candidate should progress through all questions and pass",
    expected: { terminal: "PASS", maxClarifies: 1 },
    replies: [
      "I owned a production merchant order dashboard and dispatch tooling for OFO Delivery. I built React and Node screens, Postgres SQL reports, and scripts that traced failed orders. Those fixes reduced merchant support triage from hours to minutes and improved onboarding and pricing edge cases.",
      "My strongest skill is full-stack TypeScript. I built React admin flows, Node endpoints, SQL queries, validation, auth checks, and order-state debugging. The hardest part was making failed-order states explainable enough that ops could self-serve instead of asking engineering.",
      "New York hybrid works for me. I can be in New York and remote-flexible is also fine.",
      "$90k to $140k is aligned with what I am targeting.",
      "I do not need current or future visa sponsorship for this role.",
    ],
  },
  {
    slug: "adjacent_probe_recovery",
    label: "Adjacent candidate starts weak, then Claire should probe and recover instead of abrupt rejection",
    expected: { terminal: "PASS", minClarifies: 2, terminalMustNotBeforeTurn: 3 },
    replies: [
      "I have not owned a fullstack system professionally. Most of my work was product ops, campus delivery dashboards, SQL reports, and small scripts.",
      "Closest was OFO Delivery. I owned the merchant order dashboard and dispatch tooling.",
      "I personally built JavaScript screens, SQL reports, and debugging scripts to trace failed orders; then worked with engineers to fix onboarding and pricing edge cases. It touched merchant dashboards, order data, dispatch workflows, and ops support queues.",
      "For technical depth, my strongest part was SQL plus JavaScript dashboards. I wrote queries for failed-order patterns, built the UI to surface them, and added scripts ops used during merchant onboarding.",
      "The dashboard frontend was React and TypeScript. I built filters, order detail views, error states, and debugging panels, connected them to Node endpoints and Postgres query results, and used them to cut repeated failed-order triage.",
      "New York hybrid works for me.",
      "$90k to $140k works.",
      "I do not need visa sponsorship now or in the future.",
    ],
  },
  {
    slug: "weak_no_engineering_hard_stop",
    label: "Weak non-engineering candidate should get repeated probes before hard stop",
    expected: { terminal: "HARD_STOP", minClarifies: 4, terminalMustNotBeforeTurn: 5 },
    replies: [
      "I mostly did customer support and scheduling. I have not built software.",
      "The closest thing was updating spreadsheets and forwarding bug reports to engineers.",
      "I did not build APIs, databases, dashboards, or production code myself.",
      "I do not have an engineering project example. I mainly coordinated tickets and customer issues.",
      "Still no software engineering example from me.",
    ],
  },
  {
    slug: "user_exit_pause",
    label: "Candidate can exit cleanly and the work session pauses",
    expected: { terminal: "PAUSE" },
    replies: ["stop"],
  },
]

type SentMessage = { phase: "start" | "turn" | "terminal"; to: string; content: string }
type TurnSummary = {
  reply: string
  handled: boolean
  terminal?: string | null
  textSent?: string
  sessionTerminal?: string | null
  currentQId?: string | null
  actionKinds: string[]
}

function nowStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-")
}

async function ensureTestUser(db: Firestore, userId: string, phone: string, runId: string, scenario: Scenario) {
  const now = new Date().toISOString()
  const existing = await requireExistingPaUserForProductionTest(db, {
    projectId: PROJECT_ID,
    scriptName: "prescreen-stress-firestore.ts",
    userId,
  })
  const existingCreatedAt = existing?.data?.createdAt ?? null
  await db.collection("pa-users").doc(userId).set(
    {
      id: userId,
      phoneE164: phone,
      testMode: true,
      synthetic: true,
      signupSource: "test:prescreen_stress",
      candidateLifecycleState: "synthetic_test",
      createdAt: existingCreatedAt ?? now,
      updatedAt: now,
      stressRun: {
        runId,
        scenario: scenario.slug,
        label: scenario.label,
      },
    },
    { merge: true },
  )
}

async function readSession(db: Firestore, sessionId: string) {
  const snap = await db.collection("pa-prescreen-sessions").doc(sessionId).get()
  const data = snap.data() ?? {}
  const turns = await db
    .collection("pa-prescreen-sessions")
    .doc(sessionId)
    .collection("turns")
    .orderBy("ts", "asc")
    .get()
  return {
    data,
    turns: turns.docs.map((d) => ({ id: d.id, ...d.data() })),
  }
}

function countClarifies(turns: Array<Record<string, unknown>>): number {
  return turns.filter((t) => {
    const action = t.action as { kind?: string } | undefined
    return action?.kind === "clarify"
  }).length
}

function firstTerminalTurnIndex(turns: Array<Record<string, unknown>>): number | null {
  const idx = turns.findIndex((t) => {
    const action = t.action as { kind?: string } | undefined
    return action?.kind === "terminal"
  })
  return idx >= 0 ? idx + 1 : null
}

function stripUndefined<T>(value: T): T {
  if (value === undefined) return null as T
  if (value === null) return value
  if (Array.isArray(value)) return value.map((item) => stripUndefined(item)) as T
  if (typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = stripUndefined(child)
    }
    return out as T
  }
  return value
}

async function resetScenarioState(db: Firestore, userId: string) {
  const batch = db.batch()
  batch.delete(db.collection("pa-candidate-job-states").doc(`${userId}__${JOB_ID}`))
  batch.delete(db.collection("pa-employer-visible-profiles").doc(`${JOB_ID}__${userId}`))
  await batch.commit()
}

async function runScenario(db: Firestore, runId: string, scenario: Scenario) {
  const userId = STRESS_USER_ID
  const phone = STRESS_PHONE
  const sent: SentMessage[] = []
  const logs: Array<{ event: string; payload: Record<string, unknown> }> = []
  const captureSend = (phase: SentMessage["phase"]) => async (args: { to: string; content: string }) => {
    sent.push({ phase, to: args.to, content: args.content })
  }
  const log = (event: string, payload: Record<string, unknown>) => {
    logs.push({ event, payload })
  }

  await ensureTestUser(db, userId, phone, runId, scenario)
  await resetScenarioState(db, userId)
  const started = await runPreScreenForUser({
    db,
    jobId: JOB_ID,
    userId,
    toE164: phone,
    sendSms: captureSend("start"),
    log,
  })
  if (!started.ok) {
    return {
      slug: scenario.slug,
      userId,
      phone,
      started,
      sent,
      logs,
      error: `session_start_failed:${started.reason}`,
    }
  }

  const turns: TurnSummary[] = []
  for (const reply of scenario.replies) {
    const result = await runPrescreenTurnIfActive({
      db,
      userId,
      toE164: phone,
      replyText: reply,
      lang: "en",
      sendSms: captureSend("turn"),
      runTerminalAction: async (args) => {
        await runPrescreenTerminalAction({
          ...args,
          sendSms: captureSend("terminal"),
          startPii: async () => ({ ok: true, skipped: true, reason: "stress_stub" }),
          generateJobRecs: async () => ({ ok: true, jobCount: 0, reason: "stress_stub" }),
          log,
        })
      },
      log,
    })
    const sessionNow = await readSession(db, started.sessionId)
    turns.push({
      reply,
      handled: result.handled,
      terminal: result.terminal,
      textSent: result.textSent,
      sessionTerminal: (sessionNow.data.terminal as string | null | undefined) ?? null,
      currentQId: (sessionNow.data.currentQId as string | null | undefined) ?? null,
      actionKinds: sessionNow.turns.map((t) => ((t.action as { kind?: string } | undefined)?.kind ?? "unknown")),
    })
    if (sessionNow.data.terminal) break
  }

  const session = await readSession(db, started.sessionId)
  const clarifies = countClarifies(session.turns as Array<Record<string, unknown>>)
  const terminalTurnIndex = firstTerminalTurnIndex(session.turns as Array<Record<string, unknown>>)
  const memorySnap = await db.collection("pa-prescreen-memory-events").doc(started.sessionId).get()
  const stateSnap = await db.collection("pa-candidate-job-states").doc(`${userId}__${JOB_ID}`).get()
  const employerSnap = await db.collection("pa-employer-visible-profiles").doc(`${JOB_ID}__${userId}`).get()
  const finalTerminal = (session.data.terminal as string | null | undefined) ?? null

  const failures: string[] = []
  if (scenario.expected.terminal && finalTerminal !== scenario.expected.terminal) {
    failures.push(`expected terminal ${scenario.expected.terminal}, got ${finalTerminal}`)
  }
  if (scenario.expected.minClarifies !== undefined && clarifies < scenario.expected.minClarifies) {
    failures.push(`expected at least ${scenario.expected.minClarifies} clarifies, got ${clarifies}`)
  }
  if (scenario.expected.maxClarifies !== undefined && clarifies > scenario.expected.maxClarifies) {
    failures.push(`expected at most ${scenario.expected.maxClarifies} clarifies, got ${clarifies}`)
  }
  if (
    scenario.expected.terminalMustNotBeforeTurn !== undefined &&
    terminalTurnIndex !== null &&
    terminalTurnIndex < scenario.expected.terminalMustNotBeforeTurn
  ) {
    failures.push(`terminal happened on turn ${terminalTurnIndex}, before ${scenario.expected.terminalMustNotBeforeTurn}`)
  }

  await db.collection("pa-prescreen-stress-runs").doc(runId).set(
    {
      runId,
      jobId: JOB_ID,
      updatedAt: new Date().toISOString(),
      scenarioIds: FieldValue.arrayUnion(scenario.slug),
    },
    { merge: true },
  )

  return {
    slug: scenario.slug,
    label: scenario.label,
    userId,
    phone,
    started,
    sessionId: started.sessionId,
    finalTerminal,
    terminalReason: session.data.terminalReason ?? null,
    workSession: session.data.workSession ?? null,
    clarifies,
    terminalTurnIndex,
    turnCount: session.turns.length,
    currentQId: session.data.currentQId ?? null,
    score: session.data.score ?? null,
    scoreMax: session.data.scoreMax ?? null,
    questions: session.data.questions ?? null,
    sent,
    turns,
    memoryEventExists: memorySnap.exists,
    candidateJobState: stateSnap.exists ? stateSnap.data() : null,
    employerVisibleProfileExists: employerSnap.exists,
    logs,
    failures,
  }
}

async function main() {
  if (!process.env.PA_OPENAI_AGENT_API_KEY && !process.env.OPENAI_API_KEY) {
    throw new Error("missing PA_OPENAI_AGENT_API_KEY/OPENAI_API_KEY; stress runner must fail before creating sessions")
  }
  if (!getApps().length) {
    initializeApp({ projectId: PROJECT_ID, credential: applicationDefault() })
  }
  const db = getFirestore()
  const runId = `stress-${nowStamp()}`
  const results = []
  for (let i = 0; i < scenarios.length; i += 1) {
    const result = await runScenario(db, runId, scenarios[i])
    results.push(result)
    const status = "failures" in result && Array.isArray(result.failures) && result.failures.length > 0
      ? `FAIL ${result.failures.join("; ")}`
      : "PASS"
    console.log(`[${status}] ${result.slug} session=${"sessionId" in result ? result.sessionId : "n/a"} terminal=${"finalTerminal" in result ? result.finalTerminal : "n/a"}`)
  }

  const summary = {
    runId,
    jobId: JOB_ID,
    createdAt: new Date().toISOString(),
    results,
    failedScenarios: results
      .filter((r) => "failures" in r && Array.isArray(r.failures) && r.failures.length > 0)
      .map((r) => ({ slug: r.slug, failures: "failures" in r ? r.failures : [] })),
  }
  mkdirSync(ARTIFACT_DIR, { recursive: true })
  const artifactPath = path.join(ARTIFACT_DIR, `${runId}.json`)
  writeFileSync(artifactPath, `${JSON.stringify(summary, null, 2)}\n`)
  await db.collection("pa-prescreen-stress-runs").doc(runId).set(stripUndefined(summary), { merge: true })
  console.log(`[artifact] ${artifactPath}`)
  if (summary.failedScenarios.length > 0) {
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
