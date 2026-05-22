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
  isDemo?: boolean
  demoSourcePool?: string
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
  | "demo_preview_profile"
  | "synthetic_test_profile"
  | "internal_operator_profile"
  | "incomplete_identity_artifact"

export function isDemoPreviewProfile(doc: CandidateListUserDoc): boolean {
  const id = doc.id.toLowerCase()
  const phone = doc.phoneE164 ?? ""
  return doc.isDemo === true ||
    Boolean(doc.demoSourcePool) ||
    id.startsWith("demo_layoff_") ||
    phone.startsWith("+1555")
}

export function isInternalOperatorProfile(doc: CandidateListUserDoc): boolean {
  const email = doc.email?.trim().toLowerCase() ?? ""
  return email.endsWith("@wekruit.com")
}

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
    id.startsWith("verify-") ||
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

export function isValidE164Phone(value?: string): boolean {
  return typeof value === "string" && /^\+[1-9]\d{7,14}$/.test(value)
}

export function digitsOnly(value?: string): string {
  return (value ?? "").replace(/\D/g, "")
}

export function phoneSearchDigits(value: string): string | null {
  const digits = digitsOnly(value)
  return digits.length >= 3 ? digits : null
}

export function normalizeCandidatePhoneLookup(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const digits = digitsOnly(trimmed)
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`
  if (trimmed.startsWith("+") && digits.length >= 8) return `+${digits}`
  return null
}

export function matchesPhoneSearch(phoneE164: string | undefined, search: string): boolean {
  const queryDigits = phoneSearchDigits(search)
  if (!queryDigits || !phoneE164) return false
  return digitsOnly(phoneE164).includes(queryDigits)
}

function hasCurrentCandidateAccountSignal(doc: CandidateListUserDoc): boolean {
  if (isDemoPreviewProfile(doc) || isSyntheticTestProfile(doc) || isInternalOperatorProfile(doc)) {
    return false
  }

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
  return Boolean(doc.latestResumeArtifactId || doc.piiConsentAt)
}

export function deriveCandidateSource(
  doc: CandidateListUserDoc,
  linkedSource?: ExternalSource
): SourceKind {
  if (isDemoPreviewProfile(doc)) return doc.source === "WeKruit_Laid_Off" ? "layoff" : "unknown"
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
  if (isDemoPreviewProfile(doc)) return "demo_preview_profile"
  if (source === "synthetic_test") return "synthetic_test_profile"
  if (isInternalOperatorProfile(doc)) return "internal_operator_profile"
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
