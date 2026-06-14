import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { CoresignalEmployeeCollectV2 } from "@pa/external-supply"
import { MockFirestore, asFirestore } from "../job-rec/__tests__/mock-firestore.js"
import {
  SUBMISSION_EVAL_VERSION,
  buildResearchFromEmployee,
  coresignalCacheKey,
  looksLikeLinkedinUrl,
  runRecruiterSubmissionEval,
  type RecruiterSubmissionEvalDeps,
  type SubmissionAiEvaluation,
} from "../recruiter-submission-eval.js"

const now = "2026-06-09T12:00:00.000Z"
const SUBMISSIONS = "pa-recruiter-submissions"
const JOBS = "pa-jobs"

const checklistGroups = [
  {
    kind: "hard",
    heading: "Must-have",
    items: [
      { id: "h1", text: "5+ years backend engineering" },
      { id: "h2", text: "Production Kubernetes experience" },
    ],
  },
  {
    kind: "fit",
    heading: "Strong fit",
    items: [{ id: "f1", text: "Fintech domain experience" }],
  },
  {
    kind: "bonus",
    heading: "Bonus",
    items: [{ id: "b1", text: "Open-source contributions" }],
  },
  {
    kind: "anti",
    heading: "Anti-signals",
    items: [{ id: "a1", text: "Job hopper (sub-1-year stints)" }],
  },
]

const employeeFixture = {
  id: 633147031,
  full_name: "Yue H",
  headline: "Staff Backend Engineer @ Stripe",
  is_working: 1,
  active_experience_title: "Staff Backend Engineer",
  total_experience_duration_months: 84,
  inferred_skills: ["Go", "Kubernetes"],
  experience: [
    {
      company_name: "Stripe",
      position_title: "Staff Backend Engineer",
      date_from: "2022-01",
      date_to: null,
    },
    {
      company_name: "Plaid",
      position_title: "Backend Engineer",
      date_from: "2019-03",
      date_to: "2021-12",
    },
  ],
  education: [{ institution_name: "Stanford University", degree: "BS Computer Science" }],
} as unknown as CoresignalEmployeeCollectV2

function judgmentFixture(overrides?: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    verdict: "advance",
    confidence: 0.82,
    summary: "Strong verified backend profile matching every hard requirement.",
    reasons: ["7y backend at Stripe/Plaid verified via Coresignal", "Kubernetes confirmed in profile skills"],
    checklist: {
      hard: { met: 2, total: 2, gaps: [] },
      fit: { met: 1, total: 1, gaps: [] },
      bonus: { met: 0, total: 1, gaps: ["Open-source contributions"] },
      anti: { flagged: 0, total: 1, flags: [] },
    },
    background: {
      school: { verdict: "strong", evidence: "Stanford CS" },
      gpa: { verdict: "unknown", evidence: "no GPA on the profile" },
      degree: { verdict: "strong", evidence: "BS Computer Science" },
      company: { verdict: "strong", evidence: "Stripe, Plaid" },
    },
    ...overrides,
  }
}

async function seedJob(mfs: MockFirestore): Promise<void> {
  await mfs.collection(JOBS).doc("job-1").set({
    title: "Senior Backend Engineer",
    company: "Invoko",
    jdBlocks: [
      { heading: "About the role", body: "Own payments infrastructure on Kubernetes.", kind: "prose" },
    ],
    recruiterBoard: {
      label: { company: "Invoko" },
      checklist: { groups: checklistGroups },
    },
  })
}

async function seedSubmission(
  mfs: MockFirestore,
  overrides?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const doc = {
    submissionId: "sub-1",
    jobId: "job-1",
    candidate: {
      name: "Yue H",
      email: "yue@example.com",
      link: "https://www.linkedin.com/in/yue-h",
      currentRole: "Staff Backend Engineer",
      yoe: "7",
      notes: "Met at KubeCon, very strong on infra.",
    },
    checklist: { h1: true, h2: true, f1: true, b1: false, a1: false },
    score: {
      hardChecked: 2, hardTotal: 2,
      fitChecked: 1, fitTotal: 1,
      bonusChecked: 0, bonusTotal: 1,
      antiChecked: 0, antiTotal: 1,
    },
    status: "submitted",
    ...overrides,
  }
  await mfs.collection(SUBMISSIONS).doc("sub-1").set(doc)
  return doc
}

type DepsOverrides = {
  judgeResults?: Array<Record<string, unknown> | Error>
  searchResult?: number | null | Error
  employee?: CoresignalEmployeeCollectV2
  apiKey?: string | null
}

function makeDeps(mfs: MockFirestore, overrides?: DepsOverrides): RecruiterSubmissionEvalDeps & {
  judgeCalls: Array<{ userText: string }>
  searchCalls: string[]
} {
  const judgeResults = overrides?.judgeResults ?? [judgmentFixture()]
  const judgeCalls: Array<{ userText: string }> = []
  const searchCalls: string[] = []
  let judgeIndex = 0
  return {
    db: asFirestore(mfs),
    callJudge: async (args) => {
      judgeCalls.push({ userText: args.userText })
      const result = judgeResults[Math.min(judgeIndex, judgeResults.length - 1)]
      judgeIndex += 1
      if (result instanceof Error) throw result
      return { rawJson: JSON.stringify(result), usedModel: "gpt-5.4-nano" }
    },
    research: {
      apiKey: overrides?.apiKey === undefined ? "cs-key" : overrides.apiKey,
      searchEmployeeIdByLinkedinUrl: async (url) => {
        searchCalls.push(url)
        const result = overrides?.searchResult === undefined ? 633147031 : overrides.searchResult
        if (result instanceof Error) throw result
        return result
      },
      fetchEmployeeCollect: async () => overrides?.employee ?? employeeFixture,
    },
    now: () => now,
    judgeCalls,
    searchCalls,
  }
}

async function readEvaluation(mfs: MockFirestore): Promise<SubmissionAiEvaluation> {
  const snap = await mfs.collection(SUBMISSIONS).doc("sub-1").get()
  const evaluation = (snap.data() ?? {}).aiEvaluation as SubmissionAiEvaluation | undefined
  assert.ok(evaluation, "aiEvaluation missing from submission doc")
  return evaluation
}

describe("runRecruiterSubmissionEval", () => {
  it("clean advance: writes the pinned aiEvaluation shape with research", async () => {
    const mfs = new MockFirestore()
    await seedJob(mfs)
    await seedSubmission(mfs)
    const deps = makeDeps(mfs)

    const result = await runRecruiterSubmissionEval({ submissionId: "sub-1", submission: {} }, deps)

    assert.equal(result.status, "written")
    const evaluation = await readEvaluation(mfs)
    assert.equal(evaluation.verdict, "advance")
    assert.equal(evaluation.confidence, 0.82)
    assert.equal(evaluation.summary, "Strong verified backend profile matching every hard requirement.")
    assert.equal(evaluation.reasons.length, 2)
    assert.deepEqual(evaluation.checklist.hard, { met: 2, total: 2, gaps: [] })
    assert.deepEqual(evaluation.checklist.anti, { flagged: 0, total: 1, flags: [] })
    assert.equal(evaluation.evaluatedAt, now)
    assert.equal(evaluation.model, "gpt-5.4-nano")
    assert.equal(evaluation.version, SUBMISSION_EVAL_VERSION)
    assert.equal(evaluation.error, undefined)
    assert.ok(evaluation.research)
    assert.equal(evaluation.research.source, "coresignal")
    assert.equal(evaluation.research.headline, "Staff Backend Engineer @ Stripe")
    assert.deepEqual(evaluation.research.companies[0], {
      name: "Stripe",
      role: "Staff Backend Engineer",
      years: "2022-01 - present",
    })
    // v2: education extracted from Coresignal + AI background assessment stored
    assert.deepEqual(evaluation.research.education[0], { school: "Stanford University", degree: "BS Computer Science" })
    assert.equal(evaluation.background.school.verdict, "strong")
    assert.equal(evaluation.background.gpa.verdict, "unknown")
    assert.equal(evaluation.background.company.verdict, "strong")
    assert.deepEqual(deps.searchCalls, ["https://www.linkedin.com/in/yue-h"])
    // v2: the live Coresignal pull is cached by canonical-LinkedIn hash
    const cacheSnap = await mfs.collection("pa-coresignal-cache").doc(coresignalCacheKey("https://www.linkedin.com/in/yue-h")).get()
    assert.ok(cacheSnap.exists, "coresignal response cached for reuse")

    // The status stays operator-owned: never written by the eval.
    const doc = (await mfs.collection(SUBMISSIONS).doc("sub-1").get()).data() ?? {}
    assert.equal(doc.status, "submitted")
    const evalWrites = mfs.writeLog.filter((w) => w.path === SUBMISSIONS && w.id === "sub-1" && w.mode === "merge")
    assert.equal(evalWrites.length, 1)
    assert.deepEqual(Object.keys(evalWrites[0]!.data), ["aiEvaluation", "candidateId", "candidateTracking"])

    const users = mfs.store.get("pa-users")
    assert.equal(users?.size, 1)
    const [candidateId, user] = [...users!.entries()][0]!
    assert.equal(user.candidateLifecycleState, "prospect")
    assert.equal(user.email, "yue@example.com")
    assert.equal(user.linkedinUrl, "https://linkedin.com/in/yue-h")
    assert.deepEqual(user.recruiterSubmissionTracking, {
      lastSubmissionId: "sub-1",
      lastStatus: "submitted",
      lastJobId: "job-1",
      updatedAt: now,
    })

    const handles = mfs.store.get("pa-candidate-handles")
    assert.equal(handles?.size, 1)
    const handle = [...handles!.values()][0]!
    assert.equal(handle.kind, "linkedin")
    assert.equal(handle.candidateId, candidateId)
    assert.equal(handle.normalizedValue, "https://linkedin.com/in/yue-h")

    const events = mfs.store.get("pa-recruiter-candidate-events")
    assert.equal(events?.size, 1)
    const event = [...events!.values()][0]!
    assert.equal(event.kind, "recruiter_submission_created")
    assert.equal(event.candidateId, candidateId)
    assert.equal(event.submissionId, "sub-1")

    // Judge prompt carries rubric, recruiter CLAIMS, and research.
    const userText = deps.judgeCalls[0]!.userText
    assert.match(userText, /Senior Backend Engineer @ Invoko/)
    assert.match(userText, /\[recruiter claims: yes\] 5\+ years backend engineering/)
    assert.match(userText, /\[recruiter claims: no\] Open-source contributions/)
    assert.match(userText, /hard 2\/2, fit 1\/1, bonus 0\/1, anti 0\/1/)
    assert.match(userText, /Stripe — Staff Backend Engineer/)
    // v2: judge prompt carries education + the recruiter's background self-flag
    assert.match(userText, /Education:[\s\S]*Stanford University — BS Computer Science/)
    assert.match(userText, /Recruiter background self-flag/)
  })

  it("v2: reuses a cached Coresignal pull instead of re-fetching live", async () => {
    const mfs = new MockFirestore()
    await seedJob(mfs)
    await seedSubmission(mfs)
    await mfs
      .collection("pa-coresignal-cache")
      .doc(coresignalCacheKey("https://www.linkedin.com/in/yue-h"))
      .set({ employee: employeeFixture, fetchedAt: now, linkedinUrl: "https://www.linkedin.com/in/yue-h", source: "coresignal" })
    const deps = makeDeps(mfs)

    const result = await runRecruiterSubmissionEval({ submissionId: "sub-1", submission: {} }, deps)

    assert.equal(result.status, "written")
    assert.deepEqual(deps.searchCalls, [], "cache hit → no live Coresignal search")
    const evaluation = await readEvaluation(mfs)
    assert.ok(evaluation.research, "research served from cache")
    assert.equal(evaluation.research.education[0]?.school, "Stanford University")
  })

  it("hard-gap reject: persists the judge's gaps verbatim", async () => {
    const mfs = new MockFirestore()
    await seedJob(mfs)
    await seedSubmission(mfs)
    const deps = makeDeps(mfs, {
      judgeResults: [judgmentFixture({
        verdict: "reject",
        confidence: 0.9,
        summary: "No verifiable Kubernetes experience despite the recruiter tick.",
        reasons: ["Kubernetes tick unsupported by profile or notes"],
        checklist: {
          hard: { met: 1, total: 2, gaps: ["Production Kubernetes experience"] },
          fit: { met: 0, total: 1, gaps: ["Fintech domain experience"] },
          bonus: { met: 0, total: 1, gaps: ["Open-source contributions"] },
          anti: { flagged: 0, total: 1, flags: [] },
        },
      })],
    })

    const result = await runRecruiterSubmissionEval({ submissionId: "sub-1", submission: {} }, deps)

    assert.equal(result.status, "written")
    const evaluation = await readEvaluation(mfs)
    assert.equal(evaluation.verdict, "reject")
    assert.deepEqual(evaluation.checklist.hard.gaps, ["Production Kubernetes experience"])
  })

  it("anti-signal flag: persists flagged anti items", async () => {
    const mfs = new MockFirestore()
    await seedJob(mfs)
    await seedSubmission(mfs)
    const deps = makeDeps(mfs, {
      judgeResults: [judgmentFixture({
        verdict: "borderline",
        confidence: 0.6,
        checklist: {
          hard: { met: 2, total: 2, gaps: [] },
          fit: { met: 1, total: 1, gaps: [] },
          bonus: { met: 0, total: 1, gaps: ["Open-source contributions"] },
          anti: { flagged: 1, total: 1, flags: ["Job hopper (sub-1-year stints)"] },
        },
      })],
    })

    await runRecruiterSubmissionEval({ submissionId: "sub-1", submission: {} }, deps)

    const evaluation = await readEvaluation(mfs)
    assert.equal(evaluation.verdict, "borderline")
    assert.deepEqual(evaluation.checklist.anti, {
      flagged: 1,
      total: 1,
      flags: ["Job hopper (sub-1-year stints)"],
    })
  })

  it("clamps an advance verdict that contradicts its own hard gaps", async () => {
    const mfs = new MockFirestore()
    await seedJob(mfs)
    await seedSubmission(mfs)
    const deps = makeDeps(mfs, {
      judgeResults: [judgmentFixture({
        verdict: "advance",
        checklist: {
          hard: { met: 1, total: 2, gaps: ["Production Kubernetes experience"] },
          fit: { met: 1, total: 1, gaps: [] },
          bonus: { met: 0, total: 1, gaps: [] },
          anti: { flagged: 0, total: 1, flags: [] },
        },
      })],
    })

    await runRecruiterSubmissionEval({ submissionId: "sub-1", submission: {} }, deps)

    const evaluation = await readEvaluation(mfs)
    assert.equal(evaluation.verdict, "borderline")
  })

  it("checklist totals come from the job config: inflated LLM tallies clamped, gaps deduped", async () => {
    const mfs = new MockFirestore()
    await seedJob(mfs)
    await seedSubmission(mfs)
    const deps = makeDeps(mfs, {
      judgeResults: [judgmentFixture({
        verdict: "reject",
        checklist: {
          hard: { met: 5, total: 9, gaps: ["Production Kubernetes experience", "Production Kubernetes experience"] },
          fit: { met: -1, total: 0, gaps: [] },
          bonus: { met: 2, total: 4, gaps: [] },
          anti: { flagged: 3, total: 2, flags: ["Job hopper (sub-1-year stints)", "Job hopper (sub-1-year stints)"] },
        },
      })],
    })

    await runRecruiterSubmissionEval({ submissionId: "sub-1", submission: {} }, deps)

    const evaluation = await readEvaluation(mfs)
    assert.deepEqual(evaluation.checklist.hard, { met: 2, total: 2, gaps: ["Production Kubernetes experience"] })
    assert.deepEqual(evaluation.checklist.fit, { met: 0, total: 1, gaps: [] })
    assert.deepEqual(evaluation.checklist.bonus, { met: 1, total: 1, gaps: [] })
    assert.deepEqual(evaluation.checklist.anti, { flagged: 1, total: 1, flags: ["Job hopper (sub-1-year stints)"] })
  })

  it("advance with deduped hard gaps still demotes to borderline after normalization", async () => {
    const mfs = new MockFirestore()
    await seedJob(mfs)
    await seedSubmission(mfs)
    const deps = makeDeps(mfs, {
      judgeResults: [judgmentFixture({
        verdict: "advance",
        checklist: {
          hard: { met: 1, total: 2, gaps: ["Production Kubernetes experience", "Production Kubernetes experience"] },
          fit: { met: 1, total: 1, gaps: [] },
          bonus: { met: 0, total: 1, gaps: [] },
          anti: { flagged: 0, total: 1, flags: [] },
        },
      })],
    })

    await runRecruiterSubmissionEval({ submissionId: "sub-1", submission: {} }, deps)

    const evaluation = await readEvaluation(mfs)
    assert.equal(evaluation.verdict, "borderline")
    assert.deepEqual(evaluation.checklist.hard.gaps, ["Production Kubernetes experience"])
  })

  it("judge prompt title falls back to prescreenConfig.jobTitle, then jobId — never the company", async () => {
    const mfs = new MockFirestore()
    await mfs.collection(JOBS).doc("job-1").set({
      company: "Invoko",
      prescreenConfig: { jobTitle: "Product Designer" },
      recruiterBoard: { label: { company: "Invoko" }, checklist: { groups: checklistGroups } },
    })
    await seedSubmission(mfs)
    const deps = makeDeps(mfs)
    await runRecruiterSubmissionEval({ submissionId: "sub-1", submission: {} }, deps)
    assert.match(deps.judgeCalls[0]!.userText, /Product Designer @ Invoko/)

    const mfs2 = new MockFirestore()
    await mfs2.collection(JOBS).doc("job-1").set({
      company: "Invoko",
      recruiterBoard: { label: { company: "Invoko" }, checklist: { groups: checklistGroups } },
    })
    await seedSubmission(mfs2)
    const deps2 = makeDeps(mfs2)
    await runRecruiterSubmissionEval({ submissionId: "sub-1", submission: {} }, deps2)
    assert.match(deps2.judgeCalls[0]!.userText, /job-1 @ Invoko/)
  })

  it("research prefers candidate.linkedinUrl over candidate.link", async () => {
    const mfs = new MockFirestore()
    await seedJob(mfs)
    await seedSubmission(mfs, {
      candidate: {
        name: "Yue H",
        link: "https://yueh.dev",
        linkedinUrl: "https://www.linkedin.com/in/yue-h-real",
      },
    })
    const deps = makeDeps(mfs)

    const result = await runRecruiterSubmissionEval({ submissionId: "sub-1", submission: {} }, deps)

    assert.equal(result.status, "written")
    assert.deepEqual(deps.searchCalls, ["https://www.linkedin.com/in/yue-h-real"])
    const evaluation = await readEvaluation(mfs)
    assert.ok(evaluation.research)
    assert.equal(evaluation.research.source, "coresignal")
  })

  it("research-skip on a non-LinkedIn link: never calls Coresignal, research undefined", async () => {
    const mfs = new MockFirestore()
    await seedJob(mfs)
    await seedSubmission(mfs, {
      candidate: {
        name: "Yue H",
        email: "yue@example.com",
        link: "https://github.com/yue-h",
      },
    })
    const deps = makeDeps(mfs)

    const result = await runRecruiterSubmissionEval({ submissionId: "sub-1", submission: {} }, deps)

    assert.equal(result.status, "written")
    assert.deepEqual(deps.searchCalls, [])
    const evaluation = await readEvaluation(mfs)
    assert.equal(evaluation.research, undefined)
    assert.match(deps.judgeCalls[0]!.userText, /none available/)
  })

  it("Coresignal failure fails open: eval still written without research", async () => {
    const mfs = new MockFirestore()
    await seedJob(mfs)
    await seedSubmission(mfs)
    const deps = makeDeps(mfs, { searchResult: new Error("transient_503") })

    const result = await runRecruiterSubmissionEval({ submissionId: "sub-1", submission: {} }, deps)

    assert.equal(result.status, "written")
    const evaluation = await readEvaluation(mfs)
    assert.equal(evaluation.verdict, "advance")
    assert.equal(evaluation.research, undefined)
  })

  it("idempotent re-fire skip: existing aiEvaluation short-circuits before any LLM call", async () => {
    const mfs = new MockFirestore()
    await seedJob(mfs)
    await seedSubmission(mfs, {
      aiEvaluation: { verdict: "advance", version: SUBMISSION_EVAL_VERSION },
    })
    const deps = makeDeps(mfs)

    const result = await runRecruiterSubmissionEval({ submissionId: "sub-1", submission: {} }, deps)

    assert.equal(result.status, "skipped_existing")
    assert.equal(deps.judgeCalls.length, 0)
    assert.equal(deps.searchCalls.length, 0)
    const evaluation = await readEvaluation(mfs)
    assert.equal((evaluation as Record<string, unknown>).verdict, "advance")
  })

  it("LLM failure on both attempts: writes the error shape so operators see SOMETHING", async () => {
    const mfs = new MockFirestore()
    await seedJob(mfs)
    await seedSubmission(mfs)
    const deps = makeDeps(mfs, {
      judgeResults: [new Error("router_chain_exhausted"), new Error("router_chain_exhausted")],
    })

    const result = await runRecruiterSubmissionEval({ submissionId: "sub-1", submission: {} }, deps)

    assert.equal(result.status, "error_written")
    assert.equal(deps.judgeCalls.length, 2)
    const evaluation = await readEvaluation(mfs)
    assert.equal(evaluation.verdict, "borderline")
    assert.equal(evaluation.confidence, 0)
    assert.equal(evaluation.summary, "evaluation failed")
    assert.deepEqual(evaluation.reasons, [])
    assert.deepEqual(evaluation.checklist, {
      hard: { met: 0, total: 0, gaps: [] },
      fit: { met: 0, total: 0, gaps: [] },
      bonus: { met: 0, total: 0, gaps: [] },
      anti: { flagged: 0, total: 0, flags: [] },
    })
    assert.equal(evaluation.model, "none")
    assert.equal(evaluation.version, SUBMISSION_EVAL_VERSION)
    assert.equal(evaluation.error, "router_chain_exhausted")
  })

  it("recovers when the first judge output is invalid and the retry is clean", async () => {
    const mfs = new MockFirestore()
    await seedJob(mfs)
    await seedSubmission(mfs)
    const deps = makeDeps(mfs, {
      judgeResults: [{ verdict: "advance" }, judgmentFixture()],
    })

    const result = await runRecruiterSubmissionEval({ submissionId: "sub-1", submission: {} }, deps)

    assert.equal(result.status, "written")
    assert.equal(deps.judgeCalls.length, 2)
    const evaluation = await readEvaluation(mfs)
    assert.equal(evaluation.verdict, "advance")
  })

  it("missing job is unrecoverable: error shape written, status untouched", async () => {
    const mfs = new MockFirestore()
    await seedSubmission(mfs, { jobId: "job-missing" })
    const deps = makeDeps(mfs)

    const result = await runRecruiterSubmissionEval({ submissionId: "sub-1", submission: {} }, deps)

    assert.equal(result.status, "error_written")
    const evaluation = await readEvaluation(mfs)
    assert.equal(evaluation.error, "job_not_found:job-missing")
    const doc = (await mfs.collection(SUBMISSIONS).doc("sub-1").get()).data() ?? {}
    assert.equal(doc.status, "submitted")
  })
})

describe("looksLikeLinkedinUrl", () => {
  it("accepts linkedin hosts with or without scheme, rejects everything else", () => {
    assert.equal(looksLikeLinkedinUrl("https://www.linkedin.com/in/yue-h"), true)
    assert.equal(looksLikeLinkedinUrl("linkedin.com/in/yue-h"), true)
    assert.equal(looksLikeLinkedinUrl("https://github.com/yue-h"), false)
    assert.equal(looksLikeLinkedinUrl("https://notlinkedin.com/in/x"), false)
    assert.equal(looksLikeLinkedinUrl(""), false)
  })
})

describe("buildResearchFromEmployee", () => {
  it("extracts companies, signals, and risks per the pinned research shape", () => {
    const research = buildResearchFromEmployee(employeeFixture)
    assert.equal(research.source, "coresignal")
    assert.equal(research.headline, "Staff Backend Engineer @ Stripe")
    assert.deepEqual(research.companies, [
      { name: "Stripe", role: "Staff Backend Engineer", years: "2022-01 - present" },
      { name: "Plaid", role: "Backend Engineer", years: "2019-03 - 2021-12" },
    ])
    assert.deepEqual(research.signals, [
      "~7 years total experience on profile",
      "currently: Staff Backend Engineer",
      "profile skills: Go, Kubernetes",
    ])
    assert.deepEqual(research.risks, [])
  })

  it("flags empty profiles as risks", () => {
    const research = buildResearchFromEmployee({ id: 1 } as CoresignalEmployeeCollectV2)
    assert.equal(research.headline, "")
    assert.deepEqual(research.companies, [])
    assert.deepEqual(research.risks, ["no work experience listed on Coresignal profile"])
  })
})
