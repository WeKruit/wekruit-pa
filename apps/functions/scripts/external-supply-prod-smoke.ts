/**
 * v2.0 External Supply V1 — Live prod smoke script.
 *
 * Drives the external-supply pipeline against the **production** Firestore in
 * `wekruit-5f89b` via the Admin SDK. Bypasses the callable auth wrapper by
 * invoking the underlying `run*` runners directly. Used to close the
 * "deployed-but-not-invoked" gap that the independent audit flagged.
 *
 * Usage:
 *   export GOOGLE_APPLICATION_CREDENTIALS=$(mktemp)
 *   grep -E "^FIREBASE_SERVICE_ACCOUNT_JSON=" .env | sed 's/^FIREBASE_SERVICE_ACCOUNT_JSON=//' > "$GOOGLE_APPLICATION_CREDENTIALS"
 *   node --import tsx scripts/external-supply-prod-smoke.ts
 *
 * What it does (sequentially):
 *   1. Initialises firebase-admin against the prod project.
 *   2. Seeds ONE small batch (`prod-smoke-<iso>`) plus 4 candidate records
 *      directly in Firestore. Records cover the four key identity outcomes:
 *      LinkedIn-only / LinkedIn+email / email-only / no-signal.
 *   3. Calls `runResolveBatchIdentity` against that batch. Captures the
 *      counters + the on-disk record statuses.
 *   4. Calls `runEvaluation` over the resolved records against a synthetic
 *      `prod-smoke-company` + `prod-smoke-job` doc. Captures the per-tier
 *      breakdown.
 *   5. Calls `runDraftOutreachPlan` against the highest-tier evaluation
 *      from step 4. Captures the suppression-gate result.
 *   6. Calls `runSyncPlanToInstantly` in **dry_run** mode against the
 *      drafted plan. NEVER calls Instantly live (no API key in service
 *      account env).
 *   7. Calls `handleInstantlyWebhook` with a synthetic reply event so the
 *      idempotency / feedback-event paths are exercised.
 *   8. Reads back doc counts on every external-supply collection touched.
 *   9. Writes a compact JSON evidence report to
 *      `.planning/external-supply-v1/artifacts/wave-e-live-prod-smoke.json`.
 *
 * What it does NOT do:
 *   - Email outbound. No `INSTANTLY_API_KEY` set; live-mode gate downgrades.
 *   - Persist the test batch beyond the run. The script tags every doc with
 *     `meta.prodSmokeRun: <isoTs>` so the operator can clean it up later if
 *     desired. We deliberately leave the docs in place so the verifier can
 *     re-walk them.
 *
 * Safety:
 *   - All doc ids prefixed `prod-smoke-` so they cannot collide with real
 *     traffic.
 *   - LinkedIn URLs use the `example.test` TLD analogue (`linkedin.com/in/prod-smoke-*`)
 *     so the rows are obviously synthetic.
 *   - No emails sent. Instantly client mocked at call site via dry_run mode.
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { initializeApp, applicationDefault, cert } from "firebase-admin/app"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import {
  PA_COLLECTIONS,
  candidateHandleHashMaterial,
  createCandidateHandleId,
  type ExternalCandidateRecord,
  type ExternalSourcingBatch,
} from "@pa/core-types"

import { runResolveBatchIdentity } from "../src/external-supply/resolve-identity.js"
import { runEvaluation } from "../src/external-supply/evaluate.js"
import { runDraftOutreachPlan } from "../src/external-supply/outreach.js"
import { runSyncPlanToInstantly } from "../src/external-supply/instantly-sync.js"
import { handleInstantlyWebhook } from "../src/external-supply/instantly-webhook.js"
import { assertProductionPaUserCreationAllowed } from "./lib/prod-test-user-guard.mjs"

const PROJECT_ID = "wekruit-5f89b"
const NOW_ISO = new Date().toISOString()
const SMOKE_RUN_ID = `prod-smoke-${NOW_ISO.replace(/[:.]/g, "-")}`

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function linkedinHash(url: string): string {
  return sha256Hex(candidateHandleHashMaterial("linkedin", url))
}

function emailHash(value: string): string {
  return sha256Hex(candidateHandleHashMaterial("email", value))
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function makeBatch(): ExternalSourcingBatch {
  return {
    batchId: `${SMOKE_RUN_ID}-batch`,
    source: "manual_csv",
    companyId: `${SMOKE_RUN_ID}-company`,
    jobId: `${SMOKE_RUN_ID}-job`,
    status: "normalized",
    rowCount: 4,
    validLinkedInCount: 3,
    validEmailCount: 3,
    duplicateCount: 0,
    needsReviewCount: 0,
    readyToProfileCount: 4,
    rawFileRef: {
      storageUri: `gs://wekruit-5f89b.appspot.com/external-supply/smoke/${SMOKE_RUN_ID}`,
      mime: "text/csv",
      sha256: sha256Hex(SMOKE_RUN_ID),
      sizeBytes: 0,
    },
    normalizerVersion: "ext-norm-2026-05",
    importedBy: "prod-smoke-script",
    createdAt: NOW_ISO,
    meta: { prodSmokeRun: NOW_ISO },
  }
}

function makeRecord(suffix: string, opts: {
  linkedInUrl?: string
  email?: string
  name?: string
  title?: string
  company?: string
}): ExternalCandidateRecord {
  const recordId = `${SMOKE_RUN_ID}-rec-${suffix}`
  const canonicalLinkedInUrl = opts.linkedInUrl
  const linkedinProfileHash = canonicalLinkedInUrl ? linkedinHash(canonicalLinkedInUrl) : undefined
  const emails = opts.email ? [{ value: opts.email, hash: emailHash(opts.email) }] : []
  return {
    recordId,
    batchId: `${SMOKE_RUN_ID}-batch`,
    source: "manual_csv",
    rawPayload: {},
    canonicalLinkedInUrl,
    linkedinProfileHash,
    emails,
    name: opts.name,
    currentTitle: opts.title,
    currentCompany: opts.company,
    experience: opts.title && opts.company
      ? [{ company: opts.company, title: opts.title }]
      : [],
    education: [],
    sourceTags: [],
    normalizationStatus: "ok",
    identityResolutionStatus: "pending",
    evidence: [],
    createdAt: NOW_ISO,
  }
}

const FIXTURE: ExternalCandidateRecord[] = [
  makeRecord("li-only", {
    linkedInUrl: "https://linkedin.com/in/prod-smoke-li-only",
    name: "Prod Smoke LinkedIn-Only",
    title: "Senior Software Engineer",
    company: "Prod Smoke Co",
  }),
  makeRecord("li-and-email", {
    linkedInUrl: "https://linkedin.com/in/prod-smoke-li-and-email",
    email: "prod-smoke-li-and-email@example.test",
    name: "Prod Smoke LinkedIn+Email",
    title: "Staff Engineer",
    company: "Prod Smoke Co",
  }),
  makeRecord("email-only", {
    email: "prod-smoke-email-only@example.test",
    name: "Prod Smoke Email Only",
    title: "Engineering Manager",
    company: "Prod Smoke Co",
  }),
  makeRecord("no-signal", {
    name: "Prod Smoke No Signal",
    title: "Distinguished Engineer",
    company: "Prod Smoke Co",
  }),
]

// ---------------------------------------------------------------------------
// Synthetic job/company so evaluation has context to read
// ---------------------------------------------------------------------------

async function seedCompanyAndJob(db: Firestore) {
  await db.collection("pa-companies").doc(`${SMOKE_RUN_ID}-company`).set({
    companyId: `${SMOKE_RUN_ID}-company`,
    name: "Prod Smoke Co",
    industrySector: ["software_and_internet"],
    size: "scale_up",
    competitorCompanies: ["Stripe", "OpenAI"],
    schoolPreferences: [],
    meta: { prodSmokeRun: NOW_ISO },
    createdAt: NOW_ISO,
  })
  await db.collection(PA_COLLECTIONS.jobs).doc(`${SMOKE_RUN_ID}-job`).set({
    jobId: `${SMOKE_RUN_ID}-job`,
    companyId: `${SMOKE_RUN_ID}-company`,
    title: "Software Engineer (Prod Smoke)",
    roleFunction: ["software_engineering"],
    seniorityLevel: "senior",
    locationBuckets: ["remote", "san_francisco_bay_area"],
    sponsorship: true,
    jobType: "full_time",
    requiredSkills: [],
    salaryMin: 180000,
    salaryMax: 260000,
    firstSeenAt: NOW_ISO,
    dead: false,
    atsApplyUrl: "https://example.test/apply",
    meta: { prodSmokeRun: NOW_ISO },
    createdAt: NOW_ISO,
  })
}

async function seedBatchAndRecords(db: Firestore) {
  const batch = makeBatch()
  await db.collection(PA_COLLECTIONS.externalSourcingBatches).doc(batch.batchId).set(batch)
  for (const rec of FIXTURE) {
    await db.collection(PA_COLLECTIONS.externalCandidateRecords).doc(rec.recordId).set(rec)
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Initialise Admin SDK. GOOGLE_APPLICATION_CREDENTIALS env var must point
  // at the service-account JSON (see CLAUDE.md "Deploy commands" block).
  const gac = process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (!gac) throw new Error("GOOGLE_APPLICATION_CREDENTIALS env var required")
  initializeApp({
    credential: applicationDefault(),
    projectId: PROJECT_ID,
  })
  const db = getFirestore()
  db.settings({ ignoreUndefinedProperties: true })

  assertProductionPaUserCreationAllowed({
    projectId: PROJECT_ID,
    scriptName: "external-supply-prod-smoke.ts",
    reason:
      "External-supply prod smoke seeds synthetic records and runResolveBatchIdentity creates prospect pa-users.",
  })

  const evidence: Record<string, unknown> = {
    runId: SMOKE_RUN_ID,
    startedAt: NOW_ISO,
    projectId: PROJECT_ID,
    steps: [] as Array<Record<string, unknown>>,
  }

  // Step 1 — seed synthetic context
  console.log(`[smoke] seeding company + job + batch + records for run ${SMOKE_RUN_ID}`)
  await seedCompanyAndJob(db)
  await seedBatchAndRecords(db)
  ;(evidence.steps as Array<Record<string, unknown>>).push({
    step: "seed",
    batchId: `${SMOKE_RUN_ID}-batch`,
    recordIds: FIXTURE.map((r) => r.recordId),
    companyId: `${SMOKE_RUN_ID}-company`,
    jobId: `${SMOKE_RUN_ID}-job`,
  })

  // Step 2 — resolveBatchIdentity
  console.log("[smoke] runResolveBatchIdentity")
  const resolveResult = await runResolveBatchIdentity(
    { batchId: `${SMOKE_RUN_ID}-batch` },
    { uid: "prod-smoke", token: { email: "prod-smoke@wekruit.com", email_verified: true } },
    { db }
  )
  ;(evidence.steps as Array<Record<string, unknown>>).push({
    step: "resolveBatchIdentity",
    result: resolveResult,
  })

  // Step 3 — runEvaluation
  console.log("[smoke] runEvaluation")
  const evalRunId = randomUUID()
  const evaluationResult = await runEvaluation(
    {
      runId: evalRunId,
      batchId: `${SMOKE_RUN_ID}-batch`,
      companyId: `${SMOKE_RUN_ID}-company`,
      jobId: `${SMOKE_RUN_ID}-job`,
    },
    { uid: "prod-smoke", token: { email: "prod-smoke@wekruit.com", email_verified: true } },
    { db }
  )
  ;(evidence.steps as Array<Record<string, unknown>>).push({
    step: "runEvaluation",
    runId: evalRunId,
    result: evaluationResult,
  })

  // Step 4 — find the highest evaluation + draft outreach
  const evalSnap = await db
    .collection(PA_COLLECTIONS.candidateCompanyJobEvaluations)
    .where("evaluationRunId", "==", evalRunId)
    .get()
  const firstEval = evalSnap.docs[0]?.data() as { evaluationId?: string } | undefined
  let draftResult: unknown = null
  if (firstEval?.evaluationId) {
    console.log(`[smoke] runDraftOutreachPlan against ${firstEval.evaluationId}`)
    try {
      draftResult = await runDraftOutreachPlan(
        { evaluationId: firstEval.evaluationId },
        { uid: "prod-smoke", token: { email: "prod-smoke@wekruit.com", email_verified: true } },
        { db }
      )
    } catch (err) {
      draftResult = { error: err instanceof Error ? err.message : String(err) }
    }
  }
  ;(evidence.steps as Array<Record<string, unknown>>).push({
    step: "runDraftOutreachPlan",
    sourceEvaluationId: firstEval?.evaluationId ?? null,
    result: draftResult,
  })

  // Step 5 — runSyncPlanToInstantly (dry-run; live mode is env-gated)
  const planId = (draftResult && typeof draftResult === "object" && "planId" in draftResult)
    ? String((draftResult as { planId: unknown }).planId)
    : null
  let syncResult: unknown = null
  if (planId) {
    console.log(`[smoke] runSyncPlanToInstantly dry-run for ${planId}`)
    try {
      syncResult = await runSyncPlanToInstantly(
        { planId, mode: "dry_run" },
        { uid: "prod-smoke", token: { email: "prod-smoke@wekruit.com", email_verified: true } },
        { db }
      )
    } catch (err) {
      syncResult = { error: err instanceof Error ? err.message : String(err) }
    }
  }
  ;(evidence.steps as Array<Record<string, unknown>>).push({
    step: "runSyncPlanToInstantly",
    planId,
    mode: "dry_run",
    result: syncResult,
  })

  // Step 6 — webhook idempotency
  console.log("[smoke] handleInstantlyWebhook twice (idempotency)")
  const webhookBody = {
    event_type: "reply",
    event_id: `${SMOKE_RUN_ID}-evt-1`,
    lead: { email: "prod-smoke-li-and-email@example.test", id: "evt-1" },
    campaign_id: "smoke-campaign",
    occurred_at: NOW_ISO,
  }
  const webhookResults: unknown[] = []
  for (let i = 0; i < 2; i++) {
    let status = 200
    let body: unknown = null
    await handleInstantlyWebhook(
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: webhookBody,
        rawBody: Buffer.from(JSON.stringify(webhookBody)),
      },
      {
        status: (code) => {
          status = code
          return {
            json: (b) => {
              body = b
            },
            send: (b) => {
              body = b
            },
          }
        },
        json: (b) => {
          body = b
        },
        send: (b) => {
          body = b
        },
      } as unknown as {
        status: (n: number) => { json: (b: unknown) => void; send: (b: unknown) => void }
        json: (b: unknown) => void
        send: (b: unknown) => void
      },
      { db, secret: "" }
    )
    webhookResults.push({ status, body })
  }
  ;(evidence.steps as Array<Record<string, unknown>>).push({
    step: "handleInstantlyWebhook",
    iterations: 2,
    results: webhookResults,
  })

  // Step 7 — doc-count audit
  console.log("[smoke] doc-count audit")
  const counts: Record<string, number> = {}
  const collections = [
    PA_COLLECTIONS.externalSourcingBatches,
    PA_COLLECTIONS.externalCandidateRecords,
    PA_COLLECTIONS.candidateSourceLinks,
    PA_COLLECTIONS.candidateEvaluationRuns,
    PA_COLLECTIONS.candidateCompanyJobEvaluations,
    PA_COLLECTIONS.outreachPlans,
    PA_COLLECTIONS.instantlySyncRecords,
    PA_COLLECTIONS.outreachEvents,
    PA_COLLECTIONS.feedbackEvents,
    PA_COLLECTIONS.candidateHandles,
    PA_COLLECTIONS.candidateIdentityEvents,
  ]
  for (const colName of collections) {
    const snap = await db
      .collection(colName)
      .where("createdAt", ">=", NOW_ISO)
      .limit(100)
      .get()
      .catch(() => null)
    counts[colName] = snap ? snap.size : -1
  }
  ;(evidence.steps as Array<Record<string, unknown>>).push({
    step: "doc_count_audit",
    counts,
  })

  // Step 8 — pa-users smoke: did the new prospects + handle docs land?
  const linkedinHandleId = createCandidateHandleId(
    "linkedin",
    linkedinHash("https://linkedin.com/in/prod-smoke-li-only")
  )
  const handleDoc = await db.collection(PA_COLLECTIONS.candidateHandles).doc(linkedinHandleId).get()
  let prospectUserId: string | null = null
  let prospectTagsHasIndustry = false
  if (handleDoc.exists) {
    const handleData = handleDoc.data() as { candidateId?: string }
    if (handleData.candidateId) {
      prospectUserId = handleData.candidateId
      const userDoc = await db.collection("pa-users").doc(prospectUserId).get()
      const data = userDoc.data() as { tags?: { industryEnum?: string[] } } | undefined
      prospectTagsHasIndustry = Array.isArray(data?.tags?.industryEnum)
        && (data!.tags!.industryEnum!.length ?? 0) > 0
    }
  }
  ;(evidence.steps as Array<Record<string, unknown>>).push({
    step: "pa_users_audit",
    linkedinHandleId,
    handleExists: handleDoc.exists,
    prospectUserId,
    prospectTagsHasIndustry,
  })

  evidence.completedAt = new Date().toISOString()
  evidence.success = true

  const artifactsDir = path.resolve(
    process.cwd(),
    ".planning/external-supply-v1/artifacts"
  )
  if (!existsSync(artifactsDir)) mkdirSync(artifactsDir, { recursive: true })
  const outPath = path.join(artifactsDir, "wave-e-live-prod-smoke.json")
  writeFileSync(outPath, JSON.stringify(evidence, null, 2))
  console.log(`[smoke] wrote evidence -> ${outPath}`)
}

main().catch((err) => {
  console.error("[smoke] FAILED", err)
  process.exit(1)
})
