/**
 * v2.1 S1B — `loadUserProfileForVoice(userId)`.
 *
 * Read-only projection from `pa-users/{userId}` (top-level + `tags` map)
 * into the minimal `VoiceUserProfile` shape S2 voice bridge needs.
 *
 * Contract:
 *  - doc absent → throw `NotFoundError("user", userId)`
 *  - doc present, fields partial → return what's there + populate
 *    `missingFields: string[]` enumerating the absent canonical fields the
 *    voice path expected to find
 *  - NEVER writes Firestore. NEVER touches mergeUserTags / onboarding /
 *    prescreen state. NEVER calls an LLM.
 *
 * Source-of-truth crosswalk:
 *  - top-level: displayName, phoneE164, email, candidateLifecycleState,
 *    piiConsentAt, contactPII.consentedAt, tagsUpdatedAt, updatedAt
 *  - tags.*: preferredLang, targetRoleFunction, skills, recentRoleTitle,
 *    recentCompany, workHistorySummary, yoeRange, visaStatus, targetLocations,
 *    minSalary, industrySector, relevantIndustry
 */

import type { Firestore } from "firebase-admin/firestore"
import { NotFoundError, type VoiceUserProfile } from "./types.js"

/**
 * Set of `tags.*` field names the voice path looks for. Used to compute
 * `missingFields` for telemetry. Order matters only for stable test output.
 */
const EXPECTED_TAG_FIELDS = [
  "preferredLang",
  "targetRoleFunction",
  "skills",
  "recentRoleTitle",
  "recentCompany",
  "workHistorySummary",
  "yoeRange",
  "visaStatus",
  "targetLocations",
  "industrySector",
  "relevantIndustry",
] as const

/** Top-level `pa-users/{uid}` fields the voice path expects. */
const EXPECTED_TOPLEVEL_FIELDS = [
  "displayName",
  "phoneE164",
  "candidateLifecycleState",
  "piiConsentAt",
] as const

function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function readTagsMap(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function pickPreferredLang(raw: unknown): "zh" | "en" | undefined {
  return raw === "zh" || raw === "en" ? raw : undefined
}

function pickStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: string[] = []
  for (const item of raw) {
    const s = cleanString(item)
    if (s) out.push(s)
  }
  return out.length > 0 ? out : undefined
}

function pickSkillEntries(raw: unknown): VoiceUserProfile["skills"] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: NonNullable<VoiceUserProfile["skills"]> = []
  for (const item of raw) {
    if (typeof item === "string") {
      const name = cleanString(item)
      if (name) out.push({ name })
      continue
    }
    if (item && typeof item === "object") {
      const obj = item as Record<string, unknown>
      const name = cleanString(obj.name)
      if (!name) continue
      const entry: NonNullable<VoiceUserProfile["skills"]>[number] = { name }
      if (typeof obj.bucket === "string") entry.bucket = obj.bucket
      if (typeof obj.proficiency === "string") entry.proficiency = obj.proficiency
      if (typeof obj.evidenceCount === "number") entry.evidenceCount = obj.evidenceCount
      if (typeof obj.baseWeight === "number") entry.baseWeight = obj.baseWeight
      out.push(entry)
    }
  }
  return out.length > 0 ? out : undefined
}

function pickYoeRange(raw: unknown): [number, number] | undefined {
  if (!Array.isArray(raw) || raw.length !== 2) return undefined
  const [lo, hi] = raw
  if (typeof lo !== "number" || typeof hi !== "number") return undefined
  return [lo, hi]
}

/**
 * Load a candidate's voice-bridge context shape.
 *
 * @throws {NotFoundError} when `pa-users/{userId}` does not exist.
 */
export async function loadUserProfileForVoice(
  db: Firestore,
  userId: string
): Promise<VoiceUserProfile> {
  if (typeof userId !== "string" || userId.trim().length === 0) {
    throw new TypeError("loadUserProfileForVoice: userId must be a non-empty string")
  }
  const snap = await db.collection("pa-users").doc(userId).get()
  if (!snap.exists) {
    throw new NotFoundError("user", userId)
  }
  const data = (snap.data() ?? {}) as Record<string, unknown>
  const tags = readTagsMap(data.tags)

  const profile: VoiceUserProfile = {
    userId,
    missingFields: [],
  }

  // Top-level identity / display.
  const displayName = cleanString(data.displayName)
  if (displayName) profile.displayName = displayName
  const phoneE164 = cleanString(data.phoneE164)
  if (phoneE164) profile.phoneE164 = phoneE164
  const email = cleanString(data.email)
  if (email) profile.email = email
  const lifecycle = cleanString(data.candidateLifecycleState)
  if (lifecycle) profile.lifecycleState = lifecycle

  // PII consent — top-level field wins, fall back to nested contactPII.consentedAt
  const piiConsent =
    cleanString(data.piiConsentAt) ??
    cleanString(
      (data.contactPII && typeof data.contactPII === "object"
        ? (data.contactPII as Record<string, unknown>).consentedAt
        : undefined)
    )
  if (piiConsent) profile.piiConsentAt = piiConsent

  // Tags-derived durable facts.
  const preferredLang = pickPreferredLang(tags.preferredLang)
  if (preferredLang) profile.preferredLang = preferredLang
  const targetRoleFunction = pickStringArray(tags.targetRoleFunction)
  if (targetRoleFunction) profile.targetRoleFunction = targetRoleFunction
  const skills = pickSkillEntries(tags.skills)
  if (skills) profile.skills = skills
  const recentRoleTitle = cleanString(tags.recentRoleTitle)
  if (recentRoleTitle) profile.recentRoleTitle = recentRoleTitle
  const recentCompany = cleanString(tags.recentCompany)
  if (recentCompany) profile.recentCompany = recentCompany
  const workHistorySummary = cleanString(tags.workHistorySummary)
  if (workHistorySummary) profile.workHistorySummary = workHistorySummary
  const yoeRange = pickYoeRange(tags.yoeRange)
  if (yoeRange) profile.yoeRange = yoeRange
  const visaStatus = cleanString(tags.visaStatus)
  if (visaStatus) profile.visaStatus = visaStatus
  const targetLocations = pickStringArray(tags.targetLocations)
  if (targetLocations) profile.targetLocations = targetLocations
  if (typeof tags.minSalary === "number" && Number.isFinite(tags.minSalary)) {
    profile.minSalary = tags.minSalary
  }
  const industrySector = pickStringArray(tags.industrySector)
  if (industrySector) profile.industrySector = industrySector
  const relevantIndustry = pickStringArray(tags.relevantIndustry)
  if (relevantIndustry) profile.relevantIndustry = relevantIndustry

  // Bookkeeping.
  const tagsUpdatedAt =
    cleanString(data.tagsUpdatedAt) ?? cleanString(data.updatedAt)
  if (tagsUpdatedAt) profile.tagsUpdatedAt = tagsUpdatedAt

  // Compute missingFields. Anything in EXPECTED_* not present on the
  // projection is missing. We compute against the projection (not the raw
  // doc) so the result faithfully tells S2 "what voice expected but did not
  // receive".
  const missing: string[] = []
  for (const f of EXPECTED_TOPLEVEL_FIELDS) {
    // map canonical doc field → projection field
    if (f === "displayName" && !profile.displayName) missing.push("displayName")
    else if (f === "phoneE164" && !profile.phoneE164) missing.push("phoneE164")
    else if (f === "candidateLifecycleState" && !profile.lifecycleState)
      missing.push("candidateLifecycleState")
    else if (f === "piiConsentAt" && !profile.piiConsentAt) missing.push("piiConsentAt")
  }
  for (const f of EXPECTED_TAG_FIELDS) {
    const present = (() => {
      switch (f) {
        case "preferredLang":
          return profile.preferredLang !== undefined
        case "targetRoleFunction":
          return profile.targetRoleFunction !== undefined
        case "skills":
          return profile.skills !== undefined
        case "recentRoleTitle":
          return profile.recentRoleTitle !== undefined
        case "recentCompany":
          return profile.recentCompany !== undefined
        case "workHistorySummary":
          return profile.workHistorySummary !== undefined
        case "yoeRange":
          return profile.yoeRange !== undefined
        case "visaStatus":
          return profile.visaStatus !== undefined
        case "targetLocations":
          return profile.targetLocations !== undefined
        case "industrySector":
          return profile.industrySector !== undefined
        case "relevantIndustry":
          return profile.relevantIndustry !== undefined
        default:
          return true
      }
    })()
    if (!present) missing.push(`tags.${f}`)
  }
  profile.missingFields = missing

  return profile
}
