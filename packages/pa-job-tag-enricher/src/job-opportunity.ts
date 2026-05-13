type ConfidenceFields = {
  roleFunction: number
  industrySector: number
  relevantTags: number
  skills: number
  seniorityLevel: number
  locationBuckets: number
  jobType: number
}

export type JobOpportunityDraftInput = {
  name?: string
  rawJob: {
    title?: string
    companyName?: string
    locationRaw?: string
    salaryRange?: {
      min?: number
      max?: number
      currency?: string
    }
    jobDescription?: string
    evalCase?: {
      caseName: string
      candidateSummary: string
      expectedOutcome: "pass" | "not_pass" | "needs_review"
      expectedSignals: string[]
    }
  }
  enrichedJobTags: {
    roleFunction: string[]
    industrySector: string[]
    relevantTags?: string[]
    skills?: Array<{
      name: string
      bucket: string
      proficiency: string
      evidenceCount?: number
      baseWeight?: number
    }>
    seniorityLevel: string
    sponsorshipHint: boolean | null
    locationBuckets?: string[]
    jobType: string
    confidence: {
      overall: number
      fields: ConfidenceFields
    }
  }
}

type CoverageState = "pass" | "hitl"

type CoverageField = {
  state: CoverageState
  confidence?: number
  reason?: string
}

export type JobOpportunityDraft = {
  hardFilters: {
    roleFunction: string[]
    seniorityLevel: string
    jobType: string
    locationBuckets: string[]
    sponsorship: boolean | null
    salaryRange: JobOpportunityDraftInput["rawJob"]["salaryRange"] | null
  }
  softScoringWeights: {
    industrySector: Array<{ token: string; weight: number }>
    relevantTags: Array<{ token: string; weight: number }>
    skills: Array<{ token: string; bucket: string; proficiency: string; weight: number }>
  }
  prescreenConfigDraft: {
    status: "draft"
    approved: false
    approvalReady: boolean
    questions: Array<{
      id: string
      prompt: string
      required: boolean
      rubricDimensionId: string
    }>
  }
  scoringRubric: {
    version: "job-opportunity-draft-v1"
    dimensions: Array<{
      id: string
      label: string
      weight: number
      evidence: string[]
    }>
  }
  candidateBrief: {
    title: string
    body: string
  }
  evalFixtures: {
    summary: {
      total: number
      pass: number
      notPass: number
      needsReview: number
    }
    fixtures: Array<{
      caseName: string
      candidateSummary: string
      expectedOutcome: "pass" | "not_pass" | "needs_review"
      expectedSignals: string[]
    }>
  }
  coverage: {
    criticalPass: boolean
    fields: Record<
      "roleFunction" | "skills" | "seniority" | "location" | "salary" | "sponsorship",
      CoverageField
    >
  }
  hitlFlags: string[]
  confidence: JobOpportunityDraftInput["enrichedJobTags"]["confidence"]
  approvalReady: boolean
}

const APPROVAL_CONFIDENCE_THRESHOLD = 0.82

export function deriveJobOpportunityDraft(input: JobOpportunityDraftInput): JobOpportunityDraft {
  const tags = input.enrichedJobTags
  const rawJob = input.rawJob
  const hitlFlags: string[] = []
  const salaryRange = rawJob.salaryRange ?? null
  const skills = tags.skills ?? []
  const locationBuckets = tags.locationBuckets ?? []

  const coverage = {
    roleFunction: coverageField(tags.confidence.fields.roleFunction, tags.roleFunction.length === 1),
    skills: coverageField(tags.confidence.fields.skills, skills.length > 0),
    seniority: coverageField(tags.confidence.fields.seniorityLevel, true),
    location: coverageField(tags.confidence.fields.locationBuckets, locationBuckets.length > 0),
    salary: salaryRange ? passField() : hitlField("missing salary range"),
    sponsorship: tags.sponsorshipHint === null ? hitlField("sponsorship not explicit") : passField(),
  }

  if (tags.confidence.overall < APPROVAL_CONFIDENCE_THRESHOLD) {
    hitlFlags.push("LOW_OVERALL_CONFIDENCE")
  }
  if (tags.roleFunction.length !== 1 || tags.confidence.fields.roleFunction < 0.75) {
    hitlFlags.push(tags.roleFunction.length > 1 ? "AMBIGUOUS_ROLE_FUNCTION" : "WEAK_ROLE_FUNCTION_COVERAGE")
  }
  if (skills.length === 0 || tags.confidence.fields.skills < 0.7) {
    hitlFlags.push("MISSING_SKILLS_COVERAGE")
  }
  if (tags.confidence.fields.seniorityLevel < 0.7) {
    hitlFlags.push("WEAK_SENIORITY_COVERAGE")
  }
  if (locationBuckets.length === 0 || tags.confidence.fields.locationBuckets < 0.7) {
    hitlFlags.push("WEAK_LOCATION_COVERAGE")
  }
  if (!salaryRange) {
    hitlFlags.push("MISSING_SALARY_COVERAGE")
  }
  if (tags.sponsorshipHint === null) {
    hitlFlags.push("SPONSORSHIP_SILENT")
  }

  const criticalPass = Object.values(coverage).every((field) => field.state === "pass")
  const approvalReady = tags.confidence.overall >= APPROVAL_CONFIDENCE_THRESHOLD && criticalPass

  return {
    hardFilters: {
      roleFunction: [...tags.roleFunction],
      seniorityLevel: tags.seniorityLevel,
      jobType: tags.jobType,
      locationBuckets: [...locationBuckets],
      sponsorship: tags.sponsorshipHint,
      salaryRange,
    },
    softScoringWeights: {
      industrySector: weightedTokens(tags.industrySector, 0.85, 0.1),
      relevantTags: weightedTokens(tags.relevantTags ?? [], 0.45, 0.05),
      skills: skills.map((skill) => ({
        token: skill.name,
        bucket: skill.bucket,
        proficiency: skill.proficiency,
        weight: roundWeight(skill.baseWeight ?? 0.6),
      })),
    },
    prescreenConfigDraft: {
      status: "draft",
      approved: false,
      approvalReady,
      questions: buildQuestions(tags, salaryRange),
    },
    scoringRubric: buildScoringRubric(tags),
    candidateBrief: buildCandidateBrief(input),
    evalFixtures: buildEvalFixtures(input),
    coverage: {
      criticalPass,
      fields: coverage,
    },
    hitlFlags: dedupe(hitlFlags),
    confidence: tags.confidence,
    approvalReady,
  }
}

function coverageField(confidence: number, hasSignal: boolean): CoverageField {
  if (hasSignal && confidence >= 0.7) {
    return { state: "pass", confidence }
  }
  return { state: "hitl", confidence, reason: hasSignal ? "low confidence" : "missing signal" }
}

function passField(): CoverageField {
  return { state: "pass" }
}

function hitlField(reason: string): CoverageField {
  return { state: "hitl", reason }
}

function weightedTokens(tokens: string[], start: number, step: number): Array<{ token: string; weight: number }> {
  return tokens.map((token, index) => ({ token, weight: roundWeight(start - index * step) }))
}

function roundWeight(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 100) / 100))
}

function buildQuestions(
  tags: JobOpportunityDraftInput["enrichedJobTags"],
  salaryRange: JobOpportunityDraftInput["rawJob"]["salaryRange"] | null,
): JobOpportunityDraft["prescreenConfigDraft"]["questions"] {
  const questions: JobOpportunityDraft["prescreenConfigDraft"]["questions"] = [
    {
      id: "role_fit",
      prompt: `What recent work best matches this ${tags.roleFunction.join(" or ")} role?`,
      required: true,
      rubricDimensionId: "role_fit",
    },
  ]

  if ((tags.skills ?? []).length > 0) {
    questions.push({
      id: "technical_depth",
      prompt: `Which required skill are you strongest in, and what is a concrete example of using it?`,
      required: true,
      rubricDimensionId: "technical_depth",
    })
  }

  if ((tags.locationBuckets ?? []).length > 0) {
    questions.push({
      id: "location_alignment",
      prompt: "Does this location or remote setup work for you?",
      required: true,
      rubricDimensionId: "location_alignment",
    })
  }

  if (salaryRange) {
    questions.push({
      id: "compensation_alignment",
      prompt: "Is this compensation range aligned with what you are targeting?",
      required: true,
      rubricDimensionId: "compensation_alignment",
    })
  }

  questions.push({
    id: "sponsorship_status",
    prompt: "Will you need current or future visa sponsorship for this role?",
    required: true,
    rubricDimensionId: "sponsorship_alignment",
  })

  return questions
}

function buildScoringRubric(tags: JobOpportunityDraftInput["enrichedJobTags"]): JobOpportunityDraft["scoringRubric"] {
  const skillEvidence = (tags.skills ?? []).map((skill) => skill.name)

  return {
    version: "job-opportunity-draft-v1",
    dimensions: [
      {
        id: "role_fit",
        label: "Role fit",
        weight: 0.3,
        evidence: [...tags.roleFunction],
      },
      {
        id: "technical_depth",
        label: "Required skill depth",
        weight: 0.3,
        evidence: skillEvidence,
      },
      {
        id: "seniority_alignment",
        label: "Seniority alignment",
        weight: 0.15,
        evidence: [tags.seniorityLevel],
      },
      {
        id: "location_alignment",
        label: "Location alignment",
        weight: 0.1,
        evidence: [...(tags.locationBuckets ?? [])],
      },
      {
        id: "sponsorship_alignment",
        label: "Sponsorship alignment",
        weight: 0.1,
        evidence: [String(tags.sponsorshipHint)],
      },
      {
        id: "compensation_alignment",
        label: "Compensation alignment",
        weight: 0.05,
        evidence: [],
      },
    ],
  }
}

function buildCandidateBrief(input: JobOpportunityDraftInput): JobOpportunityDraft["candidateBrief"] {
  const rawJob = input.rawJob
  const tags = input.enrichedJobTags
  const title = [rawJob.title, rawJob.companyName].filter(Boolean).join(" at ")
  const skills = (tags.skills ?? []).slice(0, 3).map((skill) => skill.name).join(", ")
  const location = rawJob.locationRaw ? ` The location listed is ${rawJob.locationRaw}.` : ""
  const skillSentence = skills ? ` Claire will focus on your experience with ${skills}.` : " Claire will focus on your closest relevant experience."

  return {
    title: title || "Job opportunity",
    body: `${title || "This role"} is a ${tags.seniorityLevel} ${tags.roleFunction.join(" or ")} opportunity.${skillSentence}${location}`,
  }
}

function buildEvalFixtures(input: JobOpportunityDraftInput): JobOpportunityDraft["evalFixtures"] {
  const evalCase = input.rawJob.evalCase
  const fixtures = evalCase ? [evalCase] : []

  return {
    summary: {
      total: fixtures.length,
      pass: fixtures.filter((fixture) => fixture.expectedOutcome === "pass").length,
      notPass: fixtures.filter((fixture) => fixture.expectedOutcome === "not_pass").length,
      needsReview: fixtures.filter((fixture) => fixture.expectedOutcome === "needs_review").length,
    },
    fixtures,
  }
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)]
}
