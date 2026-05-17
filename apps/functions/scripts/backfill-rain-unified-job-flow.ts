/**
 * Backfill Rain jobs into the unified job flow:
 *   pa-jobs raw seed -> matching-jobs canonical input -> job enrichment draft
 *   -> approval publishes pa-jobs.prescreenConfig and candidate page status.
 *
 * Dry run:
 *   node --import tsx apps/functions/scripts/backfill-rain-unified-job-flow.ts
 *
 * Apply canonical matching docs only:
 *   node --import tsx apps/functions/scripts/backfill-rain-unified-job-flow.ts --apply
 *
 * Apply + generate/approve enrichment drafts:
 *   node --import tsx apps/functions/scripts/backfill-rain-unified-job-flow.ts --apply --approve
 *
 * Rebuild already-published screens:
 *   node --import tsx apps/functions/scripts/backfill-rain-unified-job-flow.ts --apply --approve --force
 */
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { cert, getApps, initializeApp } from "firebase-admin/app"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import {
  runJobEnrichmentApproveDraft,
  runJobEnrichmentRefreshDraft,
} from "../src/job-enrichment.js"

type JobData = Record<string, unknown>

const args = new Set(process.argv.slice(2))
const apply = args.has("--apply")
const approve = args.has("--approve")
const force = args.has("--force")
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="))
const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : Infinity
const actor = "system:rain-unified-job-flow-backfill"

loadEnv()
initFirebase()

const db = getFirestore()

async function main(): Promise<void> {
  const rainJobs = await db.collection("pa-jobs").where("companyId", "==", "rain-xyz").get()
  const rows = rainJobs.docs.slice(0, Number.isFinite(limit) ? limit : rainJobs.docs.length)
  console.log(
    `[rain-unified-flow] jobs=${rainJobs.size} selected=${rows.length} apply=${apply} approve=${approve}`,
  )

  let mirrored = 0
  let draftReady = 0
  let approved = 0
  let skipped = 0

  for (const doc of rows) {
    const data = doc.data()
    const matchingPatch = matchingJobFromPaJob(doc.id, data)
    const currentMatching = await db.collection("matching-jobs").doc(doc.id).get()
    const hasPrescreenConfig = Boolean(data.prescreenConfig)
    console.log(
      `[rain-unified-flow] ${doc.id} title="${String(data.title ?? "")}" matching=${currentMatching.exists} prescreen=${hasPrescreenConfig}`,
    )

    if (apply) {
      await db.collection("matching-jobs").doc(doc.id).set(matchingPatch, { merge: true })
      await db.collection("pa-jobs").doc(doc.id).set(
        {
          wekruitCollaborationStatus: "not_collaborated",
          updatedAt: new Date().toISOString(),
        },
        { merge: true },
      )
      mirrored += 1
    }

    if (!approve) continue
    if (!apply) throw new Error("--approve requires --apply")
    if (hasPrescreenConfig && !force) {
      skipped += 1
      console.log(`[rain-unified-flow] skip approve ${doc.id}; prescreenConfig already exists`)
      continue
    }

    const refreshed = await runJobEnrichmentRefreshDraft(
      { jobId: doc.id },
      {
        db: db as Firestore,
        log: (event, payload) => {
          console.log(`[rain-unified-flow] ${event}`, JSON.stringify(payload ?? {}))
        },
      },
    )
    if (!refreshed.approvalReady) {
      skipped += 1
      console.log(
        `[rain-unified-flow] skip approve ${doc.id}; draft=${refreshed.draftId} status=${refreshed.status}`,
      )
      continue
    }
    draftReady += 1
    await runJobEnrichmentApproveDraft(
      { jobId: doc.id, draftId: refreshed.draftId },
      actor,
      { db: db as Firestore },
    )
    approved += 1
    console.log(`[rain-unified-flow] approved ${doc.id}; draft=${refreshed.draftId}`)
  }

  console.log(
    `[rain-unified-flow] DONE mirrored=${mirrored} draftReady=${draftReady} approved=${approved} skipped=${skipped}`,
  )
}

function matchingJobFromPaJob(jobId: string, job: JobData): Record<string, unknown> {
  const title = str(job.title) ?? str(job.roleTitle) ?? jobId
  const companyName = str(job.companyName) ?? str(job.company) ?? "Rain"
  const jd = str(job.jdRaw) ?? str(job.descriptionMd) ?? str(job.jobDescription) ?? ""
  const locationRaw = str(job.rawLocation) ?? str(job.locationRaw) ?? str(job.location) ?? ""
  const salaryMin = num(job.salaryMin)
  const salaryMax = num(job.salaryMax)
  const salaryRange =
    salaryMin !== null && salaryMax !== null && !isOpenEndedSalarySentinel(salaryMin, salaryMax)
      ? `$${salaryMin}-${salaryMax}/yr`
      : visibleSalaryText(str(job.salaryRange)) ?? undefined

  return {
    jobId,
    roleTitle: title,
    title,
    companyName,
    companyId: str(job.companyId) ?? "rain-xyz",
    jobDescription: jd,
    description: jd,
    locationRaw,
    ...(salaryMin !== null ? { salaryMin } : {}),
    ...(salaryMax !== null ? { salaryMax } : {}),
    ...(salaryRange ? { salaryRange } : {}),
    atsApplyUrl: str(job.atsApplyUrl) ?? null,
    applyUrl: str(job.atsApplyUrl) ?? null,
    status: str(job.status) ?? "active",
    dead: false,
    source: str(job.source) ?? "manual_seed_rain_2026_05_14",
    sourceRepo: "rain_seed",
    contentHash: `${jobId}:${str(job.ashbyJid) ?? ""}`,
    roleFunction: normalizeRoleFunctions(job.roleFunction),
    industrySector: arr(job.industrySector),
    seniorityLevel: normalizeSeniorityLevel(job.seniorityLevel),
    locationBuckets: normalizeLocationBuckets(job.locationBuckets),
    jobType: str(job.jobType) ?? null,
    sponsorship: typeof job.sponsorship === "boolean" ? job.sponsorship : null,
    updatedAt: new Date().toISOString(),
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function isOpenEndedSalarySentinel(min: number, max: number): boolean {
  return min <= 60_000 && max >= 900_000
}

function visibleSalaryText(value: string | undefined): string | undefined {
  if (!value) return undefined
  const compact = value.toLowerCase().replace(/[\s,]/g, "")
  if (/\b999000\b|\b999k\b/.test(compact)) return undefined
  return value
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function normalizeLocationBuckets(value: unknown): string[] {
  const legacyToCanonical: Record<string, string> = {
    new_york: "new_york_metro",
    remote: "remote_united_states",
  }
  return arr(value)
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => legacyToCanonical[item.trim()] ?? item.trim())
}

function normalizeRoleFunctions(value: unknown): string[] {
  const valid = new Set([
    "software_engineering",
    "engineering_and_development",
    "data_analysis",
    "product_management",
    "business_analyst",
    "creatives_and_design",
    "consultant",
    "accounting_and_finance",
    "marketing",
    "management_and_executive",
    "sales",
    "human_resources",
    "legal_and_compliance",
    "arts_and_entertainment",
    "education_and_training",
    "public_sector_and_government",
    "customer_service_and_support",
  ])
  return arr(value)
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim())
    .filter((item) => valid.has(item))
}

function normalizeSeniorityLevel(value: unknown): string | null {
  const seniority = str(value)
  if (!seniority) return null
  if (seniority === "executive") return "c_level"
  const valid = new Set([
    "student",
    "intern",
    "entry_level",
    "junior",
    "mid_level",
    "senior",
    "staff",
    "principal",
    "manager",
    "director",
    "vp",
    "c_level",
    "founder",
  ])
  return valid.has(seniority) ? seniority : null
}

function initFirebase(): void {
  if (getApps().length) return
  const raw =
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON ??
    readEnvValue("FIREBASE_SERVICE_ACCOUNT_JSON")
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON missing")
  initializeApp({ credential: cert(JSON.parse(raw)) })
}

function loadEnv(): void {
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(process.cwd(), ".env"),
    join(process.cwd(), "..", "..", ".env"),
    join(scriptDir, "..", "..", "..", ".env"),
  ]
  for (const path of candidates) {
    if (!existsSync(path)) continue
    const text = readFileSync(path, "utf8")
    for (const line of text.split(/\n/)) {
      if (!line || line.startsWith("#") || !line.includes("=")) continue
      const index = line.indexOf("=")
      const key = line.slice(0, index).trim()
      let value = line.slice(index + 1).trim()
      if (!key || (process.env[key] !== undefined && process.env[key] !== "")) continue
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      process.env[key] = value
      if (key === "OPENAI_API_KEY" && !process.env.PA_OPENAI_AGENT_API_KEY) {
        process.env.PA_OPENAI_AGENT_API_KEY = value
      }
    }
  }
}

function readEnvValue(key: string): string | undefined {
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(process.cwd(), ".env"),
    join(process.cwd(), "..", "..", ".env"),
    join(scriptDir, "..", "..", "..", ".env"),
  ]
  for (const path of candidates) {
    if (!existsSync(path)) continue
    const text = readFileSync(path, "utf8")
    for (const line of text.split(/\n/)) {
      if (!line || line.startsWith("#") || !line.includes("=")) continue
      const index = line.indexOf("=")
      if (line.slice(0, index).trim() !== key) continue
      let value = line.slice(index + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      return value
    }
  }
  return undefined
}

main().catch((err) => {
  console.error("[rain-unified-flow] FAILED", err)
  process.exit(1)
})
