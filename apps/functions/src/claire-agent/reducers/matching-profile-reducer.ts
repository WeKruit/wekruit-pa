/**
 * matching-profile-reducer — the KEYSTONE deterministic reducer (poc-v1).
 *
 * This is the headline fix for the 2026-05-29 canary RC1: "done with pure SWE,
 * only product" must REMOVE software_engineering from the positive set AND write
 * negativeRoleFunction — not append product while keeping SWE.
 *
 * The LLM only PROPOSES the typed intent (onlyRoleFunctions / avoidRoleFunctions
 * / jobType / locations). This pure function DECIDES the resulting canonical tag
 * slice. The set-matching-preferences tool calls this, then persists the result
 * via `applyPartialUserTags` (the sole writer to pa-users.tags).
 *
 * No I/O, no LLM — fully deterministic, L1-testable.
 */

export interface MatchingPreferenceProposal {
  /** Roles to match — REPLACES the whole positive set. */
  onlyRoleFunctions?: readonly string[] | null
  /** Roles to exclude — added to the negative axis AND removed from positive. */
  avoidRoleFunctions?: readonly string[] | null
  jobType?: readonly string[] | null
  /**
   * Job types to exclude — SUBTRACTED from targetJobType AND accumulated into
   * negativeJobType. A subtraction that empties the set writes [] (an explicit
   * clear), because targetJobType is an EXACT-match HARD filter: the 2026-06-09
   * live victim said "I am not looking for an internship" and a stale
   * targetJobType=["internship"] kept matching ONLY intern jobs.
   */
  avoidJobTypes?: readonly string[] | null
  /** Explicit "no job-type filter at all" — empties targetJobType. */
  clearTargetJobType?: boolean | null
  locations?: readonly string[] | null
  /**
   * Industry sectors to match — REPLACES the positive set AND un-avoids any of
   * them (same only/avoid semantics as the jobType axis).
   */
  industrySector?: readonly string[] | null
  /**
   * Industry sectors to exclude — SUBTRACTED from the positive set AND
   * accumulated into negativeIndustrySector. A subtraction that empties the
   * positive set writes [] (an explicit clear), mirroring avoidJobTypes —
   * "I want healthcare, not fintech" → industrySector:[healthcare_and_life_sciences]
   * + avoidIndustrySector:[financial_technology].
   */
  avoidIndustrySector?: readonly string[] | null
  /** Work authorization (canonical 4-token VISA_VOCAB) — scalar REPLACE. */
  visaStatus?: string | null
  /** Minimum acceptable base salary in USD — scalar REPLACE. */
  minSalary?: number | null
  /** Company-size preference (COMPANY_SIZE_VOCAB, multi-pick OR) — REPLACE. */
  companySize?: readonly string[] | null
  /** Seniority (CAREER_STAGE_VOCAB) — scalar REPLACE. */
  careerStage?: string | null
}

/** The subset of pa-users.tags this reducer owns. */
export interface MatchingTagsSlice {
  targetRoleFunction?: string[]
  negativeRoleFunction?: string[]
  targetJobType?: string[]
  negativeJobType?: string[]
  targetLocations?: string[]
  industrySector?: string[]
  negativeIndustrySector?: string[]
  visaStatus?: string
  minSalary?: number
  companySize?: string[]
  careerStage?: string
}

export interface MatchingReducerResult {
  /** the full next slice (what to persist). */
  next: MatchingTagsSlice
  /** only the fields this proposal actually changed (what to write + narrate). */
  changed: Partial<MatchingTagsSlice>
  /** roles removed from the positive set because they were avoided. */
  removedFromPositive: string[]
}

function dedup(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of values) {
    if (v && !seen.has(v)) {
      seen.add(v)
      out.push(v)
    }
  }
  return out
}

function nonEmpty(arr: readonly string[] | null | undefined): arr is readonly string[] {
  return Array.isArray(arr) && arr.length > 0
}

/**
 * Deterministic only/avoid/replace reducer.
 *
 * Semantics (durable, more complete than poc-v1's replace-negatives):
 *   - onlyRoleFunctions  → REPLACE targetRoleFunction; also un-avoid any of these
 *                          roles (remove from negativeRoleFunction) since they are
 *                          now explicitly wanted.
 *   - avoidRoleFunctions → ACCUMULATE into negativeRoleFunction (union) AND remove
 *                          those roles from targetRoleFunction.
 *   - jobType / locations → REPLACE (a stated preference replaces the prior set).
 *
 * Order matters: `only` applies first (sets the positive baseline + un-avoids),
 * then `avoid` subtracts. So "only product, avoid sales" yields positive=[product],
 * negative=[sales] even if product was previously avoided.
 */
export function reduceMatchingPreferences(
  current: MatchingTagsSlice,
  proposal: MatchingPreferenceProposal,
): MatchingReducerResult {
  let positive = dedup(current.targetRoleFunction ?? [])
  let negative = dedup(current.negativeRoleFunction ?? [])
  const changed: Partial<MatchingTagsSlice> = {}
  const removedFromPositive: string[] = []

  if (nonEmpty(proposal.onlyRoleFunctions)) {
    const only = dedup(proposal.onlyRoleFunctions)
    positive = only
    // explicitly-wanted roles can no longer be on the negative axis.
    const onlySet = new Set(only)
    negative = negative.filter((r) => !onlySet.has(r))
    changed.targetRoleFunction = [...positive]
  }

  if (nonEmpty(proposal.avoidRoleFunctions)) {
    const avoid = new Set(dedup(proposal.avoidRoleFunctions))
    for (const r of positive) {
      if (avoid.has(r)) removedFromPositive.push(r)
    }
    positive = positive.filter((r) => !avoid.has(r))
    negative = dedup([...negative, ...avoid])
    changed.targetRoleFunction = [...positive]
    changed.negativeRoleFunction = [...negative]
  }

  // ── jobType axis — same only/avoid/replace semantics as role function.
  // targetJobType is an EXACT-match HARD filter, so a negation MUST be able to
  // empty it: subtraction resulting in [] is written as [] (an explicit clear),
  // never silently dropped (the "not looking for an internship" live bug).
  let jobTypes = dedup(current.targetJobType ?? [])
  let negativeJobTypes = dedup(current.negativeJobType ?? [])

  if (nonEmpty(proposal.jobType)) {
    jobTypes = dedup(proposal.jobType)
    changed.targetJobType = [...jobTypes]
    // explicitly-wanted job types can no longer be on the negative axis.
    const wanted = new Set(jobTypes)
    const unAvoided = negativeJobTypes.filter((t) => !wanted.has(t))
    if (unAvoided.length !== negativeJobTypes.length) {
      negativeJobTypes = unAvoided
      changed.negativeJobType = [...negativeJobTypes]
    }
  }

  if (nonEmpty(proposal.avoidJobTypes)) {
    const avoid = new Set(dedup(proposal.avoidJobTypes))
    jobTypes = jobTypes.filter((t) => !avoid.has(t))
    negativeJobTypes = dedup([...negativeJobTypes, ...avoid])
    changed.targetJobType = [...jobTypes]
    changed.negativeJobType = [...negativeJobTypes]
  }

  if (proposal.clearTargetJobType === true) {
    jobTypes = []
    changed.targetJobType = []
  }

  if (nonEmpty(proposal.locations)) {
    changed.targetLocations = dedup(proposal.locations)
  }

  // ── industrySector axis — SAME only/avoid semantics as jobType.
  // `industrySector` REPLACES the positive set + un-avoids; `avoidIndustrySector`
  // subtracts from positive + accumulates into negativeIndustrySector. A
  // subtraction that empties the positive set writes [] (an explicit clear).
  let sectors = dedup(current.industrySector ?? [])
  let negativeSectors = dedup(current.negativeIndustrySector ?? [])

  if (nonEmpty(proposal.industrySector)) {
    sectors = dedup(proposal.industrySector)
    changed.industrySector = [...sectors]
    // explicitly-wanted sectors can no longer be on the negative axis.
    const wanted = new Set(sectors)
    const unAvoided = negativeSectors.filter((s) => !wanted.has(s))
    if (unAvoided.length !== negativeSectors.length) {
      negativeSectors = unAvoided
      changed.negativeIndustrySector = [...negativeSectors]
    }
  }

  if (nonEmpty(proposal.avoidIndustrySector)) {
    const avoid = new Set(dedup(proposal.avoidIndustrySector))
    sectors = sectors.filter((s) => !avoid.has(s))
    negativeSectors = dedup([...negativeSectors, ...avoid])
    changed.industrySector = [...sectors]
    changed.negativeIndustrySector = [...negativeSectors]
  }

  // ── scalar / replace axes (visa, salary floor, company size, career stage) —
  // trivial pass-through: set `changed.<axis>` only when stated AND different
  // from the stored value (a restated identical preference is a no-op).
  if (typeof proposal.visaStatus === "string" && proposal.visaStatus.length > 0 &&
      proposal.visaStatus !== current.visaStatus) {
    changed.visaStatus = proposal.visaStatus
  }
  if (typeof proposal.minSalary === "number" && Number.isFinite(proposal.minSalary) &&
      proposal.minSalary >= 0 && proposal.minSalary !== current.minSalary) {
    changed.minSalary = proposal.minSalary
  }
  if (nonEmpty(proposal.companySize)) {
    const sizes = dedup(proposal.companySize)
    const prior = current.companySize ?? []
    const same = sizes.length === prior.length && sizes.every((v, i) => v === prior[i])
    if (!same) changed.companySize = sizes
  }
  if (typeof proposal.careerStage === "string" && proposal.careerStage.length > 0 &&
      proposal.careerStage !== current.careerStage) {
    changed.careerStage = proposal.careerStage
  }

  const next: MatchingTagsSlice = {
    targetRoleFunction: positive,
    ...(negative.length ? { negativeRoleFunction: negative } : {}),
    targetJobType: changed.targetJobType ?? current.targetJobType,
    ...(changed.negativeJobType !== undefined || current.negativeJobType !== undefined
      ? { negativeJobType: changed.negativeJobType ?? dedup(current.negativeJobType ?? []) }
      : {}),
    targetLocations: changed.targetLocations ?? current.targetLocations,
    ...(changed.industrySector !== undefined || current.industrySector !== undefined
      ? { industrySector: changed.industrySector ?? dedup(current.industrySector ?? []) }
      : {}),
    ...(changed.negativeIndustrySector !== undefined || current.negativeIndustrySector !== undefined
      ? { negativeIndustrySector: changed.negativeIndustrySector ?? dedup(current.negativeIndustrySector ?? []) }
      : {}),
    ...(changed.visaStatus !== undefined || current.visaStatus !== undefined
      ? { visaStatus: changed.visaStatus ?? current.visaStatus }
      : {}),
    ...(changed.minSalary !== undefined || current.minSalary !== undefined
      ? { minSalary: changed.minSalary ?? current.minSalary }
      : {}),
    ...(changed.companySize !== undefined || current.companySize !== undefined
      ? { companySize: changed.companySize ?? current.companySize }
      : {}),
    ...(changed.careerStage !== undefined || current.careerStage !== undefined
      ? { careerStage: changed.careerStage ?? current.careerStage }
      : {}),
  }

  return { next, changed, removedFromPositive }
}
