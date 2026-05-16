/**
 * v2.1 S1B — `loadJobBriefForVoice(jobId)`.
 *
 * Read-only projection from `matching-jobs/{jobId}` into `VoiceJobBrief`.
 * Mirrors the field-source chain used in `admin-match-debug.ts`
 * `projectMatchingJob`, so the voice path and the dashboard agree on what
 * the canonical job brief looks like.
 *
 * Contract:
 *  - doc absent → throw `NotFoundError("job", jobId)`
 *  - doc present, fields partial → return what's there + populate
 *    `missingFields: string[]`. `jobTitle` + `companyName` ALWAYS resolve
 *    via the documented fallback chains (or "" if utterly empty — which is
 *    a missingField).
 *  - NEVER writes Firestore. NEVER calls match scorer / LLM.
 */

import type { Firestore } from "firebase-admin/firestore"
import { NotFoundError, type VoiceJobBrief } from "./types.js"

const EXPECTED_FIELDS = [
  "jobTitle",
  "companyName",
  "roleFunction",
  "industrySector",
  "seniorityLevel",
  "salaryMin",
  "salaryMax",
  "locationRaw",
  "locationBuckets",
  "jobType",
  "sponsorship",
  "requiredSkills",
  "atsApplyUrl",
  "firstSeenAt",
] as const

function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function cleanStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const item of value) {
    const s = cleanString(item)
    if (s) out.push(s)
  }
  return out.length > 0 ? out : undefined
}

function readObj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * Load a job's voice-bridge brief.
 *
 * @throws {NotFoundError} when `matching-jobs/{jobId}` does not exist.
 */
export async function loadJobBriefForVoice(
  db: Firestore,
  jobId: string
): Promise<VoiceJobBrief> {
  if (typeof jobId !== "string" || jobId.trim().length === 0) {
    throw new TypeError("loadJobBriefForVoice: jobId must be a non-empty string")
  }
  const snap = await db.collection("matching-jobs").doc(jobId).get()
  if (!snap.exists) {
    throw new NotFoundError("job", jobId)
  }
  const data = (snap.data() ?? {}) as Record<string, unknown>
  const globalTags = readObj(data.globalTags)

  // Title fallback chain — matches admin-match-debug.projectMatchingJob.
  const jobTitle =
    cleanString(data.jobTitle) ??
    cleanString(data.title) ??
    cleanString(data.roleTitle) ??
    ""
  const companyName =
    cleanString(data.companyName) ??
    cleanString(data.companyDisplayName) ??
    ""

  const brief: VoiceJobBrief = {
    jobId,
    jobTitle,
    companyName,
    missingFields: [],
  }

  const roleFunction = cleanStringArray(data.roleFunction)
  if (roleFunction) brief.roleFunction = roleFunction

  const industrySector =
    cleanStringArray(data.industrySector) ??
    cleanStringArray(globalTags.industrySector)
  if (industrySector) brief.industrySector = industrySector

  const seniorityLevel = cleanString(data.seniorityLevel)
  if (seniorityLevel) brief.seniorityLevel = seniorityLevel

  if (typeof data.salaryMin === "number" && Number.isFinite(data.salaryMin)) {
    brief.salaryMin = data.salaryMin
  }
  if (typeof data.salaryMax === "number" && Number.isFinite(data.salaryMax)) {
    brief.salaryMax = data.salaryMax
  }

  const locationRaw = cleanString(data.locationRaw) ?? cleanString(data.location)
  if (locationRaw) brief.locationRaw = locationRaw

  const locationBuckets = cleanStringArray(data.locationBuckets)
  if (locationBuckets) brief.locationBuckets = locationBuckets

  const jobType = cleanString(data.jobType)
  if (jobType) brief.jobType = jobType

  if (typeof data.sponsorship === "boolean") {
    brief.sponsorship = data.sponsorship
  } else if (data.sponsorship === null) {
    brief.sponsorship = null
  }

  const requiredSkills =
    cleanStringArray(data.requiredSkills) ??
    cleanStringArray(globalTags.skills)
  if (requiredSkills) brief.requiredSkills = requiredSkills

  const atsApplyUrl = cleanString(data.atsApplyUrl) ?? cleanString(data.primaryUrl)
  if (atsApplyUrl) brief.atsApplyUrl = atsApplyUrl

  const firstSeenAt = cleanString(data.firstSeenAt)
  if (firstSeenAt) brief.firstSeenAt = firstSeenAt

  if (typeof data.dead === "boolean") brief.dead = data.dead

  // missingFields enumeration.
  const missing: string[] = []
  for (const f of EXPECTED_FIELDS) {
    const present = (() => {
      switch (f) {
        case "jobTitle":
          return brief.jobTitle.length > 0
        case "companyName":
          return brief.companyName.length > 0
        case "roleFunction":
          return brief.roleFunction !== undefined
        case "industrySector":
          return brief.industrySector !== undefined
        case "seniorityLevel":
          return brief.seniorityLevel !== undefined
        case "salaryMin":
          return brief.salaryMin !== undefined
        case "salaryMax":
          return brief.salaryMax !== undefined
        case "locationRaw":
          return brief.locationRaw !== undefined
        case "locationBuckets":
          return brief.locationBuckets !== undefined
        case "jobType":
          return brief.jobType !== undefined
        case "sponsorship":
          // null is a valid "known unknown" — only undefined counts as missing.
          return brief.sponsorship !== undefined
        case "requiredSkills":
          return brief.requiredSkills !== undefined
        case "atsApplyUrl":
          return brief.atsApplyUrl !== undefined
        case "firstSeenAt":
          return brief.firstSeenAt !== undefined
        default:
          return true
      }
    })()
    if (!present) missing.push(f)
  }
  brief.missingFields = missing

  return brief
}
