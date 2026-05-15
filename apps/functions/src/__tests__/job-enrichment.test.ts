import assert from "node:assert/strict"
import test from "node:test"
import { HttpsError } from "firebase-functions/v2/https"
import type { Firestore } from "firebase-admin/firestore"
import type { JobOpportunityDraft } from "@pa/core-types"
import {
  authorizeJobEnrichmentAdmin,
  prescreenConfigFromApprovedDraft,
  runJobEnrichmentApproveDraft,
  runJobEnrichmentRefreshDraft,
  runJobEnrichmentSaveCorrections,
} from "../job-enrichment.js"

const now = "2026-05-13T12:00:00.000Z"
const db = {} as Firestore

test("authorizeJobEnrichmentAdmin rejects non-admin callers and accepts existing admin identities", () => {
  const original = process.env.PA_ADMIN_TOKEN
  process.env.PA_ADMIN_TOKEN = "s4-secret"

  assert.throws(
    () => authorizeJobEnrichmentAdmin({ auth: { uid: "u1", token: { email: "person@example.com" } } }),
    (err) => err instanceof HttpsError && err.code === "permission-denied",
  )
  assert.equal(
    authorizeJobEnrichmentAdmin({ auth: { uid: "u2", token: { email: "operator@wekruit.com" } } }),
    "operator@wekruit.com",
  )
  assert.equal(
    authorizeJobEnrichmentAdmin({ auth: { uid: "u3", token: { admin: true } } }),
    "u3",
  )
  assert.equal(
    authorizeJobEnrichmentAdmin({ data: { adminToken: "s4-secret" } }),
    "admin-token",
  )

  if (original !== undefined) process.env.PA_ADMIN_TOKEN = original
  else delete process.env.PA_ADMIN_TOKEN
})

test("runJobEnrichmentRefreshDraft writes a marketplace draft under the job enrichment path contract", async () => {
  let captured: JobOpportunityDraft | null = null
  const result = await runJobEnrichmentRefreshDraft(
    { jobId: "job-1", draftId: "old-draft" },
    {
      db,
      nowIso: () => now,
      readJob: async () => ({
        roleTitle: "Frontend Engineer",
        companyName: "Acme",
        jobDescription: "Build React interfaces. We sponsor H-1B visas.",
        locationRaw: "Remote US",
        salaryRange: "$140k-$180k",
        source: "ats",
        sourceRepo: "jobright",
        contentHash: "hash-1",
      }),
      enrich: async () => ({
        tags: {
          roleFunction: ["software_engineering"],
          industrySector: ["software_and_saas"],
          relevantTags: ["react"],
          skills: [{ name: "react", bucket: "frameworks_and_libraries", proficiency: "advanced", evidenceCount: 2, baseWeight: 0.8 }],
          seniorityLevel: "mid_level",
          sponsorshipHint: true,
          locationBuckets: ["remote_united_states"],
          jobType: "full_time",
          confidence: {
            overall: 0.95,
            fields: {
              roleFunction: 0.96,
              industrySector: 0.92,
              relevantTags: 0.9,
              skills: 0.93,
              seniorityLevel: 0.91,
              locationBuckets: 0.9,
              jobType: 0.94,
            },
          },
        },
        modelUsed: "test-model",
        usedTier: "primary",
        fallbackChain: [],
      }),
      writeDraft: async (_db, draft) => {
        captured = draft
        return { draft, created: true }
      },
    },
  )

  assert.equal(result.ok, true)
  assert.equal(result.jobId, "job-1")
  assert.equal(result.approvalReady, true)
  assert.match(result.draftId, /^job_enrich_[a-f0-9]{32}$/)
  assert.equal(result.draftId.includes("job-1"), false)
  const draft = captured as unknown as JobOpportunityDraft
  assert.equal(draft.jobId, "job-1")
  assert.equal(draft.rawSnapshot.metadata.supersedesDraftId, "old-draft")
  assert.equal(draft.opportunity.hardFilters.sponsorshipAvailable, true)
  assert.deepEqual(draft.opportunity.hardFilters.locations, ["remote_united_states"])
  assert.equal(draft.opportunity.hardFilters.salaryMinUsd, 140000)
  assert.equal(draft.opportunity.hardFilters.salaryMaxUsd, 180000)
  assert.equal(draft.status, "draft")
})

test("runJobEnrichmentRefreshDraft keeps sponsorship silence unknown and title-only seniority in review", async () => {
  let captured: JobOpportunityDraft | null = null
  const result = await runJobEnrichmentRefreshDraft(
    { jobId: "job-2" },
    {
      db,
      nowIso: () => now,
      readJob: async () => ({
        roleTitle: "Senior Frontend Engineer",
        companyName: "Acme",
        jobDescription: "Build React interfaces for a consumer SaaS product.",
        locationRaw: "Remote US",
        salaryRange: "$150k-$170k",
        source: "ats",
      }),
      enrich: async () => ({
        tags: {
          roleFunction: ["software_engineering"],
          industrySector: ["software_and_saas"],
          relevantTags: ["react"],
          skills: [{ name: "react", bucket: "frameworks_and_libraries", proficiency: "advanced", evidenceCount: 2, baseWeight: 0.8 }],
          seniorityLevel: "senior",
          sponsorshipHint: null,
          locationBuckets: ["remote_united_states"],
          jobType: "full_time",
          confidence: {
            overall: 0.9,
            fields: {
              roleFunction: 0.96,
              industrySector: 0.92,
              relevantTags: 0.9,
              skills: 0.93,
              seniorityLevel: 0.4,
              locationBuckets: 0.9,
              jobType: 0.94,
            },
          },
        },
        modelUsed: "test-model",
        usedTier: "primary",
        fallbackChain: [],
      }),
      writeDraft: async (_db, draft) => {
        captured = draft
        return { draft, created: true }
      },
    },
  )

  assert.equal(result.approvalReady, false)
  const draft = captured as unknown as JobOpportunityDraft
  assert.equal(draft.status, "needs_review")
  assert.equal(draft.opportunity.hardFilters.sponsorshipAvailable, null)
  assert.equal(draft.coverage.overall, "low")
  assert.equal(draft.coverage.seniorityEvidence, "title_only")
  assert.equal(draft.coverage.sponsorshipSignal, "silent")
  assert.equal(draft.hitlFlags.some((flag) => flag.kind === "seniority_title_only"), true)
})

test("runJobEnrichmentRefreshDraft carries structured source tags into approval readiness", async () => {
  let captured: JobOpportunityDraft | null = null
  const result = await runJobEnrichmentRefreshDraft(
    { jobId: "job-structured" },
    {
      db,
      nowIso: () => now,
      readJob: async () => ({
        roleTitle: "Android Engineer",
        companyName: "Rain",
        jobDescription: "Build Android card issuing and payment flows with Kotlin and Jetpack Compose.",
        locationRaw: "New York, NY",
        salaryRange: "$150k-$190k",
        source: "admin",
        roleFunction: ["software_engineering"],
        industrySector: ["financial_technology"],
        seniorityLevel: "mid_level",
        locationBuckets: ["new_york_metro"],
        jobType: "full_time",
      }),
      enrich: async () => ({
        tags: {
          roleFunction: ["software_engineering", "engineering_and_development"],
          industrySector: ["technology_general"],
          relevantTags: ["android"],
          skills: [
            { name: "kotlin", bucket: "programming_languages", proficiency: "advanced", evidenceCount: 2, baseWeight: 0.8 },
            { name: "ai", bucket: "data_and_ml", proficiency: "intermediate", evidenceCount: 1, baseWeight: 0.5 },
          ],
          seniorityLevel: "staff",
          sponsorshipHint: null,
          locationBuckets: ["new_york_metro"],
          jobType: "full_time",
          confidence: {
            overall: 0.78,
            fields: {
              roleFunction: 0.78,
              industrySector: 0.72,
              relevantTags: 0.7,
              skills: 0.88,
              seniorityLevel: 0.55,
              locationBuckets: 0.9,
              jobType: 0.95,
            },
          },
        },
        modelUsed: "test-model",
        usedTier: "primary",
        fallbackChain: [],
      }),
      writeDraft: async (_db, draft) => {
        captured = draft
        return { draft, created: true }
      },
    },
  )

  assert.equal(result.approvalReady, true)
  const draft = captured as unknown as JobOpportunityDraft
  assert.deepEqual(draft.opportunity.roleFunction, ["software_engineering"])
  assert.ok(draft.opportunity.skills.some((skill) => skill.name === "artificial_intelligence"))
  assert.deepEqual(draft.opportunity.industrySector, ["financial_technology"])
  assert.equal(draft.opportunity.seniority.label, "mid_level")
  assert.deepEqual(draft.opportunity.hardFilters.locations, ["new_york_metro"])
  assert.equal(draft.coverage.sponsorshipSignal, "silent")
})

test("runJobEnrichmentApproveDraft approves and publishes matching plus prescreen-ready job fields", async () => {
  const calls: Array<{ jobId: string; draftId: string; approvedBy: string; approvedAt: string }> = []
  const writes: Array<{ collection: string; docId: string; payload: Record<string, unknown>; options: unknown }> = []
  const publishDb = {
    collection: (collection: string) => ({
      doc: (docId: string) => ({
        set: async (payload: Record<string, unknown>, options?: unknown) => {
          writes.push({ collection, docId, payload, options })
        },
      }),
    }),
  } as unknown as Firestore
  const approvedDraft = {
    jobId: "job-1",
    draftId: "draft-1",
    status: "approved",
    approvalReady: true,
    rawSnapshot: {
      source: "ats",
      capturedAt: now,
      title: "Frontend Engineer",
      companyName: "Acme",
      description: "Build React interfaces.",
      applyUrl: "https://jobs.example.com/apply/job-1",
      compensationText: "$140k-$180k",
      metadata: {},
    },
    opportunity: {
      title: "Frontend Engineer",
      companyName: "Acme",
      roleFunction: ["software_engineering"],
      industrySector: ["software_and_saas"],
      skills: [{ name: "react", bucket: "frameworks_and_libraries", proficiency: "advanced", evidenceCount: 2, baseWeight: 0.8 }],
      relevantTags: ["react"],
      seniority: { label: "mid_level", evidence: [] },
      hardFilters: { sponsorshipAvailable: true, locations: ["remote_united_states"], jobTypes: ["full_time"] },
      softScoringWeights: {
        skills: 0.35,
        roleFunction: 0.2,
        industrySector: 0.15,
        location: 0.1,
        compensation: 0.1,
        visa: 0.05,
        companyPreference: 0.05,
      },
      prescreen: {
        questions: [
          {
            questionId: "q_react",
            prompt: "Tell us about a React interface you shipped.",
            signal: "React production experience",
            required: true,
          },
        ],
        passSignals: ["React production experience"],
      },
      scoringRubric: { mustHave: ["React"], niceToHave: ["SaaS"], disqualifiers: [] },
      candidateBrief: { headline: "Frontend role", sellingPoints: ["React-heavy product work."], risksToClarify: [] },
    },
    coverage: { overall: "high", missingSignals: [], seniorityEvidence: "rubric", sponsorshipSignal: "explicit_yes" },
    hitlFlags: [],
    enrichmentVersion: "test",
    createdAt: now,
    approvedAt: now,
    approvedBy: "operator@wekruit.com",
  } satisfies JobOpportunityDraft
  const result = await runJobEnrichmentApproveDraft(
    { jobId: "job-1", draftId: "draft-1" },
    "operator@wekruit.com",
    {
      db: publishDb,
      nowIso: () => now,
      approveDraft: async (_db, input) => {
        calls.push(input)
        return approvedDraft
      },
    },
  )

  assert.deepEqual(calls, [{ jobId: "job-1", draftId: "draft-1", approvedBy: "operator@wekruit.com", approvedAt: now }])
  assert.deepEqual(result, { ok: true, jobId: "job-1", draftId: "draft-1", status: "approved" })
  assert.equal(writes.length, 2)
  const matchingWrite = writes.find((write) => write.collection === "matching-jobs")
  assert.equal(matchingWrite?.docId, "job-1")
  assert.deepEqual(matchingWrite?.options, { merge: true })
  assert.deepEqual(matchingWrite?.payload.roleFunction, ["software_engineering"])
  assert.deepEqual(matchingWrite?.payload.requiredSkills, ["react"])
  assert.equal(matchingWrite?.payload.sponsorship, true)
  assert.equal(matchingWrite?.payload.sponsorshipSource, "job_enrichment_approved")

  const publicJobWrite = writes.find((write) => write.collection === "pa-jobs")
  assert.equal(publicJobWrite?.docId, "job-1")
  assert.deepEqual(publicJobWrite?.options, { merge: true })
  assert.equal(publicJobWrite?.payload.publicVisible, true)
  assert.equal(publicJobWrite?.payload.candidatePageStatus, "published")
  const prescreenConfig = publicJobWrite?.payload.prescreenConfig as Record<string, unknown>
  assert.equal(prescreenConfig.jobTitle, "Frontend Engineer")
  assert.equal((prescreenConfig.questions as Array<Record<string, unknown>>)[0]?.qId, "q_react")
  assert.equal((prescreenConfig.level1Reveal as Record<string, unknown>).applyUrl, "https://jobs.example.com/apply/job-1")
})

test("prescreenConfigFromApprovedDraft leaves unknown sponsorship out of publication-only concerns", () => {
  const draft = {
    jobId: "job-2",
    draftId: "draft-2",
    status: "approved",
    approvalReady: true,
    rawSnapshot: { source: "ats", capturedAt: now, title: "Product Designer", metadata: {} },
    opportunity: {
      title: "Product Designer",
      roleFunction: ["creatives_and_design"],
      industrySector: ["software_and_saas"],
      skills: [{ name: "figma", bucket: "design_and_ux", proficiency: "advanced", evidenceCount: 2, baseWeight: 0.8 }],
      relevantTags: ["consumer_products"],
      seniority: { label: "mid_level", evidence: [] },
      hardFilters: { sponsorshipAvailable: null, locations: ["remote_united_states"], jobTypes: ["full_time"] },
      softScoringWeights: {
        skills: 0.35,
        roleFunction: 0.2,
        industrySector: 0.15,
        location: 0.1,
        compensation: 0,
        visa: 0,
        companyPreference: 0.05,
      },
      prescreen: {
        questions: [
          {
            questionId: "Portfolio question",
            prompt: "Walk through a consumer product design project.",
            signal: "portfolio quality",
            required: true,
          },
        ],
        passSignals: ["portfolio quality"],
      },
      scoringRubric: { mustHave: ["Portfolio"], niceToHave: ["Figma"], disqualifiers: [] },
    },
    coverage: { overall: "high", missingSignals: [], seniorityEvidence: "rubric", sponsorshipSignal: "silent" },
    hitlFlags: [],
    enrichmentVersion: "test",
    createdAt: now,
    approvedAt: now,
    approvedBy: "operator@wekruit.com",
  } satisfies JobOpportunityDraft

  const config = prescreenConfigFromApprovedDraft(draft, "operator@wekruit.com", now)
  assert.equal(config.questions[0]?.qId, "portfolio_question")
  assert.equal(config.questions[0]?.type, "MUST_HAVE")
})

test("prescreenConfigFromApprovedDraft writes role-aware probe copy for technical account roles", () => {
  const draft = {
    jobId: "job-3",
    draftId: "draft-3",
    status: "approved",
    approvalReady: true,
    rawSnapshot: {
      source: "ats",
      capturedAt: now,
      title: "Technical Account Manager",
      companyName: "Rain",
      description: "Own partner onboarding and API support.",
      metadata: {},
    },
    opportunity: {
      title: "Technical Account Manager",
      companyName: "Rain",
      roleFunction: ["software_engineering"],
      industrySector: ["financial_technology"],
      skills: [],
      relevantTags: ["api_support"],
      seniority: { label: "mid_level", evidence: [] },
      hardFilters: { sponsorshipAvailable: true, locations: ["remote_united_states"], jobTypes: ["full_time"] },
      softScoringWeights: {
        skills: 0.35,
        roleFunction: 0.2,
        industrySector: 0.15,
        location: 0.1,
        compensation: 0,
        visa: 0.05,
        companyPreference: 0.05,
      },
      prescreen: {
        questions: [
          {
            questionId: "role_fit",
            prompt: "What recent work best matches this technical account management role?",
            signal: "role_fit",
            required: true,
          },
        ],
        passSignals: ["partner onboarding"],
      },
      scoringRubric: { mustHave: ["API support"], niceToHave: [], disqualifiers: [] },
    },
    coverage: { overall: "high", missingSignals: [], seniorityEvidence: "rubric", sponsorshipSignal: "explicit_yes" },
    hitlFlags: [],
    enrichmentVersion: "test",
    createdAt: now,
    approvedAt: now,
    approvedBy: "operator@wekruit.com",
  } satisfies JobOpportunityDraft

  const config = prescreenConfigFromApprovedDraft(draft, "operator@wekruit.com", now)
  assert.match(config.questions[0]?.clarifyPrompt.en ?? "", /customer, partner, API, onboarding, support/)
})

test("prescreenConfigFromApprovedDraft makes software role-fit scoring probe-aware", () => {
  const draft = {
    jobId: "rain-software-engineer-fullstack-8849f6ef",
    draftId: "draft-fullstack",
    status: "approved",
    approvalReady: true,
    rawSnapshot: {
      source: "ats",
      capturedAt: now,
      title: "Software Engineer - Fullstack",
      companyName: "Rain",
      description: "Build full-stack product systems across React, Node, APIs, and databases.",
      compensationText: "$90-140K/yr",
      metadata: {},
    },
    opportunity: {
      title: "Software Engineer - Fullstack",
      companyName: "Rain",
      roleFunction: ["software_engineering"],
      industrySector: ["financial_technology"],
      skills: [
        { name: "typescript", bucket: "programming_languages", proficiency: "advanced", evidenceCount: 2, baseWeight: 0.8 },
        { name: "react", bucket: "frameworks_and_libraries", proficiency: "advanced", evidenceCount: 2, baseWeight: 0.8 },
        { name: "node", bucket: "programming_languages", proficiency: "advanced", evidenceCount: 2, baseWeight: 0.8 },
        { name: "postgresql", bucket: "databases", proficiency: "advanced", evidenceCount: 2, baseWeight: 0.8 },
      ],
      relevantTags: ["full_stack_engineering", "api_development"],
      seniority: { label: "mid_level", evidence: [] },
      hardFilters: {
        sponsorshipAvailable: false,
        locations: ["san_francisco_bay_area"],
        jobTypes: ["full_time"],
      },
      softScoringWeights: {
        skills: 0.35,
        roleFunction: 0.2,
        industrySector: 0.15,
        location: 0.1,
        compensation: 0.05,
        visa: 0.1,
        companyPreference: 0.05,
      },
      prescreen: {
        questions: [
          {
            questionId: "Role Fit",
            prompt: "What recent work best matches this software engineering role?",
            signal: "role_fit",
            required: true,
          },
          {
            questionId: "technical_depth",
            prompt: "What technical part did you personally build?",
            signal: "technical_depth",
            required: true,
          },
          {
            questionId: "sponsorship_status",
            prompt: "Do you need current or future visa sponsorship?",
            signal: "sponsorship_status",
            required: true,
          },
        ],
        passSignals: ["full-stack ownership"],
      },
      scoringRubric: { mustHave: ["Full-stack ownership"], niceToHave: ["Fintech"], disqualifiers: [] },
    },
    coverage: { overall: "high", missingSignals: [], seniorityEvidence: "rubric", sponsorshipSignal: "explicit_no" },
    hitlFlags: [],
    enrichmentVersion: "test",
    createdAt: now,
    approvedAt: now,
    approvedBy: "operator@wekruit.com",
  } satisfies JobOpportunityDraft

  const config = prescreenConfigFromApprovedDraft(draft, "operator@wekruit.com", now)
  const roleFit = config.questions[0]
  const technicalDepth = config.questions[1]
  const sponsorship = config.questions[2]

  assert.equal(roleFit?.qId, "role_fit")
  assert.equal(roleFit?.matchThreshold, 0.7)
  assert.notEqual(roleFit?.keywords[0]?.hint, "role_fit")
  assert.match(roleFit?.keywords[0]?.hint ?? "", /APIs\/services\/databases\/dashboards/)
  assert.match(roleFit?.keywords[0]?.hint ?? "", /Adjacent projects count/)
  assert.match(technicalDepth?.keywords[0]?.hint ?? "", /typescript, react, node, postgresql/)
  assert.match(sponsorship?.keywords[0]?.hint ?? "", /do not need current or future visa sponsorship/)
})

test("runJobEnrichmentSaveCorrections appends an operator correction event", async () => {
  const result = await runJobEnrichmentSaveCorrections(
    { jobId: "job-1", draftId: "draft-1", corrections: "Salary range should be 150k to 170k." },
    "operator@wekruit.com",
    {
      db,
      nowIso: () => now,
      writeCorrection: async (_db, event) => {
        assert.equal(event.targetType, "job_enrichment_draft")
        assert.equal(event.targetId, "draft-1")
        assert.equal(event.jobId, "job-1")
        assert.equal(event.actor, "operator")
        assert.equal(event.evidence[0]?.source, "admin")
        return { event, created: true }
      },
    },
  )

  assert.equal(result.ok, true)
  assert.equal(result.created, true)
  assert.match(result.eventId, /^job_enrichment_correction_[a-f0-9]{32}$/)
})
