import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  collectJobRecommendationMessageItems,
  composeJobRecommendationMessage,
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
})
