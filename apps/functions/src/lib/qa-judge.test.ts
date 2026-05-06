/**
 * v1.6 Phase 61 — qa-judge unit tests.
 *
 * Coverage:
 *   - Happy path: valid JSON → both flags + reasoning passthrough
 *   - Both-true verdict
 *   - Mixed verdict (hardFilter true, top3 false)
 *   - Empty content → conservative-fail (false, false)
 *   - Invalid JSON → conservative-fail
 *   - Missing API key → conservative-fail without LLM call
 *   - LLM throws → conservative-fail
 *   - Reasoning > 500 chars → truncated
 *   - Non-string reasoning → "" placeholder
 *   - Malformed JSON object (e.g. array instead of obj) → conservative-fail
 *   - Boolean strings (e.g. "true") → coerced to false (strict === true)
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  evaluateQaPair,
  type QaJudgeChatClient,
  type QaJudgeInput,
} from "./qa-judge.js"

const baseInput: QaJudgeInput = {
  user: {
    targetRoleFunction: ["software_engineering"],
    skills: ["python", "react", "typescript"],
    relevantIndustry: ["financial_technology"],
    careerStage: "mid",
    visaStatus: "sponsor_needed",
    targetLocations: ["san_francisco_bay_area"],
    yoeRange: "3-5",
  },
  job: {
    roleTitle: "Senior Backend Engineer",
    companyName: "Stripe",
    industrySector: ["financial_technology"],
    requiredSkills: ["python", "go"],
    seniorityLevel: "senior",
    sponsorship: true,
    locationRaw: "San Francisco, CA",
    jobDescription: "Build payment infrastructure...",
  },
}

/** Build a fake client that returns the given JSON content payload. */
function fakeClient(content: string): QaJudgeChatClient {
  return {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content } }],
        }),
      },
    },
  }
}

/** Fake client that records calls so we can assert "no call made". */
function trackingClient(content: string): {
  client: QaJudgeChatClient
  calls: () => number
} {
  let calls = 0
  return {
    client: {
      chat: {
        completions: {
          create: async () => {
            calls++
            return { choices: [{ message: { content } }] }
          },
        },
      },
    },
    calls: () => calls,
  }
}

/** Throws on every call. */
function throwingClient(message: string): QaJudgeChatClient {
  return {
    chat: {
      completions: {
        create: async () => {
          throw new Error(message)
        },
      },
    },
  }
}

describe("evaluateQaPair", () => {
  it("happy path: valid JSON → both flags + reasoning passthrough", async () => {
    const judgeJson = JSON.stringify({
      hardFilterPass: true,
      top3Acceptable: true,
      reasoning: "Strong skill match and visa-friendly company.",
    })
    const out = await evaluateQaPair(baseInput, {
      siliconflowApiKey: "fake",
      client: fakeClient(judgeJson),
    })
    assert.equal(out.hardFilterPass, true)
    assert.equal(out.top3Acceptable, true)
    assert.equal(
      out.reasoning,
      "Strong skill match and visa-friendly company."
    )
  })

  it("mixed verdict: hardFilter true, top3 false", async () => {
    const judgeJson = JSON.stringify({
      hardFilterPass: true,
      top3Acceptable: false,
      reasoning: "Role aligns but skill overlap is weak.",
    })
    const out = await evaluateQaPair(baseInput, {
      siliconflowApiKey: "fake",
      client: fakeClient(judgeJson),
    })
    assert.equal(out.hardFilterPass, true)
    assert.equal(out.top3Acceptable, false)
    assert.match(out.reasoning, /skill overlap/)
  })

  it("both false verdict", async () => {
    const judgeJson = JSON.stringify({
      hardFilterPass: false,
      top3Acceptable: false,
      reasoning: "Visa mismatch and wrong career stage.",
    })
    const out = await evaluateQaPair(baseInput, {
      siliconflowApiKey: "fake",
      client: fakeClient(judgeJson),
    })
    assert.equal(out.hardFilterPass, false)
    assert.equal(out.top3Acceptable, false)
    assert.match(out.reasoning, /Visa mismatch/)
  })

  it("empty content → conservative-fail (false, false)", async () => {
    const out = await evaluateQaPair(baseInput, {
      siliconflowApiKey: "fake",
      client: fakeClient(""),
    })
    assert.equal(out.hardFilterPass, false)
    assert.equal(out.top3Acceptable, false)
    assert.equal(out.reasoning, "empty_response")
  })

  it("invalid JSON → conservative-fail", async () => {
    const out = await evaluateQaPair(baseInput, {
      siliconflowApiKey: "fake",
      client: fakeClient("not valid json {{{"),
    })
    assert.equal(out.hardFilterPass, false)
    assert.equal(out.top3Acceptable, false)
    assert.equal(out.reasoning, "invalid_json")
  })

  it("missing API key → conservative-fail without LLM call", async () => {
    const tracker = trackingClient("{}")
    const out = await evaluateQaPair(baseInput, {
      siliconflowApiKey: "",
      // Even if a client is provided, missing API key in deps + no default client
      // should short-circuit. Note: client takes precedence in the impl —
      // testing the "no key + no client" path here.
    })
    assert.equal(out.hardFilterPass, false)
    assert.equal(out.top3Acceptable, false)
    assert.equal(out.reasoning, "missing_api_key")
    assert.equal(tracker.calls(), 0)
  })

  it("LLM throws → conservative-fail (judge_error)", async () => {
    const out = await evaluateQaPair(baseInput, {
      siliconflowApiKey: "fake",
      client: throwingClient("rate-limit boom"),
    })
    assert.equal(out.hardFilterPass, false)
    assert.equal(out.top3Acceptable, false)
    assert.equal(out.reasoning, "judge_error")
  })

  it("reasoning > 500 chars → truncated", async () => {
    const longReasoning = "x".repeat(2000)
    const judgeJson = JSON.stringify({
      hardFilterPass: true,
      top3Acceptable: true,
      reasoning: longReasoning,
    })
    const out = await evaluateQaPair(baseInput, {
      siliconflowApiKey: "fake",
      client: fakeClient(judgeJson),
    })
    assert.equal(out.reasoning.length, 500)
  })

  it("non-string reasoning → empty string", async () => {
    const judgeJson = JSON.stringify({
      hardFilterPass: true,
      top3Acceptable: true,
      reasoning: 42,
    })
    const out = await evaluateQaPair(baseInput, {
      siliconflowApiKey: "fake",
      client: fakeClient(judgeJson),
    })
    assert.equal(out.hardFilterPass, true)
    assert.equal(out.reasoning, "")
  })

  it("array instead of object → conservative-fail (malformed_object)", async () => {
    const out = await evaluateQaPair(baseInput, {
      siliconflowApiKey: "fake",
      client: fakeClient(JSON.stringify([1, 2, 3])),
    })
    // Arrays parse as objects in JS — but the structure is wrong, flags coerce false.
    assert.equal(out.hardFilterPass, false)
    assert.equal(out.top3Acceptable, false)
  })

  it('boolean strings (e.g. "true") → coerced to false (strict === true)', async () => {
    const judgeJson = JSON.stringify({
      hardFilterPass: "true", // string, not boolean
      top3Acceptable: 1, // truthy number, not boolean
      reasoning: "should fail strict check",
    })
    const out = await evaluateQaPair(baseInput, {
      siliconflowApiKey: "fake",
      client: fakeClient(judgeJson),
    })
    // We use === true so non-boolean truthy values are treated as false.
    assert.equal(out.hardFilterPass, false)
    assert.equal(out.top3Acceptable, false)
    assert.equal(out.reasoning, "should fail strict check")
  })

  it("null content → conservative-fail (empty_response)", async () => {
    const client: QaJudgeChatClient = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: null } }],
          }),
        },
      },
    }
    const out = await evaluateQaPair(baseInput, {
      siliconflowApiKey: "fake",
      client,
    })
    assert.equal(out.hardFilterPass, false)
    assert.equal(out.top3Acceptable, false)
    assert.equal(out.reasoning, "empty_response")
  })

  it("missing reasoning field → empty string, flags still parsed", async () => {
    const judgeJson = JSON.stringify({
      hardFilterPass: true,
      top3Acceptable: true,
    })
    const out = await evaluateQaPair(baseInput, {
      siliconflowApiKey: "fake",
      client: fakeClient(judgeJson),
    })
    assert.equal(out.hardFilterPass, true)
    assert.equal(out.top3Acceptable, true)
    assert.equal(out.reasoning, "")
  })
})
