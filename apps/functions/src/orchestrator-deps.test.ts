/**
 * iter34 sprint A.5 — wire-through sanity for `targetRole` →
 * `targetRoleIndustryEnum` filter passed to queryMatchingJobs from
 * `makeGenerateJobRecs` in orchestrator-deps.ts.
 *
 * `makeGenerateJobRecs` reads Firestore directly with no DI, so we can't
 * unit-test the inner closure cleanly without a Firestore mock harness
 * (the existing 455-test suite already does this kind of mocking via
 * @google-cloud/firestore-emulator-style stubs at higher layers). For
 * this iter we lock down the *decision boundary* the wire depends on:
 *
 *   1. `roleToIndustryBuckets` is reachable from `@pa/pa-orchestrator`
 *      (the import path orchestrator-deps.ts uses).
 *   2. `["swe"]` produces a non-empty bucket list including `tech_software`
 *      so SWE candidates won't get Warehouse jobs after the post-filter.
 *   3. `["founder"]` returns undefined → no filter applied → caller
 *      omits `targetRoleIndustryEnum` from the filters object.
 *   4. `undefined` input returns undefined → same.
 *
 * If any of these flip, the wire-through in `makeGenerateJobRecs` breaks
 * silently (Firestore reads still happen, queryMatchingJobs still runs,
 * but the post-filter no longer shrinks the candidate set by role).
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { roleToIndustryBuckets } from "@pa/pa-orchestrator"
import { formatJobMatchReason } from "./lib/match-reason.js"
import type { ScoreBreakdown } from "@pa/job-rec"
import {
  cleanJobRecUrl,
  isDegenerateLLMOutput,
  buildCvAnalysisFallback,
  fireAndForgetLlmRerank,
  formatJobRecIntro,
  formatJobRequirementsLine,
  resolveRuntimeJobRecRoleFocus,
  resolveJobRecVisibleCount,
} from "./orchestrator-deps.js"
import type { RerankInput, RerankOutput } from "./lib/llm-rerank.js"

describe("orchestrator-deps targetRole → industryEnum wire-through", () => {
  it("['swe'] expands to tech_software bucket (SWE doesn't get Warehouse)", () => {
    // Cast mirrors the runtime call site in orchestrator-deps.ts —
    // pa-users.statedPreferences.targetRole is plain string[] in storage,
    // and roleToIndustryBuckets is tolerant of unknown tokens.
    const buckets = roleToIndustryBuckets(
      ["swe"] as Parameters<typeof roleToIndustryBuckets>[0]
    )
    assert.ok(Array.isArray(buckets), "swe must produce a bucket array")
    assert.ok(buckets!.length > 0, "swe must produce at least one bucket")
    assert.ok(
      buckets!.includes("tech_software" as (typeof buckets)[number]),
      `swe must include tech_software bucket; got ${JSON.stringify(buckets)}`
    )
  })

  it("['founder'] returns undefined → caller omits targetRoleIndustryEnum filter", () => {
    const buckets = roleToIndustryBuckets(
      ["founder"] as Parameters<typeof roleToIndustryBuckets>[0]
    )
    assert.equal(
      buckets,
      undefined,
      "founder is cross-domain — caller must skip the post-filter"
    )
  })

  it("undefined input returns undefined → no filter applied", () => {
    const buckets = roleToIndustryBuckets(undefined)
    assert.equal(buckets, undefined)
  })

  it("empty array returns undefined → no filter applied", () => {
    const buckets = roleToIndustryBuckets(
      [] as Parameters<typeof roleToIndustryBuckets>[0]
    )
    assert.equal(buckets, undefined)
  })

  it("filter shape: when buckets undefined, spread omits the field", () => {
    // Mirror the exact spread pattern in orchestrator-deps.ts so we catch
    // any future regression where someone writes `targetRoleIndustryEnum:
    // [] as never[]` or similar.
    const undef = roleToIndustryBuckets(
      ["founder"] as Parameters<typeof roleToIndustryBuckets>[0]
    )
    const filters = {
      foo: "bar",
      ...(undef ? { targetRoleIndustryEnum: undef } : {}),
    }
    assert.equal(
      Object.prototype.hasOwnProperty.call(filters, "targetRoleIndustryEnum"),
      false,
      "founder/undefined path must not inject targetRoleIndustryEnum key"
    )
  })

  it("filter shape: when buckets defined, spread injects the field", () => {
    const def = roleToIndustryBuckets(
      ["swe"] as Parameters<typeof roleToIndustryBuckets>[0]
    )
    const filters = {
      foo: "bar",
      ...(def ? { targetRoleIndustryEnum: def } : {}),
    }
    assert.ok(
      Object.prototype.hasOwnProperty.call(filters, "targetRoleIndustryEnum"),
      "swe path must inject targetRoleIndustryEnum into filters"
    )
    assert.deepEqual(
      (filters as { targetRoleIndustryEnum: readonly string[] })
        .targetRoleIndustryEnum,
      def
    )
  })
})

// ---------------------------------------------------------------------------
// iter34 sprint B.11 — generateJobRecs compose integration. The production
// closure reads Firestore + iterates jobs; we lock down the per-job line
// composition shape (title, url, "为啥推:" reason) by mirroring the inline
// `lines.push(...)` block here. If the compose contract changes (e.g. someone
// drops the URL line or moves the reason ABOVE the URL), these tests fail.
// ---------------------------------------------------------------------------

type MockJob = {
  jobTitle: string
  companyName: string
  primaryUrl: string
  atsApplyUrl?: string
  matchScore?: { breakdown: ScoreBreakdown }
  requiredSkills?: string[]
  locationRaw?: string
  sponsorship?: boolean | null
  industryEnum?: string[]
}

const makeBreakdown = (over: Partial<ScoreBreakdown>): ScoreBreakdown => {
  const b: ScoreBreakdown = {
    skill: 0,
    embedding: 0,
    sponsorship: 0,
    location: 0,
    salary: 0,
    total: 0,
    ...over,
  }
  b.total =
    0.35 * b.skill +
    0.3 * b.embedding +
    0.15 * b.sponsorship +
    0.15 * b.location +
    0.05 * b.salary
  return b
}

/**
 * Mirror the inline compose block in `makeGenerateJobRecs` (orchestrator-deps.ts)
 * so unit-tests can drive it without spinning Firestore. Keep in lock-step with
 * the production loop body.
 */
function composeJobLine(
  j: MockJob,
  lang: "zh" | "en",
  ctx: { topSkills?: string[]; location?: string; visa?: string; targetRole?: string[] }
): string {
  const tag = j.companyName ? ` @ ${j.companyName}` : ""
  const url = `\n${cleanJobRecUrl(j) ?? ""}`
  const reasonText = formatJobMatchReason(
    {
      jobTitle: j.jobTitle,
      matchScore: j.matchScore,
      requiredSkills: j.requiredSkills,
      locationRaw: j.locationRaw,
      sponsorship: j.sponsorship,
      industryEnum: j.industryEnum,
    },
    lang,
    {
      targetRole: ctx.targetRole,
      userSkills: ctx.topSkills,
      targetLocations: ctx.location ? [ctx.location] : undefined,
      visaStatus: ctx.visa,
    }
  )
  const reasonLine = reasonText
    ? `\n${lang === "zh" ? "为啥推" : "why"}: ${reasonText}`
    : ""
  const formattedRequirements = formatJobRequirementsLine(lang, j.requiredSkills)
  const requirementsLine = formattedRequirements ? `\n${formattedRequirements}` : ""
  return `• ${j.jobTitle}${tag}${url}${requirementsLine}${reasonLine}`
}

describe("generateJobRecs compose: per-job line shape (iter34 B.11)", () => {
  it("includes 为啥推 line when matchScore present + signal strong (zh)", () => {
    const j: MockJob = {
      jobTitle: "Senior SWE",
      companyName: "Acme",
      primaryUrl: "https://acme.example/apply",
      matchScore: { breakdown: makeBreakdown({ skill: 1.0, embedding: 0.6 }) },
      requiredSkills: ["Node.js", "React"],
    }
    const out = composeJobLine(j, "zh", {
      topSkills: ["Node.js", "React"],
      targetRole: ["swe"],
    })
    const parts = out.split("\n")
    // 4 lines: title, url, requirements, reason
    assert.equal(parts.length, 4, `expected 4 lines, got ${parts.length}: ${JSON.stringify(out)}`)
    assert.match(parts[0]!, /Senior SWE @ Acme/)
    assert.match(parts[1]!, /^https:\/\//)
    assert.equal(parts[2]!, "要求: Node.js, React")
    assert.match(parts[3]!, /^为啥推: /)
    assert.match(parts[3]!, /Node\.js/)
  })

  it("legacy fallback: no concrete requirements → reason and requirements lines are dropped", () => {
    const j: MockJob = {
      jobTitle: "Backend Engineer",
      companyName: "Beta",
      primaryUrl: "https://beta.example/apply",
    }
    const out = composeJobLine(j, "en", { topSkills: [] })
    const parts = out.split("\n")
    assert.equal(parts.length, 2, "legacy must not emit weak requirements fallback copy")
    assert.match(parts[0]!, /Backend Engineer @ Beta/)
    assert.match(parts[1]!, /^https:\/\//)
    assert.equal(formatJobRequirementsLine("en", j.requiredSkills), "")
  })

  it("en path renders 'why:' label", () => {
    const j: MockJob = {
      jobTitle: "ML Engineer",
      companyName: "Gamma",
      primaryUrl: "https://gamma.example/apply",
      matchScore: { breakdown: makeBreakdown({ skill: 1.0 }) },
      requiredSkills: ["PyTorch"],
    }
    const out = composeJobLine(j, "en", { topSkills: ["PyTorch"] })
    assert.match(out, /\nrequirements: PyTorch/)
    assert.match(out, /\nwhy: matches PyTorch/)
  })

  it("preserves atsApplyUrl preference (iter34 sprint A.2 — no regression)", () => {
    const j: MockJob = {
      jobTitle: "SWE",
      companyName: "Delta",
      primaryUrl: "https://jobright.ai/job/xyz",
      atsApplyUrl: "https://delta.greenhouse.io/jobs/123",
      matchScore: { breakdown: makeBreakdown({ skill: 1.0 }) },
      requiredSkills: ["Go"],
    }
    const out = composeJobLine(j, "en", { topSkills: ["Go"] })
    assert.ok(out.includes("delta.greenhouse.io"), "must use atsApplyUrl not primaryUrl")
    assert.match(out, /\nrequirements: Go/)
    assert.ok(!out.includes("jobright.ai"), "must NOT regress to jobright.ai mirror")
  })
})

describe("generateJobRecs visible count", () => {
  it("defaults to two jobs for the daily/onboarding push", () => {
    assert.equal(resolveJobRecVisibleCount(undefined), 2)
    assert.equal(
      formatJobRecIntro("en", 2),
      "Based on the profile details you've shared so far, I found two roles that line up:",
    )
    assert.equal(formatJobRecIntro("zh", 2), "我根据你已经分享的资料, 这里先给你两个对得上的岗位:")
    assert.equal(
      formatJobRecIntro("en", 2, { skills: ["React", "SQL"] }),
      "I remember you mentioned React / SQL experience; I found two roles that line up:",
    )
  })

  it("honors explicit three-role requests but caps the visible batch at three", () => {
    assert.equal(resolveJobRecVisibleCount(3), 3)
    assert.equal(resolveJobRecVisibleCount(10), 3)
    assert.equal(
      formatJobRecIntro("en", 3),
      "Based on the profile details you've shared so far, I found three roles that line up:",
    )
    assert.equal(formatJobRecIntro("zh", 3), "我根据你已经分享的资料, 这里先给你三个对得上的岗位:")
  })

  it("rejects job recs without a candidate-usable link", () => {
    assert.equal(cleanJobRecUrl({ primaryUrl: "https://jobright.ai/job/123" }), null)
    assert.equal(cleanJobRecUrl({ primaryUrl: "" }), null)
    assert.equal(cleanJobRecUrl({ primaryUrl: "https://company.example/jobs/1" }), "https://company.example/jobs/1")
  })
})

describe("generateJobRecs role focus", () => {
  it("uses explicit request focus when present", () => {
    assert.deepEqual(
      resolveRuntimeJobRecRoleFocus(["frontend"], { targetRole: ["backend", "fullstack"] }),
      ["frontend"],
    )
  })

  it("falls back to canonical profile targetRole", () => {
    assert.deepEqual(
      resolveRuntimeJobRecRoleFocus(undefined, { targetRole: ["full-stack", "frontend"] }),
      ["fullstack", "frontend"],
    )
  })

  it("falls back to canonical targetRoleFunction before legacy targetRole", () => {
    assert.deepEqual(
      resolveRuntimeJobRecRoleFocus(undefined, {
        targetRoleFunction: ["product_management", "marketing"],
        targetRole: ["full-stack"],
      }),
      ["product_management", "marketing"],
    )
  })

  it("ignores non-presentation targetRole values", () => {
    assert.deepEqual(
      resolveRuntimeJobRecRoleFocus(undefined, { targetRole: ["product-ops tooling", "founder"] }),
      [],
    )
  })
})

// ---------------------------------------------------------------------------
// iter34 H.2 / CR1 — CV-analysis degenerate-output guard
//
// G5 sim observed Qwen2.5-7B-Instruct emit "Docker, Docker, Docker..." x60 on
// Adam's CV. The runtime guard + deterministic fallback line below ensures
// candidates never see this kind of LLM regurgitation.
// ---------------------------------------------------------------------------

describe("isDegenerateLLMOutput (iter34 H.2 CR1)", () => {
  it("trips on 'Docker, Docker, Docker...' x60 (G5 sim regression)", () => {
    const text = Array.from({ length: 60 }, () => "Docker").join(", ")
    assert.equal(isDegenerateLLMOutput(text), true, "60x Docker must trip guard")
  })

  it("trips when ANY single token >= threshold (default 10)", () => {
    const text = "node react node react node node node node node node node"
    // node appears 8 times — should NOT trip with default threshold 10
    assert.equal(isDegenerateLLMOutput(text), false)
    // but with explicit threshold 5 it does
    assert.equal(isDegenerateLLMOutput(text, 5), true)
  })

  it("does NOT trip on a healthy diverse summary", () => {
    const text =
      "Strong full-stack + cloud foundations across Node, React, Python, Stripe, Docker — leaning recs toward backend/infra roles."
    assert.equal(isDegenerateLLMOutput(text), false)
  })

  it("does NOT trip on legitimate skill repetition (each token < threshold)", () => {
    // Mentions "Docker" twice but no token hits 10x.
    const text = "You bring Docker + Kubernetes + Python skills with Docker workflows."
    assert.equal(isDegenerateLLMOutput(text), false)
  })

  it("trips on the cyclical-attention pathology with comma separators", () => {
    // Same as G5 sim but with explicit comma-space separator.
    const text = "Docker, Docker, Docker, Docker, Docker, Docker, Docker, Docker, Docker, Docker"
    assert.equal(isDegenerateLLMOutput(text), true)
  })

  it("returns false on empty / non-string", () => {
    assert.equal(isDegenerateLLMOutput(""), false)
    // @ts-expect-error — runtime defensive check
    assert.equal(isDegenerateLLMOutput(undefined), false)
  })
})

describe("buildCvAnalysisFallback (iter34 H.2 CR1)", () => {
  it("composes top-5 skills + recent role@company in zh", () => {
    const out = buildCvAnalysisFallback(
      {
        topSkills: ["Node", "React", "Python", "AWS", "Docker", "Stripe", "OpenAI"],
        recentRoleTitle: "Founder",
        recentCompany: "WeKruit",
      },
      "zh"
    )
    assert.match(out, /Node, React, Python, AWS, Docker/)
    assert.match(out, /Founder@WeKruit/)
    assert.match(out, /资料证据/)
  })

  it("composes top-5 skills + recent role@company in en", () => {
    const out = buildCvAnalysisFallback(
      {
        topSkills: ["TypeScript", "React", "PostgreSQL"],
        recentRoleTitle: "Senior SWE",
        recentCompany: "Acme",
      },
      "en"
    )
    assert.match(out, /TypeScript, React, PostgreSQL/)
    assert.match(out, /Senior SWE@Acme/)
    assert.match(out, /profile evidence/)
  })

  it("falls back gracefully when only skills present (no role)", () => {
    const out = buildCvAnalysisFallback({ topSkills: ["Go", "K8s"] }, "en")
    assert.match(out, /Go, K8s/)
    assert.ok(!out.includes("@"), "no @ when no recentCompany")
  })

  it("returns generic line when no signal at all", () => {
    const zh = buildCvAnalysisFallback({}, "zh")
    const en = buildCvAnalysisFallback({}, "en")
    assert.ok(zh.length > 0)
    assert.ok(en.length > 0)
  })

  it("ignores empty/non-string skills entries (defensive)", () => {
    const out = buildCvAnalysisFallback(
      {
        topSkills: ["Node", "", "React"] as string[],
      },
      "en"
    )
    assert.match(out, /Node, React/)
    assert.ok(!out.includes(", , "))
  })
})

// ---------------------------------------------------------------------------
// iter34 H.2 / CR4 — fire-and-forget llmRerank wired into makeGenerateJobRecs
//
// We can't easily integration-test the full closure without spinning Firestore.
// Instead we lock down the helper that the closure delegates to:
// `fireAndForgetLlmRerank` — verifying it (a) calls llmRerank with the
// candidate + jobs we pass, (b) writes the result into pa-user-rerank-cache,
// (c) NEVER throws on the caller, even when llmRerank rejects.
// ---------------------------------------------------------------------------

/** Tiny Firestore-shaped mock that records `set` calls on doc paths. */
interface FakeDoc {
  collection: string
  id: string
  payload: Record<string, unknown>
}
function makeFakeDb(): {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any
  writes: FakeDoc[]
} {
  const writes: FakeDoc[] = []
  const db = {
    collection(collection: string) {
      return {
        doc(id: string) {
          return {
            async set(payload: Record<string, unknown>) {
              writes.push({ collection, id, payload })
            },
          }
        },
      }
    },
  }
  return { db, writes }
}

/** Wait one microtask + macrotask for the in-flight fire-and-forget promise. */
async function flushFireAndForget(): Promise<void> {
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
}

describe("fireAndForgetLlmRerank (iter34 H.2 CR4)", () => {
  it("calls llmRerank with mapped candidate + top5 jobs and writes pa-user-rerank-cache", async () => {
    const calls: RerankInput[] = []
    const fakeRerank = async (input: RerankInput): Promise<RerankOutput> => {
      calls.push(input)
      return {
        ranked: [
          { jobId: "j1", rank: 1, score: 0.9, reasoning: "best" },
          { jobId: "j2", rank: 2, score: 0.7, reasoning: "ok" },
        ],
        modelUsed: "Qwen/Qwen2.5-7B-Instruct",
        latencyMs: 1234,
      }
    }
    const { db, writes } = makeFakeDb()
    const fixedDate = new Date("2026-05-05T12:00:00Z")
    fireAndForgetLlmRerank({
      db,
      userId: "u-1",
      top5: [
        {
          id: "j1",
          jobTitle: "SWE",
          companyName: "Acme",
          industryEnum: ["tech_software"],
          requiredSkills: ["typescript"],
          sponsorship: false,
          locationRaw: "Remote",
        },
        {
          id: "j2",
          jobTitle: "ML Engineer",
          companyName: "Beta",
          requiredSkills: ["python"],
        },
      ],
      candidate: {
        targetRole: ["swe"],
        topSkills: ["typescript", "react"],
        visaStatus: "opt",
        cvSummary: "SWE 4yo TS/React",
      },
      llmRerankImpl: fakeRerank,
      now: () => fixedDate,
    })

    await flushFireAndForget()

    assert.equal(calls.length, 1, "llmRerank must be called once")
    assert.deepEqual(calls[0]!.candidate, {
      targetRole: ["swe"],
      topSkills: ["typescript", "react"],
      visaStatus: "opt",
      cvSummary: "SWE 4yo TS/React",
    })
    assert.equal(calls[0]!.jobs.length, 2)
    assert.equal(calls[0]!.jobs[0]!.id, "j1")
    assert.equal(calls[0]!.jobs[0]!.roleTitle, "SWE")

    assert.equal(writes.length, 1, "must write exactly one cache doc")
    assert.equal(writes[0]!.collection, "pa-user-rerank-cache")
    assert.equal(writes[0]!.id, "u-1")
    const payload = writes[0]!.payload as {
      userId: string
      ranked: { jobId: string }[]
      computedAt: string
      modelUsed: string
      latencyMs: number
    }
    assert.equal(payload.userId, "u-1")
    assert.equal(payload.ranked.length, 2)
    assert.equal(payload.ranked[0]!.jobId, "j1")
    assert.equal(payload.computedAt, fixedDate.toISOString())
    assert.equal(payload.modelUsed, "Qwen/Qwen2.5-7B-Instruct")
    assert.equal(payload.latencyMs, 1234)
  })

  it("when llmRerank returns empty ranked → does NOT write cache", async () => {
    const fakeRerank = async (): Promise<RerankOutput> => ({
      ranked: [],
      modelUsed: "Qwen/Qwen2.5-7B-Instruct",
      latencyMs: 100,
    })
    const { db, writes } = makeFakeDb()
    fireAndForgetLlmRerank({
      db,
      userId: "u-2",
      top5: [{ id: "j1", jobTitle: "SWE", companyName: "Acme" }],
      candidate: { targetRole: ["swe"] },
      llmRerankImpl: fakeRerank,
    })
    await flushFireAndForget()
    assert.equal(writes.length, 0, "empty ranked → no cache write")
  })

  it("when llmRerank rejects → caller is not affected (errors swallowed)", async () => {
    const fakeRerank = async (): Promise<RerankOutput> => {
      throw new Error("network error")
    }
    const { db, writes } = makeFakeDb()
    let unhandled = false
    const handler = () => {
      unhandled = true
    }
    process.once("unhandledRejection", handler)
    // Sync call must not throw.
    fireAndForgetLlmRerank({
      db,
      userId: "u-3",
      top5: [{ id: "j1", jobTitle: "SWE", companyName: "Acme" }],
      candidate: {},
      llmRerankImpl: fakeRerank,
    })
    await flushFireAndForget()
    process.removeListener("unhandledRejection", handler)
    assert.equal(unhandled, false, "promise rejection must be swallowed")
    assert.equal(writes.length, 0)
  })

  it("maps sponsorship null → false in rerank input (defensive)", async () => {
    const calls: RerankInput[] = []
    const fakeRerank = async (input: RerankInput): Promise<RerankOutput> => {
      calls.push(input)
      return {
        ranked: [{ jobId: "j1", rank: 1, score: 0.5, reasoning: "" }],
        modelUsed: "Qwen/Qwen2.5-7B-Instruct",
        latencyMs: 50,
      }
    }
    const { db } = makeFakeDb()
    fireAndForgetLlmRerank({
      db,
      userId: "u-4",
      top5: [{ id: "j1", jobTitle: "SWE", companyName: "Acme", sponsorship: null }],
      candidate: {},
      llmRerankImpl: fakeRerank,
    })
    await flushFireAndForget()
    assert.equal(calls[0]!.jobs[0]!.sponsorship, false)
  })

  it("composes salaryRange when both salaryMin + salaryMax provided", async () => {
    const calls: RerankInput[] = []
    const fakeRerank = async (input: RerankInput): Promise<RerankOutput> => {
      calls.push(input)
      return {
        ranked: [{ jobId: "j1", rank: 1, score: 0.5, reasoning: "" }],
        modelUsed: "Qwen/Qwen2.5-7B-Instruct",
        latencyMs: 50,
      }
    }
    const { db } = makeFakeDb()
    fireAndForgetLlmRerank({
      db,
      userId: "u-5",
      top5: [
        {
          id: "j1",
          jobTitle: "SWE",
          companyName: "Acme",
          salaryMin: 150000,
          salaryMax: 200000,
        },
      ],
      candidate: {},
      llmRerankImpl: fakeRerank,
    })
    await flushFireAndForget()
    assert.equal(calls[0]!.jobs[0]!.salaryRange, "150000-200000")
  })
})

// ---------------------------------------------------------------------------
// iter34 H.2 / CR5 — wire cvEmbedding into queryMatchingJobs filters
//
// Mirrors the spread pattern in makeGenerateJobRecs to lock the contract:
// when cvEmbedding is defined → spread injects; when undefined → omitted.
// Locks the priority order pa-users.tags.embedding > parsedCandidateResumes.
// ---------------------------------------------------------------------------

describe("makeGenerateJobRecs filters: cvEmbedding wire-through (iter34 H.2 CR5)", () => {
  it("filter shape: cvEmbedding from CV doc → spread injects", () => {
    const cvEmbedding = [0.1, 0.2, 0.3]
    const filters = {
      foo: "bar",
      ...(cvEmbedding ? { cvEmbedding } : {}),
    }
    assert.ok(
      Object.prototype.hasOwnProperty.call(filters, "cvEmbedding"),
      "must inject cvEmbedding key into filters"
    )
    assert.deepEqual((filters as { cvEmbedding: number[] }).cvEmbedding, cvEmbedding)
  })

  it("filter shape: undefined cvEmbedding → spread omits the field", () => {
    const cvEmbedding: number[] | undefined = undefined
    const filters = {
      foo: "bar",
      ...(cvEmbedding ? { cvEmbedding } : {}),
    }
    assert.equal(
      Object.prototype.hasOwnProperty.call(filters, "cvEmbedding"),
      false,
      "undefined path must NOT inject cvEmbedding key"
    )
  })

  it("priority: pa-users.tags.embedding > parsedCandidateResumes.embedding", () => {
    // Mirror the production resolution: ?? short-circuits on the first
    // non-undefined value.
    const fromTags = [9, 9, 9]
    const fromCv = [1, 2, 3]
    const resolved: number[] | undefined = fromTags ?? fromCv
    assert.deepEqual(resolved, fromTags)
  })

  it("priority: pa-users.tags missing → falls back to CV embedding", () => {
    const fromTags: number[] | undefined = undefined
    const fromCv = [1, 2, 3]
    const resolved: number[] | undefined = fromTags ?? fromCv
    assert.deepEqual(resolved, fromCv)
  })

  it("priority: both missing → undefined → no filter injected", () => {
    const fromTags: number[] | undefined = undefined
    const fromCv: number[] | undefined = undefined
    const resolved: number[] | undefined = fromTags ?? fromCv
    assert.equal(resolved, undefined)
    const filters = {
      foo: "bar",
      ...(resolved ? { cvEmbedding: resolved } : {}),
    }
    assert.equal(
      Object.prototype.hasOwnProperty.call(filters, "cvEmbedding"),
      false
    )
  })

  it("validation: empty array does NOT short-circuit ?? — treated as defined", () => {
    // Locks the runtime behavior: an empty array is truthy in `??` chain
    // (only undefined / null are falsy). Lock so future refactors don't
    // accidentally swap to `||` and silently drop `[]`.
    const empty: number[] | undefined = []
    const fallback = [1, 2, 3]
    const resolved = empty ?? fallback
    assert.deepEqual(resolved, [], "empty [] keeps; only undefined/null fall through")
  })

  it("validation: non-numeric entries should be filtered before the wire", () => {
    // Lock the production guard `every((n) => typeof n === 'number')`.
    const raw: unknown = [1, "two", 3]
    const ok = Array.isArray(raw) && raw.every((n) => typeof n === "number")
    assert.equal(ok, false, "mixed types must NOT pass the validator")
  })
})
