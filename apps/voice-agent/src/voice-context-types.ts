/**
 * v2.1 S2 — typed shapes mirroring S1B's `apps/functions/src/voice/context-loaders/types.ts`.
 *
 * Rationale: `@pa/functions` is the Firebase Functions app, not a publishable
 * library. Importing types from it into another `apps/*` package works but
 * creates a heavy compile chain (Firebase Admin, Mem0, etc.) for the voice
 * worker that LiveKit Cloud has no reason to ship.
 *
 * We redeclare ONLY the shapes the voice worker needs at compile time. The
 * voice worker treats S1B's runtime loaders as a wire contract loaded
 * dynamically at entry-time (Cloud Function callable or direct Firestore
 * read TBD by S3 — see worker's `loadContext` adapter). Drift between this
 * file and `apps/functions/src/voice/context-loaders/types.ts` is a S2/S3
 * integration test concern (S5/S6 add the contract test).
 *
 * KEEP IN SYNC: when S1B's types change, update here. The relevant fields
 * for v2.1 voice are a subset of the full shape — see comments below.
 */

export type VoiceLang = "zh" | "en"

export interface VoiceUserProfile {
  userId: string
  displayName?: string
  preferredLang?: VoiceLang
  phoneE164?: string
  email?: string
  lifecycleState?: string
  /** L6 gate. ISO8601 timestamp when user gave PII consent. */
  piiConsentAt?: string

  targetRoleFunction?: string[]
  skills?: Array<{
    name: string
    bucket?: string
    proficiency?: string
    evidenceCount?: number
    baseWeight?: number
  }>
  recentRoleTitle?: string
  recentCompany?: string
  workHistorySummary?: string
  yoeRange?: [number, number]
  visaStatus?: string
  targetLocations?: string[]
  minSalary?: number
  industrySector?: string[]
  relevantIndustry?: string[]

  tagsUpdatedAt?: string
  missingFields: string[]
}

export interface VoiceJobBrief {
  jobId: string
  jobTitle: string
  companyName: string

  roleFunction?: string[]
  industrySector?: string[]
  seniorityLevel?: string

  salaryMin?: number
  salaryMax?: number

  locationRaw?: string
  locationBuckets?: string[]

  jobType?: string
  sponsorship?: boolean | null
  requiredSkills?: string[]

  atsApplyUrl?: string

  firstSeenAt?: string
  dead?: boolean

  missingFields: string[]
}

export interface VoicePrescreenQuestionConfig {
  qId: string
  type: string
  prompt: { zh?: string; en?: string }
  // S2 forwards opaque fields — full shape lives in @pa/pa-orchestrator.
  [k: string]: unknown
}

export interface VoicePrescreenConfig {
  jobId: string
  version: number
  jobTitle: string
  company?: string
  threshold: number
  confidenceThreshold: number
  maxClarifyRounds: number
  voiceMode: "casual_onboarding" | "professional_prescreen"
  questions: VoicePrescreenQuestionConfig[]
  level1Reveal?: unknown
  parsedFromZod: true
  missingFields: string[]
}

export type VoiceCallPurpose = "prescreen" | "onboarding"

interface VoiceCallContextBase {
  bookingId: string
  purpose: VoiceCallPurpose
  userProfile: VoiceUserProfile
}

/**
 * Prescreen calls carry the job + prescreen config needed by the shared
 * prescreen reducer.
 */
export interface VoicePrescreenCallContext extends VoiceCallContextBase {
  purpose: "prescreen"
  prescreenSessionId: string
  jobBrief: VoiceJobBrief
  prescreenConfig: VoicePrescreenConfig
}

/**
 * Onboarding calls use the shared onboarding reducer and are not tied to a job.
 */
export interface VoiceOnboardingCallContext extends VoiceCallContextBase {
  purpose: "onboarding"
}

/**
 * The full per-call context the voice worker assembles before turn-loop
 * dispatch. `bookingId` is the room-metadata key from S3.
 */
export type VoiceCallContext = VoicePrescreenCallContext | VoiceOnboardingCallContext
