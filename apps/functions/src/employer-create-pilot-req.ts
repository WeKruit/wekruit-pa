/**
 * employer-create-pilot-req.ts — `paEmployerCreatePilotReq` public onCall.
 *
 * Closes the "intake_job persists nothing" gap. Step 6 ("Calibrate Pilot Req")
 * of the customer-facing employer onboarding wizard
 * (apps/pa-landing/.../EmployerOnboarding.tsx) previously only enriched a role
 * in-memory and advanced the local wizard step — it persisted nothing. This
 * callable takes the ALREADY-ENRICHED result (canonical tags + hard filters +
 * drafted prescreen questions, produced by `paEmployerIntakeJob`) plus the
 * employer-supplied title/JD/company/location and writes a REAL, matchable
 * pilot req using the canonical collab-job DUAL-WRITE pattern proven by
 * `scripts/seed-rain-xyz.ts`:
 *
 *   - matching-jobs/{reqId}  — the matcher's read target (V16 / admin-match-debug
 *     reads `matching-jobs/{jobId}`). status:"active", dead:false, firstSeenAt now,
 *     so it is retrievable + scored by `find_candidates_for_job` immediately.
 *   - pa-jobs/{reqId}        — the recruiter/admin workspace doc. Carries
 *     wekruitCollaborationStatus:"collaborated" so the recruiter board surfaces it.
 *
 * Both docs share ONE stable reqId. The auto-enrich-matching-jobs trigger fires
 * on the matching-jobs write to backfill any missing canonical tags.
 *
 * HONEST SCOPE: writing the dual doc makes the role retrievable + soft-scored on
 * write, but the V16 `llmMatch` term (0.40 weight) is sourced from the nightly
 * rerank cache (`pa-user-rerank-cache`) which has no entry for a brand-new job
 * until `paLlmRerankNightly` (04:00 UTC) backfills it. So reverse matching
 * (find_candidates_for_job) returns scores with llmMatch zeroed (llmCacheStale)
 * until the nightly batch runs. This callable does NOT contact candidates.
 *
 * AUTH: public — mirrors `openRegisterEmployer` / `paEmployerIntakeJob`
 * (cors:true, no auth/app-check gate). The firebase-admin app is initialized
 * globally in index.ts before this module is imported.
 */
import { onCall, HttpsError } from "firebase-functions/v2/https"
import { logger } from "firebase-functions/v2"
import { getFirestore, FieldValue } from "firebase-admin/firestore"

// ---- Wire types (mirror onboarding-api.ts / EmployerIntakeJobOutput) --------

type IntakeSkill = {
  name?: string
  bucket?: string
  proficiency?: string
}

type IntakeEnrichedTags = {
  roleFunction?: string[]
  industrySector?: string[]
  relevantTags?: string[]
  skills?: IntakeSkill[]
  seniorityLevel?: string
  jobType?: string
  locationBuckets?: string[]
}

type IntakeHardFilters = {
  roleFunction?: string[]
  seniorityLevel?: string
  jobType?: string
  locationBuckets?: string[]
  sponsorship?: boolean | null
}

type IntakePrescreenQuestion = {
  id?: string
  prompt?: string
  required?: boolean
  rubricDimensionId?: string
}

export type EmployerCreatePilotReqInput = {
  title: string
  jobDescription: string
  companyName?: string
  locationRaw?: string
  enrichedTags?: IntakeEnrichedTags
  hardFilters?: IntakeHardFilters
  prescreenQuestions?: IntakePrescreenQuestion[]
  successMetric?: string
  /**
   * Lightest viable employer key — the wizard requester's work email. There is
   * no real employer auth on this public flow yet, so we key reqs by the
   * onboarding email (normalized lowercase). Stamped on BOTH the matching-jobs
   * and pa-jobs docs as `createdByEmail` so `paEmployerMyReqs` can list "this
   * employer's reqs" and `paEmployerPassedCandidates` can scope inbox reads.
   * HONEST SCOPE: this email is NOT verified (no magic-link gate here) — it is
   * a self-asserted key, matching the unauthed posture of the wizard CFs.
   */
  employerEmail?: string
  /** Optional org label captured at onboarding (secondary, display only). */
  orgName?: string
}

export type EmployerCreatePilotReqOutput = {
  reqId: string
  status: "pilot_draft"
}

// ---- Helpers ----------------------------------------------------------------

function slugify(value: string, max = 40): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "")
}

function cleanStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item === "string") {
      const t = item.trim()
      if (t) out.push(t)
    }
  }
  return out
}

/**
 * Normalize an employer work email into the stable key used across the
 * onboarding/home/inbox surfaces. Lowercased + trimmed. Returns null when the
 * input is absent or not a plausible email (so we never stamp junk as a key).
 */
export function normalizeEmployerEmail(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim().toLowerCase()
  if (!trimmed) return null
  // Minimal plausibility gate — must look like local@domain.tld.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null
  return trimmed.slice(0, 254)
}

function requiredSkillsFrom(tags?: IntakeEnrichedTags): string[] {
  if (!tags?.skills || !Array.isArray(tags.skills)) return []
  const out: string[] = []
  for (const s of tags.skills) {
    const name = typeof s?.name === "string" ? s.name.trim() : ""
    if (name) out.push(name)
  }
  return out
}

export const paEmployerCreatePilotReq = onCall<EmployerCreatePilotReqInput>(
  {
    region: "us-central1",
    cors: true,
    memory: "512MiB",
    timeoutSeconds: 60,
  },
  async (req): Promise<EmployerCreatePilotReqOutput> => {
    const data = req.data ?? ({} as EmployerCreatePilotReqInput)
    const title = (data.title ?? "").trim()
    const jobDescription = (data.jobDescription ?? "").trim()
    const companyName = (data.companyName ?? "").trim()
    const locationRaw = (data.locationRaw ?? "").trim()

    if (!title) throw new HttpsError("invalid-argument", "title is required")
    if (!jobDescription) throw new HttpsError("invalid-argument", "jobDescription is required")

    const tags = data.enrichedTags ?? {}
    const hardFilters = data.hardFilters ?? {}
    const prescreenQuestions = Array.isArray(data.prescreenQuestions)
      ? data.prescreenQuestions
      : []

    // Canonical axes (prefer hard filters, fall back to enriched tags).
    const roleFunction = cleanStringArray(
      (hardFilters.roleFunction && hardFilters.roleFunction.length > 0
        ? hardFilters.roleFunction
        : tags.roleFunction) ?? [],
    )
    const industrySector = cleanStringArray(tags.industrySector ?? [])
    const seniorityLevel =
      (typeof hardFilters.seniorityLevel === "string" && hardFilters.seniorityLevel.trim()) ||
      (typeof tags.seniorityLevel === "string" && tags.seniorityLevel.trim()) ||
      null
    const jobType =
      (typeof hardFilters.jobType === "string" && hardFilters.jobType.trim()) ||
      (typeof tags.jobType === "string" && tags.jobType.trim()) ||
      null
    const locationBuckets = cleanStringArray(
      (hardFilters.locationBuckets && hardFilters.locationBuckets.length > 0
        ? hardFilters.locationBuckets
        : tags.locationBuckets) ?? [],
    )
    const sponsorship =
      typeof hardFilters.sponsorship === "boolean" ? hardFilters.sponsorship : null
    const requiredSkills = requiredSkillsFrom(tags)
    const relevantTags = cleanStringArray(tags.relevantTags ?? [])

    // Employer scoping key — see EmployerCreatePilotReqInput.employerEmail.
    const createdByEmail = normalizeEmployerEmail(data.employerEmail)
    const orgName = (data.orgName ?? "").trim() || null

    // Mint one stable-ish reqId shared by BOTH docs. Slug for legibility +
    // short random suffix to avoid collisions across re-submits of the same role.
    const companySlug = companyName ? slugify(companyName, 24) : "employer"
    const roleSlug = slugify(title, 32) || "role"
    const suffix = Math.random().toString(36).slice(2, 8)
    const reqId = `wk-pilot-${companySlug}-${roleSlug}-${suffix}`.replace(/-+/g, "-")

    const nowIso = new Date().toISOString()
    const db = getFirestore()

    const matchingJobRef = db.collection("matching-jobs").doc(reqId)
    const paJobRef = db.collection("pa-jobs").doc(reqId)

    // (1) matching-jobs/{reqId} — matcher input. Mirrors matchingJobFromRainJob
    //     field names. status:"active" + dead:false + recent firstSeenAt so V16
    //     hard filters (freshness/liveness) pass and auto-enrich fires.
    const matchingJobDoc: Record<string, unknown> = {
      jobId: reqId,
      roleTitle: title,
      title,
      companyName: companyName || null,
      jobDescription,
      description: jobDescription,
      locationRaw: locationRaw || "",
      atsApplyUrl: null,
      applyUrl: null,
      status: "active",
      dead: false,
      source: "employer_onboarding",
      sourceRepo: "employer_onboarding",
      contentHash: `${reqId}`,
      roleFunction,
      industrySector,
      ...(seniorityLevel ? { seniorityLevel } : {}),
      locationBuckets,
      ...(jobType ? { jobType } : {}),
      sponsorship,
      requiredSkills,
      relevantTags,
      // Collab-flagged so it is both matchable and recognizable as a WeKruit
      // collaborative pilot req on the matching side too.
      wekruitCollaborationStatus: "collaborated",
      isWekruitCollab: true,
      // Employer scoping key (matcher mirror). See EmployerCreatePilotReqInput.
      ...(createdByEmail ? { createdByEmail } : {}),
      ...(orgName ? { orgName } : {}),
      firstSeenAt: nowIso,
      updatedAt: nowIso,
    }

    // (2) pa-jobs/{reqId} — recruiter/admin workspace. Carries the pilot draft
    //     status + the full enriched req (tags, filters, prescreen) for audit.
    const paJobDoc: Record<string, unknown> = {
      jobId: reqId,
      title,
      companyName: companyName || null,
      jobDescription,
      locationRaw: locationRaw || "",
      roleFunction,
      industrySector,
      ...(seniorityLevel ? { seniorityLevel } : {}),
      locationBuckets,
      ...(jobType ? { jobType } : {}),
      sponsorship,
      requiredSkills,
      relevantTags,
      // Pilot-req specifics — the calibrated draft persisted verbatim.
      pilotReq: {
        status: "pilot_draft",
        source: "employer_onboarding",
        enrichedTags: tags,
        hardFilters,
        prescreenQuestions,
        ...(typeof data.successMetric === "string" && data.successMetric.trim()
          ? { successMetric: data.successMetric.trim() }
          : {}),
        createdAt: nowIso,
      },
      status: "pilot_draft",
      source: "employer_onboarding",
      wekruitCollaborationStatus: "collaborated",
      // Employer scoping key (workspace doc). `paEmployerMyReqs` lists by this.
      ...(createdByEmail ? { createdByEmail } : {}),
      ...(orgName ? { orgName } : {}),
      dead: false,
      firstSeenAt: nowIso,
      updatedAt: nowIso,
      createdAt: FieldValue.serverTimestamp(),
    }

    logger.info("paEmployerCreatePilotReq.write", {
      reqId,
      hasCompany: Boolean(companyName),
      hasEmployerKey: Boolean(createdByEmail),
      roleFunction,
      prescreenCount: prescreenQuestions.length,
    })

    const batch = db.batch()
    batch.set(matchingJobRef, matchingJobDoc, { merge: true })
    batch.set(paJobRef, paJobDoc, { merge: true })
    await batch.commit()

    return { reqId, status: "pilot_draft" }
  },
)
