import test from "node:test"
import assert from "node:assert/strict"
import {
  runGeneratePitchEmail,
  type GeneratePitchEmailDeps,
} from "./generate-pitch-email.js"

function makeDeps(
  opts: {
    candidate?: Record<string, unknown> | undefined
    job?: Record<string, unknown> | undefined
    llmResponse?: string
    llmError?: string
  } = {},
): GeneratePitchEmailDeps {
  return {
    loadCandidate: async () => opts.candidate,
    loadJob: async () => opts.job,
    runLLM: async () => {
      if (opts.llmError) throw new Error(opts.llmError)
      return { text: opts.llmResponse ?? "" }
    },
    apiKey: "test-key",
    now: () => "2026-05-21T03:00:00.000Z",
  }
}

const sampleCandidate = {
  name: "Yue H.",
  experiences: [
    { company: "IntelliPro", title: "Tech Recruiter" },
    { company: "Acme", title: "Engineer" },
  ],
  tags: {
    skills: ["sourcing", "python", "kubernetes"],
    recentRoleTitle: "Tech Recruiter",
    recentCompany: "IntelliPro",
  },
}

const sampleJob = {
  company: "ExampleCo",
  title: "Senior Recruiter",
  requiredSkills: ["sourcing", "ats"],
  niceToHaveSkills: ["python"],
}

test("runGeneratePitchEmail — happy path returns ok with parsed fields", async () => {
  const deps = makeDeps({
    candidate: sampleCandidate,
    job: sampleJob,
    llmResponse: JSON.stringify({
      subject: "ExampleCo — Senior Recruiter chat?",
      body: "Hi Yue, I came across your work as Tech Recruiter at IntelliPro and thought it might overlap with our Senior Recruiter role's sourcing focus. Open to a quick chat? Reply 'stop' and I won't follow up.",
      used_evidence: [
        { type: "candidate_experience", text: "Tech Recruiter at IntelliPro" },
        { type: "job_requirement", text: "sourcing" },
      ],
      confidence: 0.85,
      risk_flags: [],
    }),
  })
  const result = await runGeneratePitchEmail(
    { candidateId: "c-1", jobId: "j-1" },
    deps,
  )
  assert.equal(result.status, "ok")
  assert.match(result.subject!, /ExampleCo/)
  assert.match(result.body!, /Yue/)
  assert.match(result.body!, /stop/i)
  assert.equal(result.usedEvidence!.length, 2)
  assert.equal(result.confidence, 0.85)
  assert.equal(result.modelUsed, "gpt-5.4-nano")
})

test("runGeneratePitchEmail — strips markdown code fence", async () => {
  const deps = makeDeps({
    candidate: sampleCandidate,
    job: sampleJob,
    llmResponse:
      "```json\n" +
      JSON.stringify({
        subject: "Test",
        body: "Hi Yue. Reply 'stop'.",
        used_evidence: [],
        confidence: 0.5,
        risk_flags: [],
      }) +
      "\n```",
  })
  const result = await runGeneratePitchEmail(
    { candidateId: "c-1", jobId: "j-1" },
    deps,
  )
  assert.equal(result.status, "ok")
  assert.equal(result.subject, "Test")
})

test("runGeneratePitchEmail — LLM insufficient_evidence passes through", async () => {
  const deps = makeDeps({
    candidate: sampleCandidate,
    job: sampleJob,
    llmResponse: JSON.stringify({
      status: "insufficient_evidence",
      reason: "model_judged_no_real_overlap",
    }),
  })
  const result = await runGeneratePitchEmail(
    { candidateId: "c-1", jobId: "j-1" },
    deps,
  )
  assert.equal(result.status, "insufficient_evidence")
  assert.equal(result.reason, "model_judged_no_real_overlap")
})

test("runGeneratePitchEmail — preflight rejects when no overlap between candidate skills and job requirements", async () => {
  const deps = makeDeps({
    candidate: {
      name: "Bob",
      experiences: [{ company: "X", title: "Doctor" }],
      tags: { skills: ["surgery"] },
    },
    job: {
      company: "Y",
      title: "Software Engineer",
      requiredSkills: ["go", "rust"],
    },
    llmResponse: "should not be called",
  })
  const result = await runGeneratePitchEmail(
    { candidateId: "c-1", jobId: "j-1" },
    deps,
  )
  assert.equal(result.status, "insufficient_evidence")
  assert.equal(
    result.reason,
    "no_overlap_between_candidate_skills_and_job_requirements",
  )
  assert.equal(result.modelUsed, "none") // never called LLM
})

test("runGeneratePitchEmail — candidate not found throws not-found", async () => {
  const deps = makeDeps({ candidate: undefined, job: sampleJob })
  await assert.rejects(
    async () => runGeneratePitchEmail({ candidateId: "missing", jobId: "j-1" }, deps),
    /candidate_not_found/,
  )
})

test("runGeneratePitchEmail — job not found throws not-found", async () => {
  const deps = makeDeps({ candidate: sampleCandidate, job: undefined })
  await assert.rejects(
    async () => runGeneratePitchEmail({ candidateId: "c-1", jobId: "missing" }, deps),
    /job_not_found/,
  )
})

test("runGeneratePitchEmail — non-JSON LLM output throws", async () => {
  const deps = makeDeps({
    candidate: sampleCandidate,
    job: sampleJob,
    llmResponse: "Sorry, I can't help with that.",
  })
  await assert.rejects(
    async () => runGeneratePitchEmail({ candidateId: "c-1", jobId: "j-1" }, deps),
    /llm_response_not_json/,
  )
})

test("runGeneratePitchEmail — LLM missing required fields throws", async () => {
  const deps = makeDeps({
    candidate: sampleCandidate,
    job: sampleJob,
    llmResponse: JSON.stringify({ subject: "Just subject" }), // missing body
  })
  await assert.rejects(
    async () => runGeneratePitchEmail({ candidateId: "c-1", jobId: "j-1" }, deps),
    /llm_response_missing_required_fields/,
  )
})

test("runGeneratePitchEmail — LLM throws → llm_call_failed surfaces", async () => {
  const deps = makeDeps({
    candidate: sampleCandidate,
    job: sampleJob,
    llmError: "OpenAI rate limit",
  })
  await assert.rejects(
    async () => runGeneratePitchEmail({ candidateId: "c-1", jobId: "j-1" }, deps),
    /llm_call_failed.*OpenAI rate limit/,
  )
})

test("runGeneratePitchEmail — falls back to recentRoleTitle when experiences empty", async () => {
  const deps = makeDeps({
    candidate: {
      name: "Alice",
      experiences: [],
      tags: {
        skills: ["python"],
        recentRoleTitle: "Backend Engineer",
        recentCompany: "Stripe",
      },
    },
    job: {
      company: "Y",
      title: "Senior Backend Engineer",
      requiredSkills: ["python"],
    },
    llmResponse: JSON.stringify({
      subject: "Test",
      body: "Hi Alice. Reply 'stop'.",
      used_evidence: [],
      confidence: 0.7,
      risk_flags: [],
    }),
  })
  const result = await runGeneratePitchEmail(
    { candidateId: "c-1", jobId: "j-1" },
    deps,
  )
  assert.equal(result.status, "ok")
})

test("runGeneratePitchEmail — filters non-allowlist usedEvidence types", async () => {
  const deps = makeDeps({
    candidate: sampleCandidate,
    job: sampleJob,
    llmResponse: JSON.stringify({
      subject: "Test",
      body: "Hi Yue. Reply 'stop'.",
      used_evidence: [
        { type: "candidate_experience", text: "ok" },
        { type: "made_up_type", text: "bad" }, // dropped
        { type: "candidate_skill", text: "ok" },
      ],
      confidence: 0.5,
      risk_flags: [],
    }),
  })
  const result = await runGeneratePitchEmail(
    { candidateId: "c-1", jobId: "j-1" },
    deps,
  )
  assert.equal(result.status, "ok")
  assert.equal(result.usedEvidence!.length, 2)
})
