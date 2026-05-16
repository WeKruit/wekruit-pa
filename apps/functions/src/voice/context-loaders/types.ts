/**
 * v2.1 S1B — Voice Context Loaders: types + NotFoundError.
 *
 * The S2 voice bridge (LiveKit Agent on LiveKit Cloud) consumes these three
 * read-only typed shapes to assemble per-turn context for
 * `PreScreenPipeline.runTurn`. The loaders never write Firestore and never
 * recompute anything owned by other services — they project canonical
 * Firestore docs into the minimal stable shape voice needs.
 *
 * Locks (do not change without P10 sign-off):
 *  - `VoicePrescreenConfig.questions` reuses the canonical
 *    `PrescreenQuestionConfig` from `@pa/pa-orchestrator`. NO parallel taxonomy.
 *  - Missing source doc → `NotFoundError`. Partial source doc → return what's
 *    present + populate `missingFields: string[]`. Voice path degrades
 *    gracefully when, e.g., the candidate's `tags.skills` are empty.
 *  - Pure functions, Firestore Admin SDK only. No side effects.
 */

import type {
  PrescreenConfig,
  PrescreenQuestionConfig,
} from "@pa/pa-orchestrator"

// Re-exported so S2 can `import type { PrescreenQuestionConfig } from
// "./context-loaders"` and not learn the orchestrator's path. Reuse, not copy.
export type { PrescreenConfig, PrescreenQuestionConfig }

/**
 * Thrown when the source Firestore doc the voice path needs is absent.
 * Distinguishes between user / job / prescreen-config kinds so S2 can map
 * each to a different graceful-degradation path (e.g. for `prescreen-config`
 * the voice bridge plays the same "still being prepared" notice as
 * iMessage's `prescreen-session-start.ts`).
 */
export class NotFoundError extends Error {
  public readonly kind: "user" | "job" | "prescreen-config"
  public readonly id: string
  constructor(kind: "user" | "job" | "prescreen-config", id: string) {
    super(`${kind} not found: ${id}`)
    this.name = "NotFoundError"
    this.kind = kind
    this.id = id
  }
}

// ────────────────────────────────────────────────────────────────────────────
// VoiceUserProfile — from `pa-users/{userId}` (top-level + `tags` map)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Minimal user profile shape the voice bridge needs to greet the candidate,
 * mirror durable facts, and respect PII consent gates. Source: D8 single
 * candidate-tag source `pa-users/{userId}.tags` + top-level identity fields.
 */
export interface VoiceUserProfile {
  /** Doc id. Always present (this is the lookup key). */
  userId: string
  /** Spoken if present; "there" fallback otherwise. */
  displayName?: string
  /** TTS language lock. `tags.preferredLang` zh|en. mixed → undefined. */
  preferredLang?: "zh" | "en"
  /** Top-level E.164 dial target — voice agent verifies it matches the leg. */
  phoneE164?: string
  /** Top-level email. NEVER read aloud; identity hint only. */
  email?: string
  /** v2.0 candidate state machine state. Drives Claire tone (`prospect` vs `claimed`). */
  lifecycleState?: string
  /**
   * ISO8601 PII consent timestamp. Derived from
   * `piiConsentAt ?? contactPII.consentedAt`. Voice bridge MUST gate any
   * PII reveal on this being present.
   */
  piiConsentAt?: string

  // ---- Durable candidate facts (subset of pa-users.tags the voice path uses)
  /** Canonical jobright `utm_campaign` 17-enum. Claire acknowledges the role family. */
  targetRoleFunction?: string[]
  /**
   * Canonical SkillEntry list (full unranked bag, max ~30 in practice).
   * Voice agent uses `name` only for the "I see you have X, Y" mirror line.
   */
  skills?: Array<{
    name: string
    bucket?: string
    proficiency?: string
    evidenceCount?: number
    baseWeight?: number
  }>
  /** workHistory[0].title — Claire's warm opener. */
  recentRoleTitle?: string
  recentCompany?: string
  /** Bounded ~200 char "title @ co; title @ co; title @ co" summary. */
  workHistorySummary?: string
  /** [min, max] YoE tuple. Seniority talking points. */
  yoeRange?: [number, number]
  /** 4-enum visa: citizen / permanent_resident / sponsor_needed / other. */
  visaStatus?: string
  /** Free-text or canonical location preferences. */
  targetLocations?: string[]
  /** Never spoken; passed for downstream policy decisions. */
  minSalary?: number
  /** Canonical 42-enum industry sectors. */
  industrySector?: string[]
  /** Derived industry from work history experience. */
  relevantIndustry?: string[]

  // ---- Bookkeeping
  /** Latest tag write timestamp; staleness signal for HITL. */
  tagsUpdatedAt?: string
  /**
   * Fields the voice path expected but were absent on this doc. Empty array
   * = happy path. Voice bridge logs this for telemetry.
   */
  missingFields: string[]
}

// ────────────────────────────────────────────────────────────────────────────
// VoiceJobBrief — from `matching-jobs/{jobId}`
// ────────────────────────────────────────────────────────────────────────────

/**
 * Minimal job brief the voice bridge needs to deliver an opening pitch and
 * paraphrase requirements. Mirrors the existing `projectMatchingJob` reader
 * in `apps/functions/src/admin-match-debug.ts` for field-source parity.
 */
export interface VoiceJobBrief {
  jobId: string
  /** Fallback chain: jobTitle ?? title ?? roleTitle. */
  jobTitle: string
  /** Fallback chain: companyName ?? companyDisplayName. */
  companyName: string

  /** Canonical 17-enum role function. Claire's opener. */
  roleFunction?: string[]
  /** Canonical 42-enum industry sector. */
  industrySector?: string[]
  /** Closed seniority enum (e.g. `senior`, `staff`). */
  seniorityLevel?: string

  /** Informational only — voice agent NEVER auto-discloses comp. */
  salaryMin?: number
  salaryMax?: number

  /** What the JD literally says about location. */
  locationRaw?: string
  /** Canonical location bucket tokens. */
  locationBuckets?: string[]

  /** Closed enum: full_time / contract / intern / etc. */
  jobType?: string
  /** Visa fit signal. `null` = unknown; `false` = does NOT sponsor. */
  sponsorship?: boolean | null
  /** Voice agent paraphrases; never reads the list verbatim. */
  requiredSkills?: string[]

  /** Used in Level 1 reveal SMS post-PASS. NOT spoken. */
  atsApplyUrl?: string

  /** Freshness signal. ISO8601. */
  firstSeenAt?: string
  /** Liveness sweep result. True → 404; voice path SHOULD NOT dial. */
  dead?: boolean

  missingFields: string[]
}

// ────────────────────────────────────────────────────────────────────────────
// VoicePrescreenConfig — from `pa-jobs/{jobId}.prescreenConfig`
// ────────────────────────────────────────────────────────────────────────────

/**
 * Validated prescreen config exactly as `PreScreenPipeline.runTurn` already
 * consumes (no shape divergence). Source: `pa-jobs/{jobId}.prescreenConfig`
 * parsed via canonical `safeParsePrescreenConfig`. Throws `NotFoundError`
 * when missing or when Zod validation fails (voice cannot run an invalid
 * config; same contract as `prescreen-session-start.ts`'s
 * `config_missing | config_invalid` rejection).
 */
export interface VoicePrescreenConfig {
  jobId: string
  /** PrescreenConfigSchema version. */
  version: number
  /** Mirrored from config — kept on this shape so screen flow is self-contained. */
  jobTitle: string
  company?: string
  /** Pass threshold T ∈ [0.3, 1.0]. */
  threshold: number
  /** Confidence threshold τ_c. */
  confidenceThreshold: number
  /** Max clarifications per Q. */
  maxClarifyRounds: number
  /** S2 reads this to pick TTS persona. */
  voiceMode: "casual_onboarding" | "professional_prescreen"
  /** Canonical question list — exact orchestrator shape, no copy. */
  questions: PrescreenQuestionConfig[]
  /** PASS-only fields. Voice path SMSes these post-PASS; never speaks. */
  level1Reveal?: PrescreenConfig["level1Reveal"]
  /** True when Zod parse succeeded. False is unreachable (we throw on fail). */
  parsedFromZod: true
  missingFields: string[]
}
