import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  buildJobRecommendationRuntimeContext,
  collectJobRecommendationMessageItems,
  collectLiveJobRecommendationMessageItems,
  composeJobRecommendationMessage,
  cleanJobRecUrl,
  toJobRecommendationMessageItem,
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
