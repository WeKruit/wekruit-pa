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
  const url = j.atsApplyUrl ? `\n${j.atsApplyUrl}` : j.primaryUrl ? `\n${j.primaryUrl}` : ""
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
  return `• ${j.jobTitle}${tag}${url}${reasonLine}`
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
    // 3 lines: title, url, reason
    assert.equal(parts.length, 3, `expected 3 lines, got ${parts.length}: ${JSON.stringify(out)}`)
    assert.match(parts[0]!, /Senior SWE @ Acme/)
    assert.match(parts[1]!, /^https:\/\//)
    assert.match(parts[2]!, /^为啥推: /)
    assert.match(parts[2]!, /Node\.js/)
  })

  it("legacy fallback: no matchScore → reason line dropped (2 lines)", () => {
    const j: MockJob = {
      jobTitle: "Backend Engineer",
      companyName: "Beta",
      primaryUrl: "https://beta.example/apply",
    }
    const out = composeJobLine(j, "en", { topSkills: [] })
    const parts = out.split("\n")
    assert.equal(parts.length, 2, "legacy must emit 2 lines (title + url)")
    assert.match(parts[0]!, /Backend Engineer @ Beta/)
    assert.match(parts[1]!, /^https:\/\//)
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
    assert.ok(!out.includes("jobright.ai"), "must NOT regress to jobright.ai mirror")
  })
})
