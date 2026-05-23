/**
 * Phase EX1 PR-A — public type contracts for the experience extractor.
 *
 * Mirrored as runtime zod schemas in `./schema.ts` for validation; this
 * file is the single source of truth that downstream callers (the
 * migration script and the resume-upload hook) import.
 *
 * See `wekruit-pa/AGENT_PLAN-experience-extractor.md` §3 for the design
 * rationale and §4 for the backward-compatibility contract.
 */

/**
 * Input to {@link extractWorkEntrySkills}. One per work-history entry.
 *
 * `entryId` is the idempotency key — it is a content-stable hash of
 * (uid, index, title, startDate). Rerunning extraction on the same
 * source produces the same id and hits the cache.
 */
export interface WorkEntryExtractionInput {
  entryId: string
  title: string
  company: string
  /** ISO yyyy-mm-dd. `null` is tolerated; durationMonths falls back to 0. */
  startDate: string | null
  /** `null` means "current role" — durationMonths uses NOW. */
  endDate: string | null
  description: string | null
  bullets: string[]
  achievements: string[]
  /**
   * User's self-reported skill list. Passed to the LLM as a candidate
   * set to ground extraction; NOT enforced as a closed vocabulary. The
   * LLM may emit skills not in this list (e.g. it spots "kubernetes"
   * in bullets even though the user never claimed it).
   */
  candidateSkills: string[]
}

/**
 * Output of {@link extractWorkEntrySkills}. Cached in
 * `pa-users/{uid}/workEntries/{entryId}` for idempotent reruns.
 */
export interface WorkEntryExtractionOutput {
  /** Echoes input.entryId — write key for the cache subcollection. */
  entryId: string
  /** Canonical lowercase_snake_case skill identifiers. */
  extractedSkills: string[]
  /**
   * Months between startDate and endDate (or NOW for current roles).
   * Computed pre-LLM so the LLM doesn't have to do arithmetic.
   */
  durationMonths: number
  /**
   * Free-form industry guess. Validators downstream may normalize to
   * `@wekruit/shared-tags` canonical industry-sector. `null` when the
   * LLM cannot infer with confidence.
   */
  industryGuess: string | null
  responsibilityLevel:
    | "individual_contributor"
    | "tech_lead"
    | "people_manager"
    | "executive"
    | "unknown"
  /** LLM self-reported 0-1. Surface to consumers; do not blindly trust. */
  confidence: number
  /** Model identifier used for this call — useful for backfills. */
  llmModel: string
  /** ISO timestamp; cache write time. */
  extractedAt: string
}

/**
 * The per-user aggregate produced by {@link deriveExperienceModel}.
 * Written to `pa-users/{uid}.derivedExperience` alongside the
 * sibling field `derivedExperienceVersion = "v1"`.
 *
 * All existing pa-users fields remain unchanged; this is purely
 * additive (see plan §4).
 */
export interface DerivedExperienceModel {
  version: "v1"
  /** Sum of all work-entry durations in years. */
  yearsTotal: number
  /**
   * Map skill → years of experience using that skill. A skill mentioned
   * in the bullets/description of multiple entries accumulates each
   * entry's full duration (we do not pro-rate across simultaneous
   * skills — coarse but reproducible).
   */
  yearsPerSkill: Record<string, number>
  /**
   * Map skill → most recent date (ISO yyyy-mm-dd) the skill appeared.
   * For current roles the value is "present".
   */
  skillRecency: Record<string, string>
  /** Titles sorted by startDate ascending (earliest first). */
  titleTrajectory: string[]
  seniorityCurrent:
    | "intern"
    | "entry_level"
    | "new_grad"
    | "mid"
    | "senior"
    | "staff"
    | "manager"
    | "director"
    | "executive"
    | "unknown"
  responsibilityCurrent: WorkEntryExtractionOutput["responsibilityLevel"]
  /** Industry → years aggregated across entries. */
  industryHistory: Record<string, number>
  /**
   * Skills the user claimed but which never appeared in any extracted
   * entry. Surface to UI as "self-reported, no work evidence yet".
   */
  unverifiedSkills: string[]
  /** ISO timestamp; aggregate compute time. */
  computedAt: string
}
