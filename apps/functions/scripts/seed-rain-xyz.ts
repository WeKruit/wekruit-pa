/**
 * One-shot prod seed: rain.xyz company + 26 open jobs.
 *
 * Reads /tmp/rain-seed/jobs.json (produced by the Python parse of
 * rain_open_roles.xlsx) and writes:
 *   - pa-companies/rain-xyz
 *   - matching-jobs/{jobId} as the canonical raw job input for enrichment
 *   - pa-jobs/{jobId} for admin/job workspace metadata
 *
 * Idempotent: uses set({...}, { merge: true }). Re-running updates without
 * dropping unrelated fields.
 *
 * Run:
 *   export GOOGLE_APPLICATION_CREDENTIALS=$(mktemp) && \
 *     grep -E "^FIREBASE_SERVICE_ACCOUNT_JSON=" .env | \
 *     sed 's/^FIREBASE_SERVICE_ACCOUNT_JSON=//' > "$GOOGLE_APPLICATION_CREDENTIALS"
 *   node --import tsx apps/functions/scripts/seed-rain-xyz.ts
 */
import { readFileSync } from "node:fs"
import { initializeApp, applicationDefault, getApps } from "firebase-admin/app"
import { getFirestore, Timestamp } from "firebase-admin/firestore"

interface CompanyDoc {
  companyId: string
  name: string
  domain: string
  industrySector: string[]
  size: string
  competitorCompanies: string[]
  schoolPreferences: string[]
  websiteUrl: string
  careersUrl: string
  description: string
  createdAt: string
}

interface JobDoc {
  jobId: string
  companyId: string
  title: string
  department: string
  roleFunction: string[]
  seniorityLevel: string
  locationBuckets: string[]
  rawLocation: string | null
  jobType: string
  industrySector: string[]
  ashbyJid: string | null
  atsApplyUrl: string | null
  jdRaw: string | null
  salaryMin: number | null
  salaryMax: number | null
  sponsorship: boolean | null
  firstSeenAt: string
  status: string
  source: string
}

const PAYLOAD_PATH = "/tmp/rain-seed/jobs.json"

function nowIso(): string {
  return new Date().toISOString()
}

async function main() {
  if (!getApps().length) {
    initializeApp({ credential: applicationDefault() })
  }
  const db = getFirestore()
  const raw = JSON.parse(readFileSync(PAYLOAD_PATH, "utf8")) as {
    company: CompanyDoc
    jobs: JobDoc[]
  }

  console.log(
    `[seed-rain] writing pa-companies/${raw.company.companyId} + ${raw.jobs.length} jobs...`,
  )

  // Company
  await db
    .collection("pa-companies")
    .doc(raw.company.companyId)
    .set(
      {
        ...raw.company,
        updatedAt: nowIso(),
      },
      { merge: true },
    )

  // Jobs in batches of 100 (Firestore limit is 500 per batch, 100 is safe).
  for (let i = 0; i < raw.jobs.length; i += 100) {
    const slice = raw.jobs.slice(i, i + 100)
    const batch = db.batch()
    for (const job of slice) {
      const paJobRef = db.collection("pa-jobs").doc(job.jobId)
      const matchingJobRef = db.collection("matching-jobs").doc(job.jobId)
      batch.set(
        matchingJobRef,
        matchingJobFromRainJob(job, raw.company.name),
        { merge: true },
      )
      batch.set(
        paJobRef,
        {
          ...job,
          // Mirror v1.6 matching schema field names where they differ from
          // our parsed shape — keeps both sides happy.
          firstSeenAt: job.firstSeenAt,
          updatedAt: nowIso(),
          wekruitCollaborationStatus: "not_collaborated",
          // Matching pipeline reads `dead != true`. Explicit false.
          dead: false,
          // External-supply evaluation reads roleFunction + industrySector.
        },
        { merge: true },
      )
    }
    await batch.commit()
    console.log(`[seed-rain] committed jobs ${i + 1}..${i + slice.length}`)
  }

  // Verify counts
  const companySnap = await db
    .collection("pa-companies")
    .doc(raw.company.companyId)
    .get()
  const jobsSnap = await db
    .collection("pa-jobs")
    .where("companyId", "==", raw.company.companyId)
    .get()
  console.log(
    `[seed-rain] DONE — company exists=${companySnap.exists}, jobs for ${raw.company.companyId}=${jobsSnap.size}`,
  )
  process.exit(0)
}

function matchingJobFromRainJob(job: JobDoc, companyName: string): Record<string, unknown> {
  const salaryRange =
    typeof job.salaryMin === "number" &&
    typeof job.salaryMax === "number" &&
    !isOpenEndedSalarySentinel(job.salaryMin, job.salaryMax)
      ? `$${job.salaryMin}-${job.salaryMax}/yr`
      : null
  return {
    jobId: job.jobId,
    roleTitle: job.title,
    title: job.title,
    companyName,
    companyId: job.companyId,
    jobDescription: job.jdRaw ?? "",
    description: job.jdRaw ?? "",
    locationRaw: job.rawLocation ?? "",
    salaryMin: job.salaryMin ?? null,
    salaryMax: job.salaryMax ?? null,
    ...(salaryRange ? { salaryRange } : {}),
    atsApplyUrl: job.atsApplyUrl ?? null,
    applyUrl: job.atsApplyUrl ?? null,
    status: job.status,
    dead: false,
    source: job.source,
    sourceRepo: "rain_seed",
    contentHash: `${job.jobId}:${job.ashbyJid ?? ""}`,
    roleFunction: job.roleFunction,
    industrySector: job.industrySector,
    seniorityLevel: job.seniorityLevel,
    locationBuckets: job.locationBuckets,
    jobType: job.jobType,
    sponsorship: job.sponsorship,
    updatedAt: nowIso(),
  }
}

function isOpenEndedSalarySentinel(min: number, max: number): boolean {
  return min <= 60_000 && max >= 900_000
}

main().catch((err) => {
  console.error("[seed-rain] FAILED:", err)
  process.exit(1)
})
