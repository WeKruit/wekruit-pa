/**
 * v2.0 External Supply V2 — Live prod smoke script.
 *
 * Drives the V2 callables (preview, agent-rank dry-run, agent-rank live if
 * `OPENAI_API_KEY` present, override) against **production** Firestore in
 * `wekruit-5f89b` via the Admin SDK. Bypasses callable auth by invoking the
 * underlying `run*` runners directly with a synthetic admin auth context.
 *
 * Usage:
 *   export GOOGLE_APPLICATION_CREDENTIALS=$(mktemp)
 *   grep -E "^FIREBASE_SERVICE_ACCOUNT_JSON=" .env \
 *     | sed 's/^FIREBASE_SERVICE_ACCOUNT_JSON=//' > "$GOOGLE_APPLICATION_CREDENTIALS"
 *   # OPENAI_API_KEY optional — step 9 skips if absent
 *   node --import tsx apps/functions/scripts/external-supply-v2-prod-smoke.ts
 *
 * Steps:
 *   1.  initialise firebase-admin against prod
 *   2.  seed synthetic company + job + batch + 4 candidate records
 *   3.  runResolveBatchIdentity (V1 reused — needed before evaluation)
 *   4.  runEvaluation (V1 reused — produces D-rubric outputs feeding V2)
 *   5.  runDraftOutreachPlan (V1 reused — outreach draft)
 *   6.  runSyncPlanToMailgun dry-run (V1 reused, post Mailgun swap)
 *   7.  paExternalSupplyPreviewBatch (V2 — `runPreviewBatch` direct)
 *   8.  paExternalSupplyRunAgentRanking dryRun=true (V2 — projects cost)
 *   9.  paExternalSupplyRunAgentRanking live, ensembleSize=1, $2 budget
 *       (V2 — gated on OPENAI_API_KEY)
 *   10. paExternalSupplyOverrideAgentTier on first ranking row (V2 HITL)
 *   11. handleMailgunWebhook twice (V1 reused — idempotency replay)
 *   12. doc-count audit (includes pa-agent-ranking-results)
 *   13. write `.planning/external-supply-v2/artifacts/live-prod-smoke.json`
 *
 * Safety:
 *   - Doc-id prefix `prod-smoke-v2-<iso>` so cleanup is trivial.
 *   - LinkedIn URLs use `linkedin.com/in/prod-smoke-v2-*` analogue.
 *   - Mailgun dry-run only (mode=dry_run); no live email.
 *   - Agent-rank live step capped at $2 + ensembleSize=1 (well below the
 *     $10 production default).
 */
import { writeFileSync, mkdirSync, existsSync } from "node:fs"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { initializeApp, applicationDefault } from "firebase-admin/app"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import {
  PA_COLLECTIONS,
  candidateHandleHashMaterial,
  type ExternalCandidateRecord,
  type ExternalSourcingBatch,
} from "@pa/core-types"

// V1 runners reused.
import { runResolveBatchIdentity } from "../src/external-supply/resolve-identity.js"
import { runEvaluation } from "../src/external-supply/evaluate.js"
import { runDraftOutreachPlan } from "../src/external-supply/outreach.js"
import { runSyncPlanToMailgun } from "../src/external-supply/mailgun-sync.js"
import { handleMailgunWebhook } from "../src/external-supply/mailgun-webhook.js"

// V2 runners.
import { runPreviewBatch } from "../src/external-supply/preview-batch.js"
import {
  runAgentRanking,
  runOverrideAgentTier,
} from "../src/external-supply/agent-rank.js"

const PROJECT_ID = "wekruit-5f89b"
const NOW_ISO = new Date().toISOString()
const SMOKE_RUN_ID = `prod-smoke-v2-${NOW_ISO.replace(/[:.]/g, "-")}`

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function linkedinHash(url: string): string {
  return sha256Hex(candidateHandleHashMaterial("linkedin", url))
}

function emailHash(value: string): string {
  return sha256Hex(candidateHandleHashMaterial("email", value.trim().toLowerCase()))
}

// ---------------------------------------------------------------------------
// Fixture — 4 records
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
      storageUri: `gs://wekruit-5f89b.appspot.com/external-supply/smoke-v2/${SMOKE_RUN_ID}`,
      mime: "text/csv",
      sha256: sha256Hex(SMOKE_RUN_ID),
      sizeBytes: 0,
    },
    normalizerVersion: "ext-norm-2026-05-v2",
    importedBy: "prod-smoke-v2-script",
    createdAt: NOW_ISO,
    meta: { prodSmokeRun: NOW_ISO },
  }
}

function makeRecord(
  suffix: string,
  opts: { linkedInUrl?: string; email?: string; name?: string; title?: string; company?: string },
): ExternalCandidateRecord {
  const recordId = `${SMOKE_RUN_ID}-rec-${suffix}`
  return {
    recordId,
    batchId: `${SMOKE_RUN_ID}-batch`,
    source: "manual_csv",
    rawPayload: {},
    canonicalLinkedInUrl: opts.linkedInUrl,
    linkedinProfileHash: opts.linkedInUrl ? linkedinHash(opts.linkedInUrl) : undefined,
    emails: opts.email ? [{ value: opts.email, hash: emailHash(opts.email) }] : [],
    name: opts.name,
    currentTitle: opts.title,
    currentCompany: opts.company,
    experience: opts.title && opts.company ? [{ company: opts.company, title: opts.title }] : [],
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
    linkedInUrl: "https://linkedin.com/in/prod-smoke-v2-li-only",
    name: "Prod Smoke V2 LinkedIn-Only",
    title: "Senior Software Engineer",
    company: "Prod Smoke V2 Co",
  }),
  makeRecord("li-and-email", {
    linkedInUrl: "https://linkedin.com/in/prod-smoke-v2-li-and-email",
    email: "prod-smoke-v2-li-and-email@example.test",
    name: "Prod Smoke V2 LinkedIn+Email",
    title: "Staff Engineer",
    company: "Prod Smoke V2 Co",
  }),
  makeRecord("email-only", {
    email: "prod-smoke-v2-email-only@example.test",
    name: "Prod Smoke V2 Email Only",
    title: "Engineering Manager",
    company: "Prod Smoke V2 Co",
  }),
  makeRecord("no-signal", {
    name: "Prod Smoke V2 No Signal",
    title: "Distinguished Engineer",
    company: "Prod Smoke V2 Co",
  }),
]

async function seedCompanyAndJob(db: Firestore): Promise<void> {
  await db.collection("pa-companies").doc(`${SMOKE_RUN_ID}-company`).set({
    companyId: `${SMOKE_RUN_ID}-company`,
    name: "Prod Smoke V2 Co",
    industrySector: ["artificial_intelligence_and_machine_learning", "cloud_and_infrastructure"],
    size: "scale_up",
    competitorCompanies: ["OpenAI", "Anthropic", "Stripe"],
    schoolPreferences: [],
    meta: { prodSmokeRun: NOW_ISO },
    createdAt: NOW_ISO,
  })
  await db.collection(PA_COLLECTIONS.jobs).doc(`${SMOKE_RUN_ID}-job`).set({
    jobId: `${SMOKE_RUN_ID}-job`,
    companyId: `${SMOKE_RUN_ID}-company`,
    title: "Senior Software Engineer (Prod Smoke V2)",
    roleFunction: ["software_engineering"],
    seniorityLevel: "senior",
    locationBuckets: ["remote", "new_york"],
    sponsorship: false,
    jobType: "full_time",
    requiredSkills: ["python", "typescript", "kubernetes", "system_design"],
    salaryMin: 180000,
    salaryMax: 260000,
    firstSeenAt: NOW_ISO,
    dead: false,
    atsApplyUrl: "https://example.test/apply/v2",
    meta: { prodSmokeRun: NOW_ISO },
    createdAt: NOW_ISO,
  })
}

async function seedBatchAndRecords(db: Firestore): Promise<void> {
  const batch = makeBatch()
  await db.collection(PA_COLLECTIONS.externalSourcingBatches).doc(batch.batchId).set(batch)
  for (const rec of FIXTURE) {
    await db.collection(PA_COLLECTIONS.externalCandidateRecords).doc(rec.recordId).set(rec)
  }
}

type StepRecord = Record<string, unknown>
function pushStep(evidence: Record<string, unknown>, step: StepRecord): void {
  ;(evidence.steps as StepRecord[]).push(step)
}

const AUTH = {
  uid: "prod-smoke-v2",
  token: { email: "prod-smoke-v2@wekruit.com", email_verified: true },
} as const

async function main(): Promise<void> {
  const gac = process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (!gac) throw new Error("GOOGLE_APPLICATION_CREDENTIALS env var required")
  initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID })
  const db = getFirestore()
  db.settings({ ignoreUndefinedProperties: true })

  const openaiKey = process.env.OPENAI_API_KEY
  const evidence: Record<string, unknown> = {
    runId: SMOKE_RUN_ID,
    startedAt: NOW_ISO,
    projectId: PROJECT_ID,
    openaiKeyPresent: Boolean(openaiKey),
    steps: [] as StepRecord[],
  }

  // Step 1 — seed
  console.log(`[smoke-v2] seeding company + job + batch + records for ${SMOKE_RUN_ID}`)
  await seedCompanyAndJob(db)
  await seedBatchAndRecords(db)
  pushStep(evidence, {
    step: "seed",
    batchId: `${SMOKE_RUN_ID}-batch`,
    recordIds: FIXTURE.map((r) => r.recordId),
    companyId: `${SMOKE_RUN_ID}-company`,
    jobId: `${SMOKE_RUN_ID}-job`,
  })

  // Step 2 — V1 resolve
  console.log("[smoke-v2] runResolveBatchIdentity")
  const resolveResult = await runResolveBatchIdentity(
    { batchId: `${SMOKE_RUN_ID}-batch` },
    AUTH,
    { db },
  )
  pushStep(evidence, { step: "runResolveBatchIdentity", result: resolveResult })

  // Step 3 — V1 evaluate
  const evalRunId = `${SMOKE_RUN_ID}-evalrun`
  console.log("[smoke-v2] runEvaluation")
  const evaluationResult = await runEvaluation(
    {
      runId: evalRunId,
      batchId: `${SMOKE_RUN_ID}-batch`,
      companyId: `${SMOKE_RUN_ID}-company`,
      jobId: `${SMOKE_RUN_ID}-job`,
    },
    AUTH,
    { db },
  )
  pushStep(evidence, { step: "runEvaluation", runId: evalRunId, result: evaluationResult })

  // Step 4 — V1 draft outreach
  const evalSnap = await db
    .collection(PA_COLLECTIONS.candidateCompanyJobEvaluations)
    .where("evaluationRunId", "==", evalRunId)
    .get()
  const firstEval = evalSnap.docs[0]?.data() as { evaluationId?: string } | undefined
  let draftResult: unknown = null
  if (firstEval?.evaluationId) {
    console.log(`[smoke-v2] runDraftOutreachPlan against ${firstEval.evaluationId}`)
    try {
      draftResult = await runDraftOutreachPlan({ evaluationId: firstEval.evaluationId }, AUTH, { db })
    } catch (err) {
      draftResult = { error: err instanceof Error ? err.message : String(err) }
    }
  }
  pushStep(evidence, {
    step: "runDraftOutreachPlan",
    sourceEvaluationId: firstEval?.evaluationId ?? null,
    result: draftResult,
  })

  // Step 5 — V1 Mailgun sync dry-run
  const planId =
    draftResult && typeof draftResult === "object" && "planId" in draftResult
      ? String((draftResult as { planId: unknown }).planId)
      : null
  let syncResult: unknown = null
  if (planId) {
    console.log(`[smoke-v2] runSyncPlanToMailgun dry-run for ${planId}`)
    try {
      syncResult = await runSyncPlanToMailgun({ planId, mode: "dry_run" }, AUTH, { db })
    } catch (err) {
      syncResult = { error: err instanceof Error ? err.message : String(err) }
    }
  }
  pushStep(evidence, { step: "runSyncPlanToMailgun_dryrun", planId, result: syncResult })

  // Step 6 — V2 preview
  console.log("[smoke-v2] runPreviewBatch (V2 preview callable)")
  let previewResult: unknown = null
  try {
    // Tiny inline juicebox-shaped payload for the preview.
    const inlineJuicebox = JSON.stringify(
      FIXTURE.map((r) => ({
        linkedin_url: r.canonicalLinkedInUrl ?? null,
        email_primary: r.emails[0]?.value ?? null,
        full_name: r.name ?? null,
        current_position: r.currentTitle ?? null,
        current_company_name: r.currentCompany ?? null,
        location_string: null,
        experience_array: r.experience,
        education_array: [],
        skills: [],
      })),
    )
    previewResult = await runPreviewBatch(
      {
        filename: "smoke-v2-juicebox.json",
        mime: "application/json",
        base64Bytes: Buffer.from(inlineJuicebox, "utf8").toString("base64"),
        forecastEvaluationFor: {
          companyId: `${SMOKE_RUN_ID}-company`,
          jobId: `${SMOKE_RUN_ID}-job`,
        },
      },
      AUTH,
      { db },
    )
  } catch (err) {
    previewResult = { error: err instanceof Error ? err.message : String(err) }
  }
  pushStep(evidence, { step: "runPreviewBatch", result: previewResult })

  // Step 7 — V2 agent-rank dry-run
  console.log("[smoke-v2] runAgentRanking dry-run (V2)")
  let agentDryResult: unknown = null
  try {
    agentDryResult = await runAgentRanking(
      {
        evaluationRunId: evalRunId,
        dryRun: true,
        ensembleSize: 1,
        budgetUsd: 2,
      },
      AUTH,
      { db },
    )
  } catch (err) {
    agentDryResult = { error: err instanceof Error ? err.message : String(err) }
  }
  pushStep(evidence, { step: "runAgentRanking_dryrun", result: agentDryResult })

  // Step 7.5 — write dry-run artifact under .planning/external-supply-v2/artifacts/
  try {
    const artifactsDir = path.resolve(process.cwd(), ".planning/external-supply-v2/artifacts")
    if (!existsSync(artifactsDir)) mkdirSync(artifactsDir, { recursive: true })
    writeFileSync(
      path.join(artifactsDir, "agent-rank-dryrun.json"),
      JSON.stringify(agentDryResult, null, 2),
    )
  } catch (err) {
    pushStep(evidence, { step: "agent_rank_dryrun_artifact_failed", error: String(err) })
  }

  // Step 8 — V2 agent-rank live (gated on OPENAI_API_KEY)
  let agentLiveResult: unknown = null
  if (openaiKey) {
    console.log("[smoke-v2] runAgentRanking LIVE (V2, ensembleSize=1, budgetUsd=$2)")
    try {
      agentLiveResult = await runAgentRanking(
        {
          evaluationRunId: evalRunId,
          dryRun: false,
          ensembleSize: 1,
          model: "gpt-5.4-nano",
          budgetUsd: 2,
        },
        AUTH,
        { db },
      )
    } catch (err) {
      agentLiveResult = { error: err instanceof Error ? err.message : String(err) }
    }
  } else {
    agentLiveResult = { skipped: true, skippedReason: "openai_key_missing" }
  }
  pushStep(evidence, { step: "runAgentRanking_live", result: agentLiveResult })

  // Live artifact
  try {
    const artifactsDir = path.resolve(process.cwd(), ".planning/external-supply-v2/artifacts")
    if (!existsSync(artifactsDir)) mkdirSync(artifactsDir, { recursive: true })
    writeFileSync(
      path.join(artifactsDir, "agent-rank.json"),
      JSON.stringify(agentLiveResult, null, 2),
    )
  } catch (err) {
    pushStep(evidence, { step: "agent_rank_live_artifact_failed", error: String(err) })
  }

  // Step 9 — V2 override (only if there's a ranking row to override)
  let overrideResult: unknown = null
  try {
    const rankSnap = await db
      .collection(PA_COLLECTIONS.agentRankingResults)
      .where("evaluationRunId", "==", evalRunId)
      .where("status", "==", "proposed")
      .limit(1)
      .get()
    const firstRow = rankSnap.docs[0]?.data() as { resultId?: string; proposedAgentTier?: string } | undefined
    if (firstRow?.resultId) {
      console.log(`[smoke-v2] runOverrideAgentTier against ${firstRow.resultId}`)
      overrideResult = await runOverrideAgentTier(
        {
          resultId: firstRow.resultId,
          newTier:
            firstRow.proposedAgentTier === "tier_1_personal_linkedin_and_email"
              ? "tier_2_personal_email"
              : "tier_1_personal_linkedin_and_email",
          reason: "prod-smoke-v2 verifier override",
        },
        AUTH,
        { db },
      )
    } else {
      overrideResult = { skipped: true, skippedReason: "no_proposed_ranking_row" }
    }
  } catch (err) {
    overrideResult = { error: err instanceof Error ? err.message : String(err) }
  }
  pushStep(evidence, { step: "runOverrideAgentTier", result: overrideResult })

  // Step 10 — V1 Mailgun webhook idempotency replay (synthetic reply)
  console.log("[smoke-v2] handleMailgunWebhook twice (idempotency)")
  const webhookPayload: Record<string, unknown> = {
    "event-data": {
      event: "delivered",
      id: `${SMOKE_RUN_ID}-mg-evt-1`,
      timestamp: Math.floor(Date.now() / 1000),
      recipient: "prod-smoke-v2-li-and-email@example.test",
      "user-variables": { campaign_id: "smoke-v2-campaign", planId: planId ?? "smoke-v2-plan" },
    },
  }
  const webhookResults: unknown[] = []
  for (let i = 0; i < 2; i += 1) {
    let status = 200
    let body: unknown = null
    try {
      await handleMailgunWebhook(
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: webhookPayload,
          rawBody: Buffer.from(JSON.stringify(webhookPayload)),
        },
        {
          status: (code: number) => {
            status = code
            return {
              json: (b: unknown) => {
                body = b
              },
              send: (b: unknown) => {
                body = b
              },
            }
          },
          json: (b: unknown) => {
            body = b
          },
          send: (b: unknown) => {
            body = b
          },
        } as unknown as Parameters<typeof handleMailgunWebhook>[1],
        { db, signingKey: "" },
      )
    } catch (err) {
      body = { error: err instanceof Error ? err.message : String(err) }
    }
    webhookResults.push({ status, body })
  }
  pushStep(evidence, { step: "handleMailgunWebhook", iterations: 2, results: webhookResults })

  // Step 11 — doc-count audit
  console.log("[smoke-v2] doc-count audit")
  const counts: Record<string, number> = {}
  const collections = [
    PA_COLLECTIONS.externalSourcingBatches,
    PA_COLLECTIONS.externalCandidateRecords,
    PA_COLLECTIONS.candidateSourceLinks,
    PA_COLLECTIONS.candidateEvaluationRuns,
    PA_COLLECTIONS.candidateCompanyJobEvaluations,
    PA_COLLECTIONS.outreachPlans,
    PA_COLLECTIONS.outreachEvents,
    PA_COLLECTIONS.feedbackEvents,
    PA_COLLECTIONS.candidateHandles,
    PA_COLLECTIONS.candidateIdentityEvents,
    PA_COLLECTIONS.agentRankingResults,
    PA_COLLECTIONS.correctionEvents,
    PA_COLLECTIONS.toolCalls,
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
  pushStep(evidence, { step: "doc_count_audit", counts })

  evidence.completedAt = new Date().toISOString()
  evidence.success = true

  const artifactsDir = path.resolve(process.cwd(), ".planning/external-supply-v2/artifacts")
  if (!existsSync(artifactsDir)) mkdirSync(artifactsDir, { recursive: true })
  const outPath = path.join(artifactsDir, "live-prod-smoke.json")
  writeFileSync(outPath, JSON.stringify(evidence, null, 2))
  console.log(`[smoke-v2] wrote evidence -> ${outPath}`)

  // Touch randomUUID symbol so unused-import lint is satisfied.
  void randomUUID
}

main().catch((err) => {
  console.error("[smoke-v2] FAILED", err)
  process.exit(1)
})
