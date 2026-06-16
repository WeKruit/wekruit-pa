import assert from "node:assert/strict"
import { test } from "node:test"
import type { CoresignalEmployeeCollectV2 } from "@pa/external-supply"
import { CoresignalCollectError } from "@pa/external-supply"
import { storeCoresignalEmployee } from "./lib/coresignal-cache.js"
import { asFirestore, MockFirestore } from "./job-rec/__tests__/mock-firestore.js"
import {
  normalizeSimilarCandidateRows,
  runExtensionFindSimilarCandidates,
  type SimilarCandidatesPayload,
} from "./extension-similar-candidates.js"

const now = "2026-06-15T12:00:00.000Z"

function employee(overrides: Partial<CoresignalEmployeeCollectV2> = {}): CoresignalEmployeeCollectV2 {
  return {
    id: 100,
    full_name: "Ada Source",
    headline: "Staff Backend Engineer at Stripe",
    linkedin_url: "https://www.linkedin.com/in/source-profile/",
    location_full: "San Francisco, California, United States",
    active_experience_title: "Staff Backend Engineer",
    active_experience_management_level: "Senior",
    primary_professional_email: "ada@stripe.com",
    primary_professional_email_status: "matched_email",
    professional_emails_collection: [],
    inferred_skills: ["Go", "Kubernetes", "Distributed Systems"],
    historical_skills: ["Python"],
    experience: [
      {
        company_name: "Stripe",
        position_title: "Staff Backend Engineer",
        active_experience: 1,
        management_level: "Senior",
      },
      {
        company_name: "Plaid",
        position_title: "Backend Engineer",
        active_experience: 0,
      },
    ],
    education: [
      {
        institution_name: "Stanford University",
        degree: "BS Computer Science",
      },
    ],
    ...overrides,
  }
}

function payload(overrides: Partial<SimilarCandidatesPayload> = {}): SimilarCandidatesPayload {
  return {
    source: {
      activeTabUrl: "https://www.linkedin.com/in/source-profile/?miniProfileUrn=abc",
      pageType: "linkedin_profile",
      title: "Ada Source | LinkedIn",
      visibleText: "Ada Source Staff Backend Engineer Stripe Stanford University",
    },
    profileContext: {
      linkedinUrl: "https://www.linkedin.com/in/source-profile/",
      fullName: "Ada Source",
      headline: "Staff Backend Engineer at Stripe",
      location: "San Francisco, California, United States",
    },
    ...overrides,
  }
}

test("runExtensionFindSimilarCandidates rejects missing auth", async () => {
  const db = new MockFirestore()
  await assert.rejects(
    () =>
      runExtensionFindSimilarCandidates({
        auth: null,
        data: payload(),
        db: asFirestore(db),
        apiKey: "test-key",
        now,
        agenticSearch: async () => ({ data: [] }),
      }),
    (err: unknown) =>
      typeof err === "object" &&
      err !== null &&
      (err as { code?: string }).code === "unauthenticated",
  )
})

test("runExtensionFindSimilarCandidates rejects non-LinkedIn profile URLs", async () => {
  const db = new MockFirestore()
  await assert.rejects(
    () =>
      runExtensionFindSimilarCandidates({
        auth: { uid: "recruiter-1" },
        data: payload({
          source: {
            activeTabUrl: "https://www.linkedin.com/jobs/view/123",
            pageType: "linkedin_profile",
          },
          profileContext: {
            linkedinUrl: "https://www.linkedin.com/jobs/view/123",
          },
        }),
        db: asFirestore(db),
        apiKey: "test-key",
        now,
        agenticSearch: async () => ({ data: [] }),
      }),
    (err: unknown) =>
      typeof err === "object" &&
      err !== null &&
      (err as { code?: string }).code === "invalid-argument",
  )
})

test("runExtensionFindSimilarCandidates resolves source from CoreSignal cache without live collect", async () => {
  const db = new MockFirestore()
  await storeCoresignalEmployee({
    db: asFirestore(db),
    link: "https://linkedin.com/in/source-profile",
    coresignalId: 100,
    employee: employee(),
    now,
    source: "test",
  })
  let searchCalls = 0
  let collectCalls = 0
  let agenticPrompt = ""

  const result = await runExtensionFindSimilarCandidates({
    auth: { uid: "recruiter-1" },
    data: payload(),
    db: asFirestore(db),
    apiKey: "test-key",
    now,
    searchEmployeeIdByLinkedinUrl: async () => {
      searchCalls += 1
      return 100
    },
    fetchEmployeeCollect: async () => {
      collectCalls += 1
      return employee()
    },
    agenticSearch: async (request) => {
      agenticPrompt = request.prompt
      return { data: [] }
    },
  })

  assert.equal(result.source.canonicalLinkedInUrl, "https://linkedin.com/in/source-profile")
  assert.equal(searchCalls, 0)
  assert.equal(collectCalls, 0)
  assert.match(agenticPrompt, /role\/function/i)
  assert.match(agenticPrompt, /education/i)
})

test("normalizeSimilarCandidateRows ranks candidates and explains concrete overlap", () => {
  const source = employee()
  const rows = normalizeSimilarCandidateRows(
    [
      employee({
        id: 100,
        full_name: "Ada Source",
        linkedin_url: "https://linkedin.com/in/source-profile",
      }),
      employee({
        id: 201,
        full_name: "Grace Kim",
        linkedin_url: "https://www.linkedin.com/in/grace-kim/",
        headline: "Staff Backend Engineer at Plaid",
        active_experience_title: "Staff Backend Engineer",
        location_full: "New York, New York, United States",
        primary_professional_email: "Grace@Plaid.com",
        professional_emails_collection: [
          { professional_email: "not-an-email", professional_email_status: "matched_email" },
          { professional_email: "grace.work@plaid.com", professional_email_status: "matched_email" },
        ],
        experience: [
          {
            company_name: "Plaid",
            position_title: "Staff Backend Engineer",
            active_experience: 1,
            management_level: "Senior",
          },
          { company_name: "Stripe", position_title: "Backend Engineer", active_experience: 0 },
        ],
        education: [{ institution_name: "Stanford University", degree: "MS Computer Science" }],
        inferred_skills: ["Go", "Kubernetes", "Payments"],
      }),
      employee({
        id: 202,
        full_name: "",
        linkedin_url: "https://www.linkedin.com/in/no-name/",
      }),
      employee({
        id: 203,
        full_name: "Company Page",
        linkedin_url: "https://www.linkedin.com/company/plaid/",
      }),
    ],
    {
      source,
      sourceCanonicalLinkedInUrl: "https://linkedin.com/in/source-profile",
      limit: 20,
    },
  )

  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.rank, 1)
  assert.equal(rows[0]?.canonicalLinkedInUrl, "https://linkedin.com/in/grace-kim")
  assert.equal(rows[0]?.primaryProfessionalEmail, "grace@plaid.com")
  assert.deepEqual(rows[0]?.professionalEmails, ["grace@plaid.com", "grace.work@plaid.com"])
  assert.ok(rows[0]?.similarityReasons.some((reason) => /title|role|company|education|skill/i.test(reason)))
})

test("normalizeSimilarCandidateRows rejects generic major-tech title matches", () => {
  const source = employee({
    id: 400,
    full_name: "Shixiang Source",
    headline: "Sr. SWE @ Tesla | Top 0.1% National Awardee | USC Alumni | LLM applications",
    linkedin_url: "https://www.linkedin.com/in/shixiang-source/",
    active_experience_title: "Senior Software Engineer",
    active_experience_management_level: "Senior",
    location_full: "Los Angeles, California, United States",
    inferred_skills: ["LLM Applications", "Distributed Transactions", "Message Queues", "Algorithms"],
    historical_skills: [],
    experience: [
      {
        company_name: "Tesla",
        position_title: "Senior Software Engineer",
        active_experience: 1,
        management_level: "Senior",
      },
      {
        company_name: "aiStudy",
        position_title: "Software Engineer",
        active_experience: 0,
      },
    ],
    education: [{ institution_name: "USC Viterbi School of Engineering", degree: "BS Computer Science" }],
  })

  const rows = normalizeSimilarCandidateRows(
    [
      employee({
        id: 401,
        full_name: "Generic Senior SWE",
        headline: "Senior Software Engineer at Google",
        linkedin_url: "https://www.linkedin.com/in/generic-senior-swe/",
        active_experience_title: "Senior Software Engineer",
        active_experience_management_level: "Senior",
        location_full: "San Francisco, California, United States",
        inferred_skills: ["Java", "Cloud Computing", "Software Engineering"],
        historical_skills: [],
        experience: [
          {
            company_name: "Google",
            position_title: "Senior Software Engineer",
            active_experience: 1,
            management_level: "Senior",
          },
        ],
        education: [{ institution_name: "University of Florida", degree: "MS Computer Science" }],
        similarity_score: 100,
      }),
    ],
    {
      source,
      sourceCanonicalLinkedInUrl: "https://linkedin.com/in/shixiang-source",
      limit: 20,
    },
  )

  assert.deepEqual(rows, [])
})

test("normalizeSimilarCandidateRows prefers high-growth builder evidence over generic scores", () => {
  const source = employee({
    id: 410,
    full_name: "Shixiang Source",
    headline: "Sr. SWE @ Tesla | Top 0.1% National Awardee | USC Alumni | LLM applications",
    linkedin_url: "https://www.linkedin.com/in/shixiang-source/",
    active_experience_title: "Senior Software Engineer",
    active_experience_management_level: "Senior",
    location_full: "Los Angeles, California, United States",
    inferred_skills: ["LLM Applications", "Distributed Transactions", "Message Queues", "Algorithms"],
    historical_skills: [],
    experience: [
      {
        company_name: "Tesla",
        position_title: "Senior Software Engineer",
        active_experience: 1,
        management_level: "Senior",
      },
      {
        company_name: "aiStudy",
        position_title: "Software Engineer",
        active_experience: 0,
      },
    ],
    education: [{ institution_name: "USC Viterbi School of Engineering", degree: "BS Computer Science" }],
  })

  const rows = normalizeSimilarCandidateRows(
    [
      employee({
        id: 411,
        full_name: "Generic BigTech SWE",
        headline: "Senior Software Engineer at Microsoft",
        linkedin_url: "https://www.linkedin.com/in/generic-bigtech-swe/",
        active_experience_title: "Senior Software Engineer",
        active_experience_management_level: "Senior",
        location_full: "Redmond, Washington, United States",
        inferred_skills: ["Java", "Cloud Computing", "Software Engineering"],
        historical_skills: [],
        experience: [
          {
            company_name: "Microsoft",
            position_title: "Senior Software Engineer",
            active_experience: 1,
            management_level: "Senior",
          },
        ],
        education: [{ institution_name: "University of Florida", degree: "MS Computer Science" }],
        similarity_score: 100,
      }),
      employee({
        id: 412,
        full_name: "Builder Candidate",
        headline: "Generative AI developer productivity engineer | Founder of Rhyme.com (Acquired)",
        linkedin_url: "https://www.linkedin.com/in/builder-candidate/",
        active_experience_title: "Senior Staff Software Engineer",
        active_experience_management_level: "Senior",
        location_full: "San Francisco, California, United States",
        inferred_skills: ["Generative AI", "Developer Productivity", "Distributed Systems", "Bootstrapping"],
        historical_skills: [],
        experience: [
          {
            company_name: "Google",
            position_title: "Senior Staff Software Engineer, Generative UI",
            active_experience: 1,
            management_level: "Senior",
          },
          {
            company_name: "Rhyme.com (Acquired)",
            position_title: "Founder",
            active_experience: 0,
          },
        ],
        education: [{ institution_name: "Sofia University", degree: "MS Software Engineering" }],
        similarity_score: 72,
      }),
    ],
    {
      source,
      sourceCanonicalLinkedInUrl: "https://linkedin.com/in/shixiang-source",
      limit: 20,
    },
  )

  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.fullName, "Builder Candidate")
  assert.ok(rows[0]?.similarityReasons.some((reason) => /^Trajectory overlap:/i.test(reason)))
  assert.ok(rows[0]?.similarityReasons.some((reason) => /^Product\/domain overlap:/i.test(reason)))
  assert.ok((rows[0]?.similarityScore ?? 0) < 1)
})

test("normalizeSimilarCandidateRows keeps senior SWE searches role-compatible", () => {
  const source = employee({
    id: 420,
    full_name: "Shixiang Source",
    headline: "Sr. SWE @ Tesla | Top 0.1% National Awardee | USC Alumni | LLM applications",
    linkedin_url: "https://www.linkedin.com/in/shixiang-source/",
    active_experience_title: "Senior Software Engineer",
    active_experience_management_level: "Senior",
    location_full: "Los Angeles, California, United States",
    inferred_skills: ["LLM Applications", "Distributed Transactions", "Message Queues"],
    historical_skills: [],
    experience: [
      {
        company_name: "Tesla",
        position_title: "Senior Software Engineer",
        active_experience: 1,
        management_level: "Senior",
      },
    ],
    education: [{ institution_name: "USC Viterbi School of Engineering", degree: "BS Computer Science" }],
  })

  const rows = normalizeSimilarCandidateRows(
    [
      employee({
        id: 421,
        full_name: "Technical Evangelist Founder",
        headline: "Founder and technical evangelist helping engineers level up",
        linkedin_url: "https://www.linkedin.com/in/technical-evangelist-founder/",
        active_experience_title: "Tech Evangelist",
        active_experience_management_level: "Senior",
        inferred_skills: ["Generative AI", "Developer Productivity", "Bootstrapping"],
        historical_skills: [],
        experience: [
          {
            company_name: "Founder School",
            position_title: "Tech Evangelist",
            active_experience: 1,
            management_level: "Senior",
          },
        ],
      }),
      employee({
        id: 422,
        full_name: "Hands-on AI Builder",
        headline: "Senior Software Engineer, AI | Founder of acquired developer tools startup",
        linkedin_url: "https://www.linkedin.com/in/hands-on-ai-builder/",
        active_experience_title: "Senior Software Engineer, AI",
        active_experience_management_level: "Senior",
        inferred_skills: ["Generative AI", "Developer Productivity", "Distributed Systems"],
        historical_skills: [],
        experience: [
          {
            company_name: "Axon",
            position_title: "Senior Software Engineer, AI",
            active_experience: 1,
            management_level: "Senior",
          },
          {
            company_name: "DevTools Startup",
            position_title: "Founder",
            active_experience: 0,
          },
        ],
      }),
      employee({
        id: 423,
        full_name: "AI Developer Advocate",
        headline: "AI Developer Advocate | Founder | Open source creator",
        linkedin_url: "https://www.linkedin.com/in/ai-developer-advocate/",
        active_experience_title: "AI Developer Advocate",
        active_experience_management_level: "Senior",
        inferred_skills: ["Generative AI", "Developer Productivity", "Distributed Systems"],
        historical_skills: [],
        experience: [
          {
            company_name: "OpenAI",
            position_title: "AI Developer Advocate",
            active_experience: 1,
            management_level: "Senior",
          },
        ],
      }),
    ],
    {
      source,
      sourceCanonicalLinkedInUrl: "https://linkedin.com/in/shixiang-source",
      limit: 20,
    },
  )

  assert.deepEqual(rows.map((row) => row.fullName), ["Hands-on AI Builder"])
})

test("runExtensionFindSimilarCandidates excludes the source profile even when CoreSignal returns it", async () => {
  const db = new MockFirestore()
  await storeCoresignalEmployee({
    db: asFirestore(db),
    link: "https://linkedin.com/in/source-profile",
    coresignalId: 100,
    employee: employee(),
    now,
    source: "test",
  })

  const result = await runExtensionFindSimilarCandidates({
    auth: { uid: "recruiter-1" },
    data: payload(),
    db: asFirestore(db),
    apiKey: "test-key",
    now,
    agenticSearch: async () => ({
      data: [
        employee({ id: 100, linkedin_url: "https://linkedin.com/in/source-profile" }),
        employee({ id: 201, full_name: "Grace Kim", linkedin_url: "https://linkedin.com/in/grace-kim" }),
      ],
    }),
    fetchEmployeeCollect: async (id) =>
      id === 201
        ? employee({ id: 201, full_name: "Grace Kim", linkedin_url: "https://linkedin.com/in/grace-kim" })
        : employee(),
  })

  assert.deepEqual(result.results.map((row) => row.canonicalLinkedInUrl), [
    "https://linkedin.com/in/grace-kim",
  ])
})

test("runExtensionFindSimilarCandidates maps CoreSignal 429/5xx to retryable user errors", async () => {
  const db = new MockFirestore()
  await storeCoresignalEmployee({
    db: asFirestore(db),
    link: "https://linkedin.com/in/source-profile",
    coresignalId: 100,
    employee: employee(),
    now,
    source: "test",
  })

  await assert.rejects(
    () =>
      runExtensionFindSimilarCandidates({
        auth: { uid: "recruiter-1" },
        data: payload(),
        db: asFirestore(db),
        apiKey: "test-key",
        now,
        agenticSearch: async () => {
          throw new CoresignalCollectError("transient_429", 429, 3)
        },
      }),
    (err: unknown) =>
      typeof err === "object" &&
      err !== null &&
      (err as { code?: string; message?: string }).code === "resource-exhausted" &&
      /coresignal_fast_429/.test((err as { message?: string }).message ?? ""),
  )
})
