/**
 * Dashboard client for the two admin-gated job runners that reuse the SAME
 * runners the Slack agent uses:
 *   - paAdminIntakeJob       → runIntakeJob   (Slack-parity JD enrichment)
 *   - paAdminRediscoverForJob → runRediscoverForJob (silver-medalist reactivation)
 *
 * Mirrors MatchDebug.helpers.ts: typed request builders + a thin httpsCallable
 * wrapper so the request shaping stays testable and the page components stay
 * declarative.
 */
import { httpsCallable } from "firebase/functions"

import { functions } from "./firebase.js"

// ───────────────────────── intake_job (enrich) ─────────────────────────

export interface IntakeJobRequest {
  jobDescription: string
  title?: string
  companyName?: string
  locationRaw?: string
  salaryMin?: number
  salaryMax?: number
  currency?: string
  answers?: string
}

export interface IntakePrescreenQuestion {
  id?: string
  prompt?: string
  type?: string
  weight?: number
  gating?: boolean
  [key: string]: unknown
}

export interface IntakeJobResult {
  enrichedTags?: Record<string, unknown>
  hardFilters?: Record<string, unknown>
  prescreenQuestions?: IntakePrescreenQuestion[]
  confidence?: number
  hitlFlags?: string[]
  clarifyingQuestions?: string[]
  approvalReady?: boolean
  candidateBrief?: unknown
  modelUsed?: string
  note?: string
  error?: string
}

/** Trim blanks + drop empty optionals so the callable gets a clean payload. */
export function buildIntakeJobRequest(input: IntakeJobRequest): IntakeJobRequest {
  const clean = (v: string | undefined): string | undefined => {
    const t = (v ?? "").trim()
    return t.length > 0 ? t : undefined
  }
  const out: IntakeJobRequest = { jobDescription: (input.jobDescription ?? "").trim() }
  const title = clean(input.title)
  if (title) out.title = title
  const companyName = clean(input.companyName)
  if (companyName) out.companyName = companyName
  const locationRaw = clean(input.locationRaw)
  if (locationRaw) out.locationRaw = locationRaw
  if (typeof input.salaryMin === "number" && Number.isFinite(input.salaryMin)) out.salaryMin = input.salaryMin
  if (typeof input.salaryMax === "number" && Number.isFinite(input.salaryMax)) out.salaryMax = input.salaryMax
  const currency = clean(input.currency)
  if (currency) out.currency = currency
  const answers = clean(input.answers)
  if (answers) out.answers = answers
  return out
}

export async function runIntakeJobCallable(input: IntakeJobRequest): Promise<IntakeJobResult> {
  const fn = httpsCallable<IntakeJobRequest, IntakeJobResult>(functions(), "paAdminIntakeJob")
  const res = await fn(buildIntakeJobRequest(input))
  return res.data
}

// ───────────────────────── rediscover_for_job ─────────────────────────

export type RediscoverTier = "tier_1" | "tier_2" | "tier_3"

export interface RediscoverRequest {
  jobId: string
  tiers?: RediscoverTier[]
  limit?: number
}

export interface RediscoverCandidate {
  candidateId: string
  displayName?: string
  finalRank?: number
  finalScore?: number
  softScore?: number
  llmScore?: number
  embeddingScore?: number
  hardFilterResult?: string
  recommendedAction?: "auto_outbound" | "hitl_review" | "do_not_contact"
  globalTier?: string
  tierReusable?: boolean
  reasons?: string[]
  risks?: string[]
}

export interface RediscoverResult {
  direction: "rediscover"
  jobId: string
  job?: { jobId?: string; jobTitle?: string; companyName?: string; roleFunction?: string[] }
  tiers?: string[]
  candidatePool?: { totalLoaded: number; totalReturned: number }
  candidates?: RediscoverCandidate[]
  /** Set when the job isn't in matching-jobs (collab-job support pending). */
  error?: string
}

export function buildRediscoverRequest(jobId: string, tiers?: RediscoverTier[], limit = 20): RediscoverRequest {
  const out: RediscoverRequest = { jobId: jobId.trim(), limit }
  if (tiers && tiers.length > 0) out.tiers = tiers
  return out
}

export async function runRediscoverCallable(
  jobId: string,
  tiers?: RediscoverTier[],
  limit = 20,
): Promise<RediscoverResult> {
  const fn = httpsCallable<RediscoverRequest, RediscoverResult>(functions(), "paAdminRediscoverForJob")
  const res = await fn(buildRediscoverRequest(jobId, tiers, limit))
  return res.data
}
