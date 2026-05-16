import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { initializeApp, cert, applicationDefault, getApps } from "firebase-admin/app"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS, type CandidateCompanyJobEvaluation } from "@pa/core-types"
import { runEvaluation } from "../src/external-supply/evaluate.js"
import {
  runApproveOutreachPlan,
  runAssignManualLinkedInTask,
  runDraftOutreachPlan,
} from "../src/external-supply/outreach.js"
import { runSyncPlanToMailgun } from "../src/external-supply/mailgun-sync.js"

const PROJECT_ID = "wekruit-5f89b"
const DEFAULT_BATCH_ID = "81395d47-3da9-4485-8025-fcdc79a4aa93"
const DEFAULT_COMPANY_ID = "rain-xyz"
const DEFAULT_JOB_ID = "rain-backend-engineer-482b165f"

const AUTH = {
  uid: "external-supply-existing-batch-verify",
  token: {
    email: "external-supply-existing-batch-verify@wekruit.com",
    email_verified: true,
  },
} as const

type Step = Record<string, unknown>

function nowIso(): string {
  return new Date().toISOString()
}

function initFirebase(): void {
  if (getApps().length > 0) return
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    initializeApp({
      credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)),
      projectId: PROJECT_ID,
    })
    return
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    initializeApp({
      credential: cert(JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"))),
      projectId: PROJECT_ID,
    })
    return
  }
  initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID })
}

async function collectionCount(db: Firestore, collectionName: string): Promise<number> {
  const snap = await db.collection(collectionName).count().get()
  return snap.data().count
}

async function loadEvaluations(db: Firestore, evaluationRunId: string): Promise<CandidateCompanyJobEvaluation[]> {
  const snap = await db
    .collection(PA_COLLECTIONS.candidateCompanyJobEvaluations)
    .where("evaluationRunId", "==", evaluationRunId)
    .get()
  return snap.docs.map((doc) => doc.data() as CandidateCompanyJobEvaluation)
}

function tierRank(tier: string): number {
  switch (tier) {
    case "tier_1_personal_linkedin_and_email":
      return 5
    case "tier_2_personal_email":
      return 4
    case "tier_3_general_email":
      return 3
    case "retain_only":
      return 2
    case "blocked":
      return 1
    default:
      return 0
  }
}

function pickOutreachCandidate(evaluations: CandidateCompanyJobEvaluation[]): CandidateCompanyJobEvaluation | null {
  const sorted = [...evaluations].sort((a, b) => {
    const tierDelta = tierRank(b.proposedTier) - tierRank(a.proposedTier)
    if (tierDelta !== 0) return tierDelta
    return (b.softScore ?? 0) - (a.softScore ?? 0)
  })
  return sorted.find((evaluation) => evaluation.proposedTier !== "blocked") ?? sorted[0] ?? null
}

async function main(): Promise<void> {
  initFirebase()
  const db = getFirestore()
  db.settings({ ignoreUndefinedProperties: true })

  const batchId = process.env.EXTERNAL_SUPPLY_VERIFY_BATCH_ID ?? DEFAULT_BATCH_ID
  const companyId = process.env.EXTERNAL_SUPPLY_VERIFY_COMPANY_ID ?? DEFAULT_COMPANY_ID
  const jobId = process.env.EXTERNAL_SUPPLY_VERIFY_JOB_ID ?? DEFAULT_JOB_ID
  const runId =
    process.env.EXTERNAL_SUPPLY_VERIFY_RUN_ID ??
    `verify-ext-${jobId}-${nowIso().replace(/[:.]/g, "-")}`
  const startedAt = nowIso()

  const evidence: Record<string, unknown> = {
    runId,
    startedAt,
    projectId: PROJECT_ID,
    batchId,
    companyId,
    jobId,
    steps: [] as Step[],
  }
  const steps = evidence.steps as Step[]

  const usersBefore = await collectionCount(db, PA_COLLECTIONS.users)
  steps.push({ step: "pa_users_before", count: usersBefore })

  const batchSnap = await db.collection(PA_COLLECTIONS.externalSourcingBatches).doc(batchId).get()
  if (!batchSnap.exists) throw new Error(`Missing external sourcing batch: ${batchId}`)
  const batch = batchSnap.data() ?? {}
  steps.push({
    step: "batch_loaded",
    status: batch.status,
    rowCount: batch.rowCount,
    readyToProfileCount: batch.readyToProfileCount,
    source: batch.source,
    batchJobId: batch.jobId,
    batchCompanyId: batch.companyId,
  })

  const recordsSnap = await db
    .collection(PA_COLLECTIONS.externalCandidateRecords)
    .where("batchId", "==", batchId)
    .get()
  const recordStatusCounts: Record<string, number> = {}
  let resolvedRecordCount = 0
  for (const doc of recordsSnap.docs) {
    const data = doc.data()
    const status = String(data.identityResolutionStatus ?? "(none)")
    recordStatusCounts[status] = (recordStatusCounts[status] ?? 0) + 1
    if (typeof data.resolvedUserId === "string" && data.resolvedUserId.length > 0) {
      resolvedRecordCount += 1
    }
  }
  steps.push({
    step: "records_loaded",
    count: recordsSnap.size,
    resolvedRecordCount,
    identityResolutionStatus: recordStatusCounts,
  })
  if (resolvedRecordCount === 0) {
    throw new Error(`Batch ${batchId} has no resolvedUserId records; refusing to create new pa-users`)
  }

  const evaluationResult = await runEvaluation(
    { runId, batchId, companyId, jobId },
    AUTH,
    { db, now: nowIso },
  )
  steps.push({ step: "run_evaluation", result: evaluationResult })

  const evaluations = await loadEvaluations(db, runId)
  steps.push({
    step: "evaluations_loaded",
    count: evaluations.length,
    tierBreakdown: evaluations.reduce<Record<string, number>>((acc, evaluation) => {
      acc[evaluation.proposedTier] = (acc[evaluation.proposedTier] ?? 0) + 1
      return acc
    }, {}),
  })
  if (evaluations.length === 0) throw new Error(`Evaluation run ${runId} produced no evaluations`)

  const selectedEvaluation = pickOutreachCandidate(evaluations)
  if (!selectedEvaluation) throw new Error(`No evaluation available for outreach plan in ${runId}`)
  steps.push({
    step: "selected_evaluation",
    evaluationId: selectedEvaluation.evaluationId,
    candidateId: selectedEvaluation.candidateId,
    proposedTier: selectedEvaluation.proposedTier,
    softScore: selectedEvaluation.softScore,
    hardBlocks: selectedEvaluation.hardBlocks,
    reasons: selectedEvaluation.reasons,
  })

  const draftResult = await runDraftOutreachPlan(
    {
      evaluationId: selectedEvaluation.evaluationId,
      copyOverrides: {
        personalizedHook: "Your recent backend and crypto infrastructure work stood out in this sourcing batch.",
        whyThisRole: "Rain is evaluating backend engineers for wallet and payment infrastructure work.",
        whyCompany: "Rain builds infrastructure around stablecoin and card payments.",
        candidateSpecificSignal: "External-supply verification run selected this profile from an existing resolved Rain batch.",
        emailSubject: "Rain backend role",
        emailBody: "Hi, this is Claire from WeKruit. Your backend and crypto infrastructure background may fit a Rain backend role. Open to a quick screen?",
        linkedinMessage: "Hi, this is Claire from WeKruit. Your backend and crypto infrastructure background may fit a Rain backend role. Open to a quick screen?",
      },
    },
    AUTH,
    {
      db,
      now: nowIso,
      generateCopy: async () => ({
        personalizedHook: "Existing resolved external-supply profile matched the Rain backend role.",
      }),
    },
  )
  steps.push({ step: "draft_outreach_plan", result: draftResult })

  const approveResult = await runApproveOutreachPlan(
    { planId: draftResult.planId },
    AUTH,
    { db, now: nowIso },
  )
  steps.push({ step: "approve_outreach_plan", result: approveResult })

  let manualLinkedInResult: unknown = { skipped: true, reason: "plan tier is not tier_1" }
  if (draftResult.tier === "tier_1_personal_linkedin_and_email") {
    manualLinkedInResult = await runAssignManualLinkedInTask(
      { planId: draftResult.planId, assignee: "adam" },
      AUTH,
      { db, now: nowIso },
    )
  }
  steps.push({ step: "manual_linkedin_task", result: manualLinkedInResult })

  let mailgunDryRunResult: unknown
  try {
    mailgunDryRunResult = await runSyncPlanToMailgun(
      { planId: draftResult.planId, mode: "dry_run" },
      AUTH,
      { db, now: nowIso },
    )
  } catch (error) {
    mailgunDryRunResult = {
      error: error instanceof Error ? error.message : String(error),
    }
  }
  steps.push({ step: "mailgun_dry_run_or_suppression", result: mailgunDryRunResult })

  const usersAfter = await collectionCount(db, PA_COLLECTIONS.users)
  steps.push({ step: "pa_users_after", count: usersAfter })
  if (usersAfter !== usersBefore) {
    throw new Error(`pa-users count changed during verification: ${usersBefore} -> ${usersAfter}`)
  }

  evidence.completedAt = nowIso()
  evidence.success = true

  const artifactDir = path.resolve(process.cwd(), ".planning/external-supply-existing-batch/artifacts")
  mkdirSync(artifactDir, { recursive: true })
  const artifactPath = path.join(artifactDir, `${runId}.json`)
  writeFileSync(artifactPath, `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(JSON.stringify({ ok: true, artifactPath, runId, usersBefore, usersAfter }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exit(1)
})
