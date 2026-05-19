/**
 * Production Firestore Sendblue entrypoint matrix.
 *
 * Exercises the real Sendblue webhook router against production Firestore while
 * stubbing outbound sends. This proves entrypoint routing without sending
 * messages or creating random pa-users rows.
 *
 * Run:
 *   PATH=/Users/adam/.nvm/versions/node/v24.3.0/bin:$PATH \
 *   GOOGLE_APPLICATION_CREDENTIALS=/Users/adam/Downloads/service_account_key.json \
 *   node --import tsx apps/functions/scripts/sendblue-entrypoint-matrix-firestore.ts
 */
import { createHmac } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { config as loadDotenv } from "dotenv"
import { applicationDefault, getApps, initializeApp } from "firebase-admin/app"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { createInboundEvent } from "@pa/pa-broker"

import { handleSendblueWebhook, type WebhookRequest, type WebhookResponse } from "../src/sendblue/webhook.js"
import { runLayoffSmsStart } from "../src/layoff-sms-start.js"
import { runPreScreenForUser } from "../src/prescreen-session-start.js"
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
const JOB_ID = process.env.SENDBLUE_MATRIX_JOB_ID ?? "rain-software-engineer-fullstack-8849f6ef"
const USER_ID = process.env.SENDBLUE_MATRIX_USER_ID ?? "U7AwKT8nLDRa35DkuBxq"
const PHONE = process.env.SENDBLUE_MATRIX_PHONE ?? "+14243201960"
const ARTIFACT_DIR = path.resolve(".planning/sendblue-entrypoint-matrix/artifacts")
const SECRET = "local-entrypoint-matrix-secret"
const SCRIPT_NAME = "sendblue-entrypoint-matrix-firestore.ts"

type SentMessage = { kind: "prescreen" | "layoff"; to: string; content: string }
type PrescreenStart = { jobId: string; userId: string; sessionId: string; ok: boolean; reason?: string }
type LayoffStart = { userId: string; ok: boolean; kickoffOutboundId?: string; reason?: string }
type ScenarioResult = {
  slug: string
  webhookStatus: number
  webhookBody: unknown
  passed: boolean
  evidence: Record<string, unknown>
  failures: string[]
}

function nowStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-")
}

function sign(body: string): string {
  return createHmac("sha256", SECRET).update(body, "utf8").digest("hex")
}

function makePayload(handle: string, content: string) {
  return {
    is_outbound: false,
    from_number: PHONE,
    to_number: "+13054507715",
    message_handle: handle,
    content,
    status: "RECEIVED",
    service: "iMessage",
    date_sent: new Date().toISOString(),
  }
}

function makeReq(body: string): WebhookRequest {
  const headers = {
    "content-type": "application/json",
    "sendblue-signature": sign(body),
  }
  return {
    rawBody: Buffer.from(body, "utf8"),
    body,
    headers,
    method: "POST",
    header(name: string) {
      return headers[name.toLowerCase() as keyof typeof headers]
    },
  }
}

function makeRes() {
  let statusCode = 200
  let bodyOut: unknown = null
  const res: WebhookResponse & { statusCode: number; bodyOut: unknown } = {
    get statusCode() {
      return statusCode
    },
    get bodyOut() {
      return bodyOut
    },
    status(code: number) {
      statusCode = code
      return this
    },
    json(body: unknown) {
      bodyOut = body
      return this
    },
    send(body?: unknown) {
      bodyOut = body
      return this
    },
    set() {
      return this
    },
  }
  return res
}

function asBody(body: unknown): { action?: string; eventId?: string; ignored?: string } {
  return body && typeof body === "object" ? (body as { action?: string; eventId?: string; ignored?: string }) : {}
}

async function countUsers(db: Firestore): Promise<number> {
  const snap = await db.collection("pa-users").count().get()
  return snap.data().count
}

async function ensureExistingMatrixUser(db: Firestore) {
  const found = await requireExistingPaUserWithAllowedPhoneForProductionTest(db, {
    projectId: PROJECT_ID,
    scriptName: "sendblue-entrypoint-matrix-firestore.ts",
    userId: USER_ID,
    phoneE164: PHONE,
  })
  return found.data
}

async function restoreMatrixUser(db: Firestore, before: FirebaseFirestore.DocumentData) {
  await db.collection("pa-users").doc(USER_ID).set(
    {
      ...before,
    },
    { merge: false },
  )
}

async function clearIdempotency(db: Firestore) {
  await Promise.all([
    db.collection("pa-prescreen-trigger-idempotency").doc(`${JOB_ID}_${USER_ID}`).delete().catch(() => undefined),
    db.collection("pa-layoff-trigger-idempotency").doc(USER_ID).delete().catch(() => undefined),
  ])
}

async function cleanupMatrixPrescreenSessions(db: Firestore, starts: PrescreenStart[]) {
  const now = new Date().toISOString()
  const seen = new Set<string>()
  const out: Array<{ sessionId: string; cleaned: boolean; previousTerminal: unknown }> = []
  for (const start of starts) {
    if (!start.sessionId || seen.has(start.sessionId)) continue
    seen.add(start.sessionId)
    const ref = db.collection("pa-prescreen-sessions").doc(start.sessionId)
    const snap = await ref.get()
    const data = snap.data() ?? {}
    const previousTerminal = data.terminal ?? null
    if (!snap.exists || previousTerminal) {
      out.push({ sessionId: start.sessionId, cleaned: false, previousTerminal })
      continue
    }
    await ref.set(
      {
        terminal: "PAUSE",
        terminalReason: "sendblue_matrix_cleanup",
        currentQId: null,
        updatedAt: now,
        workSession: {
          kind: "job_prescreen",
          status: "ended",
          boundary: "sendblue_matrix_cleanup",
          endedAt: now,
        },
      },
      { merge: true },
    )
    out.push({ sessionId: start.sessionId, cleaned: true, previousTerminal })
  }
  return out
}

async function cleanupMatrixPrescreenSessionsAfterAsyncSettles(
  db: Firestore,
  starts: PrescreenStart[],
) {
  const first = await cleanupMatrixPrescreenSessions(db, starts)
  await new Promise((resolve) => setTimeout(resolve, 5000))
  const second = await cleanupMatrixPrescreenSessions(db, starts)
  return { first, second }
}

async function dispatch(
  db: Firestore,
  runId: string,
  slug: string,
  content: string,
  sent: SentMessage[],
  prescreenStarts: PrescreenStart[],
  layoffStarts: LayoffStart[],
): Promise<{ status: number; body: unknown }> {
  const body = JSON.stringify(makePayload(`${runId}-${slug}`, content))
  const req = makeReq(body)
  const res = makeRes()
  await handleSendblueWebhook(req, res, {
    db,
    secret: SECRET,
    createInboundEvent: async (targetDb, input) => createInboundEvent(targetDb, {
      ...input,
      userId: USER_ID,
      rawPayload: {
        ...input.rawPayload,
        e2eTest: true,
        harness: {
          runner: SCRIPT_NAME,
          suppressOutbound: true,
        },
      },
    }),
    runPreScreenForUser: async (args) => {
      const result = await runPreScreenForUser({
        ...args,
        sendSms: async ({ to, content }) => {
          sent.push({ kind: "prescreen", to, content })
          return { uuid: `stub-prescreen-${Date.now()}` }
        },
      })
      prescreenStarts.push({
        jobId: args.jobId,
        userId: args.userId,
        sessionId: result.sessionId,
        ok: result.ok,
        reason: result.reason,
      })
      return result
    },
    runLayoffSmsStart: async (args) => {
      const result = await runLayoffSmsStart({
        ...args,
        enqueueOutbound: async () => {
          sent.push({ kind: "layoff", to: args.toE164, content: "stubbed layoff kickoff" })
          return { id: `stub-layoff-${Date.now()}`, created: true }
        },
      })
      layoffStarts.push({
        userId: args.userId,
        ok: result.ok,
        ...(result.ok
          ? { kickoffOutboundId: result.kickoffOutboundId }
          : { reason: result.reason }),
      })
      return result
    },
    log: () => undefined,
  })
  return { status: res.statusCode, body: res.bodyOut }
}

async function waitFor<T>(fn: () => Promise<T | null> | T | null, timeoutMs = 5000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await new Promise((r) => setTimeout(r, 250))
  }
  return null
}

async function runMatrix(db: Firestore) {
  const runId = `sbmatrix-${nowStamp()}`
  const sent: SentMessage[] = []
  const prescreenStarts: PrescreenStart[] = []
  const layoffStarts: LayoffStart[] = []
  const beforeCount = await countUsers(db)
  const beforeUser = await ensureExistingMatrixUser(db)
  const results: ScenarioResult[] = []
  let cleanup: Awaited<ReturnType<typeof cleanupMatrixPrescreenSessions>> = []
  const releaseLock = await acquireProductionTestRunLock(db, {
    lockId: productionTestRunLockId({
      scope: "sendblue-prescreen-stress",
      userId: USER_ID,
      jobId: JOB_ID,
    }),
    runId,
    scriptName: "sendblue-entrypoint-matrix-firestore.ts",
    projectId: PROJECT_ID,
  })

  try {
    await clearIdempotency(db)
    const jobStartOffset = prescreenStarts.length
    const jobTrigger = await dispatch(db, runId, "job-trigger", `WeKruit_${JOB_ID}_${USER_ID}_Job`, sent, prescreenStarts, layoffStarts)
    const jobStart = await waitFor(() => prescreenStarts[jobStartOffset] ?? null)
    const jobBody = asBody(jobTrigger.body)
    results.push({
      slug: "job_prescreen_trigger",
      webhookStatus: jobTrigger.status,
      webhookBody: jobTrigger.body,
      passed: jobTrigger.status === 200 &&
        jobBody.action === "prescreen_triggered" &&
        Boolean(jobStart?.sessionId) &&
        sent.some((m) => m.kind === "prescreen"),
      evidence: {
        sessionId: jobStart?.sessionId,
        action: jobBody.action,
        sentPrescreenCount: sent.filter((m) => m.kind === "prescreen").length,
      },
      failures: [],
    })

    await clearIdempotency(db)
    const layoffStartOffset = layoffStarts.length
    const layoff = await dispatch(db, runId, "layoff-trigger", "WeKruit_LAID_OFF", sent, prescreenStarts, layoffStarts)
    const layoffStart = await waitFor(() => layoffStarts[layoffStartOffset] ?? null)
    const layoffBody = asBody(layoff.body)
    const userAfterLayoff = (await db.collection("pa-users").doc(USER_ID).get()).data() ?? {}
    results.push({
      slug: "raw_layoff_source_token_suppressed",
      webhookStatus: layoff.status,
      webhookBody: layoff.body,
      passed: layoff.status === 200 &&
        layoffBody.action === "layoff_unauthorized" &&
        !layoffStart &&
        userAfterLayoff?.source === beforeUser.source &&
        sent.filter((m) => m.kind === "layoff").length === 0,
      evidence: {
        action: layoffBody.action,
        source: userAfterLayoff?.source,
        expectedSource: beforeUser.source,
        startAttempted: Boolean(layoffStart),
        kickoffOutboundId: layoffStart?.kickoffOutboundId,
        sentLayoffCount: sent.filter((m) => m.kind === "layoff").length,
      },
      failures: [],
    })

    const normal = await dispatch(db, runId, "normal-start", "START", sent, prescreenStarts, layoffStarts)
    const normalBody = asBody(normal.body)
    const normalInbound = normalBody.eventId
      ? (await db.collection("pa-inbound-events").doc(normalBody.eventId).get()).data()
      : null
    results.push({
      slug: "normal_start_no_pending_invite_harness_suppressed",
      webhookStatus: normal.status,
      webhookBody: normal.body,
      passed: normal.status === 200 &&
        Boolean(normalBody.eventId) &&
        !normalBody.action &&
        normalInbound?.rawPayload?.text === "START" &&
        normalInbound?.rawPayload?.harness?.suppressOutbound === true,
      evidence: {
        eventId: normalBody.eventId,
        rawText: normalInbound?.rawPayload?.text,
        rawE2e: normalInbound?.rawPayload?.e2eTest === true,
        suppressOutbound: normalInbound?.rawPayload?.harness?.suppressOutbound === true,
      },
      failures: [],
    })

    await clearIdempotency(db)
    await db.collection("pa-ats-pending-trigger").doc(PHONE).set({
      jobId: JOB_ID,
      userId: USER_ID,
      expiresAtMs: Date.now() + 60 * 60 * 1000,
      createdAt: new Date().toISOString(),
      runId,
    })
    const atsStartOffset = prescreenStarts.length
    const ats = await dispatch(db, runId, "ats-start", "START", sent, prescreenStarts, layoffStarts)
    const atsStart = await waitFor(() => prescreenStarts[atsStartOffset] ?? null)
    const atsBody = asBody(ats.body)
    const pendingAfter = await db.collection("pa-ats-pending-trigger").doc(PHONE).get()
    results.push({
      slug: "start_with_ats_pending_invite",
      webhookStatus: ats.status,
      webhookBody: ats.body,
      passed: ats.status === 200 &&
        atsBody.action === "prescreen_triggered" &&
        !pendingAfter.exists &&
        Boolean(atsStart?.sessionId),
      evidence: {
        action: atsBody.action,
        pendingConsumed: !pendingAfter.exists,
        sessionId: atsStart?.sessionId,
      },
      failures: [],
    })
  } finally {
    cleanup = await cleanupMatrixPrescreenSessionsAfterAsyncSettles(db, prescreenStarts)
    await restoreMatrixUser(db, beforeUser)
    await releaseLock()
  }

  const afterCount = await countUsers(db)
  for (const result of results) {
    if (!result.passed) result.failures.push("scenario_expectation_failed")
  }
  const artifact = {
    runId,
    projectId: PROJECT_ID,
    userId: USER_ID,
    phone: PHONE,
    jobId: JOB_ID,
    beforeCount,
    afterCount,
    noUserGrowth: beforeCount === afterCount,
    cleanup,
    sent,
    results,
    passed: beforeCount === afterCount && results.every((r) => r.passed),
  }
  mkdirSync(ARTIFACT_DIR, { recursive: true })
  const artifactPath = path.join(ARTIFACT_DIR, `${runId}.json`)
  writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`)
  return { artifactPath, artifact }
}

async function main() {
  if (!getApps().length) {
    initializeApp({
      projectId: PROJECT_ID,
      credential: applicationDefault(),
    })
  }
  const db = getFirestore()
  const { artifactPath, artifact } = await runMatrix(db)
  console.log(JSON.stringify({ artifactPath, passed: artifact.passed, results: artifact.results }, null, 2))
  if (!artifact.passed) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
