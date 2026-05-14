/**
 * v2.0 External Supply V2 — Live prod smoke script (SKELETON).
 *
 * Per L-G7: this skeleton is greenlit immediately. The V2-only callables
 * (`runPreviewBatch`, `runAgentRanking`, `runOverrideAgentTier`) gate on
 * Executor D's deps-injectable signatures landing. Each such step is marked
 * with a TODO block and a no-op stub so the script compiles end-to-end.
 *
 * Mirrors V1 (`external-supply-prod-smoke.ts`) architecture exactly. The shape
 * of the evidence report is intentionally parallel so the V2 verifier can
 * diff against V1.
 *
 * Usage:
 *   export GOOGLE_APPLICATION_CREDENTIALS=$(mktemp)
 *   grep -E "^FIREBASE_SERVICE_ACCOUNT_JSON=" .env | sed 's/^FIREBASE_SERVICE_ACCOUNT_JSON=//' > "$GOOGLE_APPLICATION_CREDENTIALS"
 *   # OPENAI_API_KEY optional — agent-rank live step (5) is skip-tolerant.
 *   node --import tsx scripts/external-supply-v2-prod-smoke.ts
 *
 * What it does (sequentially, when Wave D lands):
 *   1. Initialises firebase-admin against prod project `wekruit-5f89b`.
 *   2. Seeds ONE small batch (`prod-smoke-v2-<iso>`) plus 6 candidate records
 *      directly in Firestore. Records cover the six key V2 identity outcomes:
 *      LinkedIn-only, LinkedIn+email, email-only, no-signal, fuzzy-blocked,
 *      LinkedIn<->email mismatch.
 *   3. Calls `runPreviewBatch` (V2 — Wave C) against that batch to validate
 *      the preview pane before commit. (TODO: gated on C merge.)
 *   4. Calls `runResolveBatchIdentity` (V1 reused) against the batch and
 *      captures counters + on-disk record statuses.
 *   5. Calls `runEvaluation` (V1 reused, deterministic rubric pass).
 *   6. Calls `runAgentRanking` in **dry-run** mode against the eval run
 *      (V2 — Wave D). Skip-tolerant if `OPENAI_API_KEY` is unset.
 *      (TODO: gated on D merge.)
 *   7. Calls `runAgentRanking` in **live** mode for one row if API key set;
 *      otherwise records `skipped: missing_openai_key`.
 *      (TODO: gated on D merge.)
 *   8. Calls `runOverrideAgentTier` against one agent-ranking result row to
 *      validate the HITL override + correction-event audit.
 *      (TODO: gated on D merge.)
 *   9. Calls `runDraftOutreachPlan` (V1 reused).
 *  10. Calls `runSyncPlanToMailgun` in **dry_run** mode (V1 reused, post
 *      Mailgun swap).
 *  11. Replays one `handleMailgunWebhook` reply event for idempotency.
 *  12. Reads back doc counts on every external-supply collection touched
 *      (V1 set plus `pa-agent-ranking-results`).
 *  13. Writes a compact JSON evidence report to
 *      `.planning/external-supply-v2/artifacts/wave-e-live-prod-smoke.json`.
 *
 * What it does NOT do:
 *   - Email outbound. Mailgun client invoked only via `dry_run` mode.
 *   - Persist the test batch beyond the run; every doc tagged with
 *     `meta.prodSmokeRun: <isoTs>` for later cleanup.
 *
 * Safety:
 *   - All doc ids prefixed `prod-smoke-v2-` so they cannot collide with V1
 *     prod-smoke or real traffic.
 *   - LinkedIn URLs use the `example.test` analogue
 *     (`linkedin.com/in/prod-smoke-v2-*`) so rows are obviously synthetic.
 *   - No emails sent. Mailgun client mocked at call site via dry_run mode.
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { initializeApp, applicationDefault } from "firebase-admin/app"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import {
  PA_COLLECTIONS,
  candidateHandleHashMaterial,
  type ExternalCandidateRecord,
  type ExternalSourcingBatch,
} from "@pa/core-types"

// V1 runners reused verbatim. V2-only runners (preview / agent-rank /
// override) are deferred — see TODO blocks in `main()`.
import { runResolveBatchIdentity } from "../src/external-supply/resolve-identity.js"
import { runEvaluation } from "../src/external-supply/evaluate.js"
import { runDraftOutreachPlan } from "../src/external-supply/outreach.js"

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
  return sha256Hex(candidateHandleHashMaterial("email", value))
}

// ---------------------------------------------------------------------------
// Fixture — 6 records covering V2 identity outcomes
// ---------------------------------------------------------------------------

function makeBatch(): ExternalSourcingBatch {
  return {
    batchId: `${SMOKE_RUN_ID}-batch`,
    source: "manual_csv",
    companyId: `${SMOKE_RUN_ID}-company`,
    jobId: `${SMOKE_RUN_ID}-job`,
    status: "normalized",
    rowCount: 6,
    validLinkedInCount: 4,
    validEmailCount: 4,
    duplicateCount: 0,
    needsReviewCount: 0,
    readyToProfileCount: 6,
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
  opts: {
    linkedInUrl?: string
    email?: string
    name?: string
    title?: string
    company?: string
  }
): ExternalCandidateRecord {
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
    experience:
      opts.title && opts.company
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
  makeRecord("fuzzy-blocked", {
    name: "Prod Smoke V2 Fuzzy Blocked",
    title: "Software Engineer",
    company: "Prod Smoke V2 Co",
  }),
  makeRecord("mismatch", {
    linkedInUrl: "https://linkedin.com/in/prod-smoke-v2-mismatch-li",
    email: "prod-smoke-v2-mismatch-email@example.test",
    name: "Prod Smoke V2 Mismatch",
    title: "Principal Engineer",
    company: "Prod Smoke V2 Co",
  }),
]

// ---------------------------------------------------------------------------
// Synthetic job/company so evaluation has context to read
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Step helpers
// ---------------------------------------------------------------------------

type StepRecord = Record<string, unknown>

function pushStep(evidence: Record<string, unknown>, step: StepRecord): void {
  ;(evidence.steps as StepRecord[]).push(step)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const gac = process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (!gac) throw new Error("GOOGLE_APPLICATION_CREDENTIALS env var required")
  initializeApp({
    credential: applicationDefault(),
    projectId: PROJECT_ID,
  })
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

  // Step 1 — seed synthetic context
  console.log(`[smoke-v2] seeding company + job + batch + records for run ${SMOKE_RUN_ID}`)
  await seedCompanyAndJob(db)
  await seedBatchAndRecords(db)
  pushStep(evidence, {
    step: "seed",
    batchId: `${SMOKE_RUN_ID}-batch`,
    recordIds: FIXTURE.map((r) => r.recordId),
    companyId: `${SMOKE_RUN_ID}-company`,
    jobId: `${SMOKE_RUN_ID}-job`,
  })

  // Step 2 — runPreviewBatch (V2 — Wave C)
  // TODO(wave-c): import { runPreviewBatch } from "../src/external-supply/preview-batch.js"
  //   const previewResult = await runPreviewBatch(
  //     { batchId: `${SMOKE_RUN_ID}-batch` },
  //     { uid: "prod-smoke-v2", token: { email: "prod-smoke-v2@wekruit.com", email_verified: true } },
  //     { db }
  //   )
  //   pushStep(evidence, { step: "runPreviewBatch", result: previewResult })
  pushStep(evidence, {
    step: "runPreviewBatch",
    status: "skipped",
    reason: "wave_c_not_merged",
  })

  // Step 3 — runResolveBatchIdentity (V1 reused)
  console.log("[smoke-v2] runResolveBatchIdentity")
  const resolveResult = await runResolveBatchIdentity(
    { batchId: `${SMOKE_RUN_ID}-batch` },
    { uid: "prod-smoke-v2", token: { email: "prod-smoke-v2@wekruit.com", email_verified: true } },
    { db }
  )
  pushStep(evidence, { step: "runResolveBatchIdentity", result: resolveResult })

  // Step 4 — runEvaluation (V1 reused, deterministic rubric)
  console.log("[smoke-v2] runEvaluation")
  const evalRunId = `${SMOKE_RUN_ID}-evalrun`
  const evaluationResult = await runEvaluation(
    {
      runId: evalRunId,
      batchId: `${SMOKE_RUN_ID}-batch`,
      companyId: `${SMOKE_RUN_ID}-company`,
      jobId: `${SMOKE_RUN_ID}-job`,
    },
    { uid: "prod-smoke-v2", token: { email: "prod-smoke-v2@wekruit.com", email_verified: true } },
    { db }
  )
  pushStep(evidence, { step: "runEvaluation", runId: evalRunId, result: evaluationResult })

  // Step 5 — runAgentRanking dry-run (V2 — Wave D)
  // TODO(wave-d): import { runAgentRanking } from "../src/external-supply/agent-rank.js"
  //   const agentDryResult = await runAgentRanking(
  //     {
  //       evaluationRunId: evalRunId,
  //       companyId: `${SMOKE_RUN_ID}-company`,
  //       jobId: `${SMOKE_RUN_ID}-job`,
  //       mode: "dry_run",
  //     },
  //     { uid: "prod-smoke-v2", token: { email: "prod-smoke-v2@wekruit.com", email_verified: true } },
  //     { db, openai: undefined }
  //   )
  //   pushStep(evidence, { step: "runAgentRanking_dryrun", result: agentDryResult })
  pushStep(evidence, {
    step: "runAgentRanking_dryrun",
    status: "skipped",
    reason: "wave_d_not_merged",
  })

  // Step 6 — runAgentRanking live (V2 — Wave D, skip-tolerant per L-G2)
  // TODO(wave-d): conditional on OPENAI_API_KEY
  if (openaiKey) {
    // TODO(wave-d): import { runAgentRanking } from "../src/external-supply/agent-rank.js"
    //   const agentLiveResult = await runAgentRanking(
    //     {
    //       evaluationRunId: evalRunId,
    //       companyId: `${SMOKE_RUN_ID}-company`,
    //       jobId: `${SMOKE_RUN_ID}-job`,
    //       mode: "live",
    //       maxRecords: 1,
    //     },
    //     { uid: "prod-smoke-v2", token: { email: "prod-smoke-v2@wekruit.com", email_verified: true } },
    //     { db, openai: undefined /* TODO inject OpenAI client */ }
    //   )
    //   pushStep(evidence, { step: "runAgentRanking_live", result: agentLiveResult })
    pushStep(evidence, {
      step: "runAgentRanking_live",
      status: "skipped",
      reason: "wave_d_not_merged",
    })
  } else {
    pushStep(evidence, {
      step: "runAgentRanking_live",
      status: "skipped",
      reason: "missing_openai_key",
    })
  }

  // Step 7 — runOverrideAgentTier (V2 — Wave D HITL)
  // TODO(wave-d): import { runOverrideAgentTier } from "../src/external-supply/agent-rank.js"
  //   const overrideResult = await runOverrideAgentTier(
  //     {
  //       resultId: "<resolved from step 5 output>",
  //       overrideTier: "must_outreach",
  //       reason: "prod-smoke-v2 verifier override",
  //     },
  //     { uid: "prod-smoke-v2", token: { email: "prod-smoke-v2@wekruit.com", email_verified: true } },
  //     { db }
  //   )
  //   pushStep(evidence, { step: "runOverrideAgentTier", result: overrideResult })
  pushStep(evidence, {
    step: "runOverrideAgentTier",
    status: "skipped",
    reason: "wave_d_not_merged",
  })

  // Step 8 — find an evaluation row + draft outreach (V1 reused)
  const evalSnap = await db
    .collection(PA_COLLECTIONS.candidateCompanyJobEvaluations)
    .where("evaluationRunId", "==", evalRunId)
    .get()
  const firstEval = evalSnap.docs[0]?.data() as { evaluationId?: string } | undefined
  let draftResult: unknown = null
  if (firstEval?.evaluationId) {
    console.log(`[smoke-v2] runDraftOutreachPlan against ${firstEval.evaluationId}`)
    try {
      draftResult = await runDraftOutreachPlan(
        { evaluationId: firstEval.evaluationId },
        { uid: "prod-smoke-v2", token: { email: "prod-smoke-v2@wekruit.com", email_verified: true } },
        { db }
      )
    } catch (err) {
      draftResult = { error: err instanceof Error ? err.message : String(err) }
    }
  }
  pushStep(evidence, {
    step: "runDraftOutreachPlan",
    sourceEvaluationId: firstEval?.evaluationId ?? null,
    result: draftResult,
  })

  // Step 9 — runSyncPlanToMailgun dry-run (V1 reused post Mailgun swap)
  // TODO(wave-?): if the Mailgun sync runner is exposed under a different
  //   import path post-swap, update here. For now this step records the
  //   pending-Mailgun status to keep the evidence shape stable.
  pushStep(evidence, {
    step: "runSyncPlanToMailgun_dryrun",
    status: "skipped",
    reason: "mailgun_runner_import_pending",
  })

  // Step 10 — Mailgun webhook idempotency (V1 reused post Mailgun swap)
  pushStep(evidence, {
    step: "handleMailgunWebhook_idempotency",
    status: "skipped",
    reason: "mailgun_runner_import_pending",
  })

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
    // V2 addition — Wave A's PA_COLLECTIONS.agentRankingResults
    // ("pa-agent-ranking-results"). Reference dynamically so the script
    // tolerates pre-Wave-A core-types versions.
    ((PA_COLLECTIONS as unknown as Record<string, string>).agentRankingResults
      ?? "pa-agent-ranking-results"),
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

  const artifactsDir = path.resolve(
    process.cwd(),
    ".planning/external-supply-v2/artifacts"
  )
  if (!existsSync(artifactsDir)) mkdirSync(artifactsDir, { recursive: true })
  const outPath = path.join(artifactsDir, "wave-e-live-prod-smoke.json")
  writeFileSync(outPath, JSON.stringify(evidence, null, 2))
  console.log(`[smoke-v2] wrote evidence -> ${outPath}`)
}

main().catch((err) => {
  console.error("[smoke-v2] FAILED", err)
  process.exit(1)
})
