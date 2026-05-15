export type CandidateListUserDoc = {
  id: string
  phoneE164?: string
  email?: string
  linkedinUrl?: string
  signupSource?: string
  source?: string
  candidateLifecycleState?: string
  onboardingStatus?: string
  latestResumeArtifactId?: string
  piiConsentAt?: string
  mem0UserId?: string
  testMode?: boolean
}

export type ExternalSource = "juicebox" | "lessie" | "coresignal" | "manual_csv"

export type SourceKind =
  | ExternalSource
  | "imessage"
  | "public_job"
  | "ats"
  | "bulk_resume"
  | "layoff"
  | "synthetic_test"
  | "unknown"

export type CandidateClass =
  | "candidate_account"
  | "external_supply_prospect"
  | "legacy_sms_profile"
  | "synthetic_test_profile"
  | "incomplete_identity_artifact"

export function isSyntheticTestProfile(doc: CandidateListUserDoc): boolean {
  const id = doc.id.toLowerCase()
  const phone = doc.phoneE164 ?? ""
  const email = doc.email?.toLowerCase() ?? ""
  return doc.testMode === true ||
    id.startsWith("e2e-") ||
    id.startsWith("p9-") ||
    id.startsWith("qa") ||
    id.startsWith("recheck-") ||
    id.startsWith("synthetic") ||
    id.includes("reset") ||
    id.includes("smoke") ||
    id.includes("test") ||
    phone.startsWith("+19999") ||
    phone.startsWith("+1888") ||
    phone.includes("@") ||
    email.includes("test") ||
    email.endsWith("@example.com") ||
    email.endsWith("@local")
}

export function hasReachableIdentity(doc: CandidateListUserDoc): boolean {
  return Boolean(doc.email || doc.phoneE164 || doc.linkedinUrl)
}

function hasCurrentCandidateAccountSignal(doc: CandidateListUserDoc): boolean {
  const state = doc.candidateLifecycleState
  if (
    state === "claimed" ||
    state === "profile_ready" ||
    state === "active_job_seeker" ||
    state === "retained"
  ) {
    return hasReachableIdentity(doc) || Boolean(doc.latestResumeArtifactId || doc.mem0UserId)
  }
  if (doc.source === "WeKruit_Laid_Off") {
    return hasReachableIdentity(doc)
  }
  if (doc.signupSource === "identity:candidate") {
    return hasReachableIdentity(doc) || Boolean(doc.latestResumeArtifactId || doc.mem0UserId)
  }
  return Boolean(doc.latestResumeArtifactId || doc.piiConsentAt || doc.mem0UserId)
}

export function deriveCandidateSource(
  doc: CandidateListUserDoc,
  linkedSource?: ExternalSource
): SourceKind {
  if (isSyntheticTestProfile(doc)) return "synthetic_test"
  if (doc.source === "WeKruit_Laid_Off") return "layoff"
  if (linkedSource) return linkedSource
  if (doc.signupSource?.startsWith("external_sourcing")) return "manual_csv"
  if (doc.latestResumeArtifactId && !doc.phoneE164 && !doc.linkedinUrl) return "bulk_resume"
  if (doc.linkedinUrl && !doc.phoneE164) return "ats"
  if (doc.phoneE164) return "imessage"
  if (doc.email) return "public_job"
  return "unknown"
}

export function classifyCandidateProfile(
  source: SourceKind,
  doc: CandidateListUserDoc
): CandidateClass {
  if (source === "synthetic_test") return "synthetic_test_profile"
  if (
    source === "juicebox" ||
    source === "lessie" ||
    source === "coresignal" ||
    source === "manual_csv"
  ) {
    return "external_supply_prospect"
  }
  if (source === "unknown" && !hasReachableIdentity(doc)) return "incomplete_identity_artifact"
  if (!hasCurrentCandidateAccountSignal(doc)) {
    return source === "imessage" ? "legacy_sms_profile" : "incomplete_identity_artifact"
  }
  return "candidate_account"
}
