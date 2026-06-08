import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  buildJobRecommendationRuntimeContext,
  collectJobRecommendationMessageItems,
  collectLiveJobRecommendationMessageItems,
  composeJobRecommendationMessage,
  cleanJobRecUrl,
  DEFAULT_MAX_RECS_PER_DELIVERY,
  prioritizeAndCapRecItems,
  resolveMaxRecsPerDelivery,
  toJobRecommendationMessageItem,
  type JobRecommendationMessageItem,
} from "./job-rec-copy.js"

describe("job recommendation visible-message contract", () => {
  it("only creates message items when the recommendation has a usable URL", () => {
    const items = collectJobRecommendationMessageItems(
      [
        {
          jobTitle: "Fullstack Engineer",
          companyName: "Rain",
          primaryUrl: "https://jobright.ai/jobs/123",
          requiredSkills: ["React", "Node.js"],
        },
        {
          jobTitle: "Frontend Engineer",
          companyName: "Acme",
          atsApplyUrl: "https://jobs.ashbyhq.com/acme/frontend",
          requiredSkills: ["TypeScript", "React", "data_modeling"],
        },
      ],
      "en",
      { limit: 3 },
    )

    assert.equal(items.length, 1)
    assert.equal(items[0]!.title, "Frontend Engineer")
    assert.equal(items[0]!.url, "https://jobs.ashbyhq.com/acme/frontend")
    assert.equal(items[0]!.requirementsLine, "requirements: TypeScript, React, data modeling")
  })

  it("skips recommendations that do not have concrete requirements", () => {
    const items = collectJobRecommendationMessageItems(
      [
        {
          jobTitle: "Frontend Engineer",
          companyName: "Acme",
          atsApplyUrl: "https://jobs.ashbyhq.com/acme/frontend",
          requiredSkills: [],
        },
        {
          jobTitle: "Fullstack Engineer",
          companyName: "Rain",
          atsApplyUrl: "https://jobs.ashbyhq.com/rain/fullstack",
          requiredSkills: ["React", "Node.js", "SQL"],
        },
      ],
      "en",
      { limit: 2 },
    )

    assert.equal(items.length, 1)
    assert.equal(items[0]!.title, "Fullstack Engineer")
    assert.equal(items[0]!.requirementsLine, "requirements: React, Node.js, SQL")
  })

  it("normalizes YC Work at a Startup company job-list URLs to the live company page", () => {
    assert.equal(
      cleanJobRecUrl({
        atsApplyUrl: "https://www.workatastartup.com/companies/adaptional/jobs",
      }),
      "https://www.workatastartup.com/companies/adaptional",
    )
  })

  it("the message composer accepts only already-linkable message items and always renders URL plus requirements", () => {
    const item = toJobRecommendationMessageItem(
      {
        jobTitle: "Backend Engineer",
        companyName: "Rain",
        atsApplyUrl: "https://boards.greenhouse.io/rain/jobs/42",
        requiredSkills: ["Java", "SQL"],
        reason: "why: your SQL dashboard work maps to this backend role",
      },
      "en",
    )
    assert.ok(item, "expected a linkable message item")

    const body = composeJobRecommendationMessage([item], "en", {
      role: "fullstack engineering",
    })

    assert.match(body, /I remember you mentioned the fullstack engineering direction/)
    assert.match(body, /Backend Engineer @ Rain/)
    assert.match(body, /https:\/\/boards\.greenhouse\.io\/rain\/jobs\/42/)
    assert.match(body, /requirements: Java, SQL/)
    assert.match(body, /why: your SQL dashboard work maps to this backend role/)
  })

  it("normalizes legacy English reason labels to the runtime-visible why label", () => {
    const item = toJobRecommendationMessageItem(
      {
        jobTitle: "Fullstack Engineer",
        companyName: "Acme",
        atsApplyUrl: "https://jobs.ashbyhq.com/acme/fullstack",
        requiredSkills: ["React", "Node.js"],
        reason: "Why match: your React and Node work lines up",
      },
      "en",
    )
    assert.ok(item, "expected a linkable message item")

    const body = composeJobRecommendationMessage([item], "en")
    assert.match(body, /why: your React and Node work lines up/)
    assert.doesNotMatch(body, /Why match:/)
  })

  it("uses singular grammar when rendering exactly one recommended role", () => {
    const item = toJobRecommendationMessageItem(
      {
        jobTitle: "Frontend Engineer",
        companyName: "Acme",
        atsApplyUrl: "https://jobs.ashbyhq.com/acme/frontend",
        requiredSkills: ["React"],
      },
      "en",
    )
    assert.ok(item, "expected a linkable message item")

    const body = composeJobRecommendationMessage([item], "en")

    assert.match(body, /I found one role that lines up:/)
    assert.doesNotMatch(body, /one role that line up/)
  })

  it("surfaces repeat recommendation state in runtime context", () => {
    const items = collectJobRecommendationMessageItems(
      [
        {
          id: "job-repeat",
          jobTitle: "Frontend Engineer",
          companyName: "Acme",
          atsApplyUrl: "https://jobs.ashbyhq.com/acme/frontend",
          requiredSkills: ["React"],
          previouslyRecommended: true,
          recommendationCount: 2,
          lastRecommendedAt: "2026-05-17T12:00:00.000Z",
        },
      ],
      "en",
      { limit: 1 },
    )

    const context = buildJobRecommendationRuntimeContext(items, undefined, { requestedCount: 1 })
    const jobs = context.jobs as Array<Record<string, unknown>>
    assert.equal(jobs[0]!.previouslyRecommended, true)
    assert.equal(jobs[0]!.recommendationCount, 2)
    assert.equal(jobs[0]!.lastRecommendedAt, "2026-05-17T12:00:00.000Z")
    assert.match(JSON.stringify(context.instructions), /may be a repeat/)
    const body = composeJobRecommendationMessage(items, "en")
    assert.match(body, /may have shared this before/)
  })

  it("keeps internal match-source labels out of candidate-visible recommendation copy", () => {
    const items = collectJobRecommendationMessageItems(
      [
        {
          jobTitle: "Media Ops & Analytics Intern",
          companyName: "Stride",
          atsApplyUrl: "https://stride.example/jobs/1?ref=Simplify",
          requiredSkills: ["media_operations", "data_analysis"],
          reason: "reason: same lane as your brain_performance_technologies stint",
          matchSourceLabel: "general match",
        },
      ],
      "en",
      { limit: 1 },
    )

    const body = composeJobRecommendationMessage(items, "en")
    assert.doesNotMatch(body, /matchSourceLabel/i)
    assert.doesNotMatch(body, /general match/i)
    assert.doesNotMatch(body, /brain_performance_technologies/i)
    assert.doesNotMatch(body, /same lane as your/i)
  })

  it("keeps specific cleaned reason copy but suppresses generic reason templates", () => {
    const specific = collectJobRecommendationMessageItems(
      [
        {
          jobTitle: "Frontend Engineer",
          companyName: "Acme",
          atsApplyUrl: "https://jobs.ashbyhq.com/acme/frontend",
          requiredSkills: ["React"],
          reason: "why: your OFO dashboard work maps to React-heavy product UI",
        },
      ],
      "en",
      { limit: 1 },
    )
    assert.equal(specific[0]?.reason, "why: your OFO dashboard work maps to React-heavy product UI")

    const generic = collectJobRecommendationMessageItems(
      [
        {
          jobTitle: "Sales Analytics Manager",
          companyName: "Acme",
          atsApplyUrl: "https://jobs.ashbyhq.com/acme/sales-analytics-manager",
          requiredSkills: ["SQL"],
          reason: "why: industry + experience align",
        },
      ],
      "en",
      { limit: 1 },
    )
    assert.equal(generic[0]?.reason, undefined)
  })

  it("filters senior and management roles from early-career candidate-visible batches", () => {
    const items = collectJobRecommendationMessageItems(
      [
        {
          jobTitle: "Senior Data Analyst",
          companyName: "Acme",
          atsApplyUrl: "https://jobs.ashbyhq.com/acme/senior-data",
          requiredSkills: ["SQL"],
          seniorityLevel: "senior",
        },
        {
          jobTitle: "Sales Analytics Manager",
          companyName: "Beta",
          atsApplyUrl: "https://jobs.ashbyhq.com/beta/sales-analytics-manager",
          requiredSkills: ["SQL"],
          seniorityLevel: "manager",
        },
        {
          jobTitle: "Data Analyst",
          companyName: "Gamma",
          atsApplyUrl: "https://jobs.ashbyhq.com/gamma/data-analyst",
          requiredSkills: ["SQL", "Excel"],
          seniorityLevel: "entry_level",
        },
      ],
      "en",
      {
        limit: 3,
        candidateTags: { careerStage: "entry_level", yoeRange: [0, 3] },
      },
    )

    assert.equal(items.length, 1)
    assert.equal(items[0]?.title, "Data Analyst")
  })

  it("does not instruct runtime LLMs to expose matchSourceLabel", () => {
    const items = collectJobRecommendationMessageItems(
      [
        {
          jobTitle: "Frontend Engineer",
          companyName: "Acme",
          atsApplyUrl: "https://jobs.ashbyhq.com/acme/frontend",
          requiredSkills: ["React"],
          matchSourceLabel: "general match",
        },
      ],
      "en",
      { limit: 1 },
    )

    const context = buildJobRecommendationRuntimeContext(items)
    assert.doesNotMatch(JSON.stringify(context), /matchSourceLabel/)
    assert.equal(context.trustedOutboundBody, composeJobRecommendationMessage(items, "en"))
  })

  it("propagates a neutral collab boolean (not the internal label) so downstream copy can gate WeKruit-screen framing", () => {
    const collabItems = collectJobRecommendationMessageItems(
      [
        {
          jobTitle: "Product Designer",
          companyName: "Invoko",
          atsApplyUrl: "https://candidate.wekruit.com/j/invoko",
          requiredSkills: ["Figma"],
          matchSourceLabel: "WeKruit collaborated",
        },
      ],
      "en",
      { limit: 1 },
    )
    const externalItems = collectJobRecommendationMessageItems(
      [
        {
          jobTitle: "Associate Account Executive",
          companyName: "rho",
          atsApplyUrl: "https://jobright.ai/jobs/info/abc",
          requiredSkills: ["sales"],
          matchSourceLabel: "general match",
        },
      ],
      "en",
      { limit: 1 },
    )

    const collabContext = buildJobRecommendationRuntimeContext(collabItems)
    const externalContext = buildJobRecommendationRuntimeContext(externalItems)

    assert.equal((collabContext.jobs as Array<{ collab?: unknown }>)[0]?.collab, true)
    assert.equal((externalContext.jobs as Array<{ collab?: unknown }>)[0]?.collab, false)
    // The internal label string must never reach the runtime/LLM-visible context.
    assert.doesNotMatch(JSON.stringify(collabContext), /matchSourceLabel|WeKruit collaborated/)
  })

  it("live collection skips and reports candidate-visible dead URLs before composing", async () => {
    const deadJobs: Array<{ id: string; reason: string; url: string }> = []
    const items = await collectLiveJobRecommendationMessageItems(
      [
        {
          id: "dead-job",
          jobTitle: "Backend Engineer",
          companyName: "DeadCo",
          atsApplyUrl: "https://dead.example/jobs/1",
          requiredSkills: ["Python"],
        },
        {
          id: "live-job",
          jobTitle: "Infrastructure Engineer",
          companyName: "LiveCo",
          atsApplyUrl: "https://live.example/jobs/1",
          requiredSkills: ["Python", "AWS"],
        },
      ],
      "en",
      {
        limit: 1,
        fetchImpl: async (url) =>
          new Response(null, { status: url.includes("dead.example") ? 404 : 200 }),
        onDeadJob: async (job, verdict, url) => {
          deadJobs.push({ id: String(job.id), reason: verdict.reason, url })
        },
      },
    )

    assert.equal(items.length, 1)
    assert.equal(items[0]!.sourceJob.id, "live-job")
    assert.deepEqual(deadJobs, [
      {
        id: "dead-job",
        reason: "http_404",
        url: "https://dead.example/jobs/1",
      },
    ])
  })
})

describe("per-delivery role cap + collab priority (paMaxRecsPerDelivery)", () => {
  function makeItem(
    id: string,
    label: "WeKruit collaborated" | "general match",
  ): JobRecommendationMessageItem {
    return {
      title: `Role ${id}`,
      companyName: `Co ${id}`,
      url: `https://jobs.example/${id}`,
      requirementsLine: "requirements: React",
      matchSourceLabel: label,
      previouslyRecommended: false,
      sourceJob: { id, matchSourceLabel: label },
    }
  }

  it("flag default is 3 and clamps out-of-range / non-numeric values to [1,6]", () => {
    assert.equal(DEFAULT_MAX_RECS_PER_DELIVERY, 3)
    // default fallbacks
    assert.equal(resolveMaxRecsPerDelivery(undefined), 3)
    assert.equal(resolveMaxRecsPerDelivery(false), 3)
    assert.equal(resolveMaxRecsPerDelivery(null), 3)
    assert.equal(resolveMaxRecsPerDelivery("not-a-number"), 3)
    assert.equal(resolveMaxRecsPerDelivery(0), 3) // 0 || default → 3
    // clamp lower / upper bounds
    assert.equal(resolveMaxRecsPerDelivery(-5), 1)
    assert.equal(resolveMaxRecsPerDelivery(99), 6)
    assert.equal(resolveMaxRecsPerDelivery(6), 6)
    // in-range numeric + numeric-string pass through
    assert.equal(resolveMaxRecsPerDelivery(2), 2)
    assert.equal(resolveMaxRecsPerDelivery("4"), 4)
  })

  it("prioritizeAndCapRecItems keeps collab roles first and slices to the cap", () => {
    const items = [
      makeItem("g1", "general match"),
      makeItem("c1", "WeKruit collaborated"),
      makeItem("g2", "general match"),
      makeItem("c2", "WeKruit collaborated"),
      makeItem("g3", "general match"),
    ]
    const capped = prioritizeAndCapRecItems(items, 3)
    assert.equal(capped.length, 3)
    // collab roles (c1, c2) must be retained ahead of general; general fills 1 slot
    assert.deepEqual(
      capped.map((i) => i.sourceJob.id),
      ["c1", "c2", "g1"],
    )
  })

  it("a 6-match find_match (collab + regular) delivers ≤3 bubbles, collab prioritized", async () => {
    // 2 collab + 4 regular, all live. cap via maxRecs=3.
    const jobs = [
      { id: "g1", jobTitle: "General 1", companyName: "G1", atsApplyUrl: "https://live.example/g1", requiredSkills: ["React"], matchSourceLabel: "general match" },
      { id: "c1", jobTitle: "Collab 1", companyName: "C1", atsApplyUrl: "https://live.example/c1", requiredSkills: ["React"], matchSourceLabel: "WeKruit collaborated" },
      { id: "g2", jobTitle: "General 2", companyName: "G2", atsApplyUrl: "https://live.example/g2", requiredSkills: ["React"], matchSourceLabel: "general match" },
      { id: "g3", jobTitle: "General 3", companyName: "G3", atsApplyUrl: "https://live.example/g3", requiredSkills: ["React"], matchSourceLabel: "general match" },
      { id: "c2", jobTitle: "Collab 2", companyName: "C2", atsApplyUrl: "https://live.example/c2", requiredSkills: ["React"], matchSourceLabel: "WeKruit collaborated" },
      { id: "g4", jobTitle: "General 4", companyName: "G4", atsApplyUrl: "https://live.example/g4", requiredSkills: ["React"], matchSourceLabel: "general match" },
    ]
    const items = await collectLiveJobRecommendationMessageItems(jobs, "en", {
      maxRecs: 3,
      maxCandidates: 6,
      fetchImpl: async () => new Response(null, { status: 200 }),
    })
    assert.equal(items.length, 3)
    const ids = items.map((i) => String(i.sourceJob.id))
    // both collab roles survive the cap
    assert.ok(ids.includes("c1"), "collab c1 must be delivered")
    assert.ok(ids.includes("c2"), "collab c2 must be delivered")
    // collab roles ranked ahead of general
    assert.deepEqual(ids.slice(0, 2).sort(), ["c1", "c2"])
  })

  it("never drops a collab role to surface a regular one when cap < collab count", async () => {
    const jobs = [
      { id: "g1", jobTitle: "General 1", companyName: "G1", atsApplyUrl: "https://live.example/g1", requiredSkills: ["React"], matchSourceLabel: "general match" },
      { id: "c1", jobTitle: "Collab 1", companyName: "C1", atsApplyUrl: "https://live.example/c1", requiredSkills: ["React"], matchSourceLabel: "WeKruit collaborated" },
      { id: "c2", jobTitle: "Collab 2", companyName: "C2", atsApplyUrl: "https://live.example/c2", requiredSkills: ["React"], matchSourceLabel: "WeKruit collaborated" },
    ]
    const items = await collectLiveJobRecommendationMessageItems(jobs, "en", {
      maxRecs: 1,
      maxCandidates: 3,
      fetchImpl: async () => new Response(null, { status: 200 }),
    })
    assert.equal(items.length, 1)
    assert.equal(String(items[0]!.sourceJob.id), "c1") // collab, not the V16-top general g1
  })

  it("collectJobRecommendationMessageItems honors maxRecs with collab priority", () => {
    const items = collectJobRecommendationMessageItems(
      [
        { id: "g1", jobTitle: "General 1", companyName: "G1", atsApplyUrl: "https://live.example/g1", requiredSkills: ["React"], matchSourceLabel: "general match" },
        { id: "c1", jobTitle: "Collab 1", companyName: "C1", atsApplyUrl: "https://live.example/c1", requiredSkills: ["React"], matchSourceLabel: "WeKruit collaborated" },
        { id: "g2", jobTitle: "General 2", companyName: "G2", atsApplyUrl: "https://live.example/g2", requiredSkills: ["React"], matchSourceLabel: "general match" },
        { id: "g3", jobTitle: "General 3", companyName: "G3", atsApplyUrl: "https://live.example/g3", requiredSkills: ["React"], matchSourceLabel: "general match" },
      ],
      "en",
      { maxRecs: 2 },
    )
    assert.equal(items.length, 2)
    assert.equal(String(items[0]!.sourceJob.id), "c1") // collab first
  })
})
