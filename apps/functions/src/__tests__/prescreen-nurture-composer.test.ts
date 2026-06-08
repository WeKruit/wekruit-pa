/**
 * Prescreen-NURTURE composer unit tests — context facts + instruction shape.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  buildPrescreenNurtureContext,
  buildNurtureInstruction,
  NURTURE_PIPELINE_STAGE,
  type NurtureComposerStore,
} from "../prescreen-nurture-composer.js"

function makeStore(over?: Partial<NurtureComposerStore>): NurtureComposerStore {
  return {
    fetchJob: async () => ({ title: "Senior Backend Engineer", company: "Acme Robotics" }),
    fetchSessionScore: async () => ({ score: 0.8, scoreMax: 1 }),
    fetchPreferredLanguage: async () => "en",
    ...over,
  }
}

describe("buildPrescreenNurtureContext — personalization", () => {
  it("references the actual job title + company (personalized, not generic)", async () => {
    const ctx = await buildPrescreenNurtureContext(makeStore(), {
      candidateId: "u1",
      jobId: "j1",
      sessionId: "s1",
      nurturingNumber: 1,
    })
    assert.equal(ctx.eventKind, "prescreen_review_nurture_v1")
    assert.equal(ctx.candidateId, "u1")
    assert.equal(ctx.jobId, "j1")
    assert.equal(ctx.sessionId, "s1")
    assert.equal(ctx.pipelineStage, NURTURE_PIPELINE_STAGE)
    assert.equal(ctx.jobTitle, "Senior Backend Engineer")
    assert.equal(ctx.companyName, "Acme Robotics")
    assert.equal(ctx.preferredLanguage, "en")
    assert.match(ctx.instruction, /Senior Backend Engineer/)
    assert.match(ctx.instruction, /Acme Robotics/)
  })

  it("carries the candidate's preferred language", async () => {
    const ctx = await buildPrescreenNurtureContext(
      makeStore({ fetchPreferredLanguage: async () => "zh" }),
      { candidateId: "u1", jobId: "j1", sessionId: "s1", nurturingNumber: 2 }
    )
    assert.equal(ctx.preferredLanguage, "zh")
    assert.equal(ctx.nurturingNumber, 2)
  })

  it("fails open to a less-specific (still valid) instruction when job read throws", async () => {
    const ctx = await buildPrescreenNurtureContext(
      makeStore({
        fetchJob: async () => {
          throw new Error("missing job")
        },
      }),
      { candidateId: "u1", jobId: "j1", sessionId: "s1", nurturingNumber: 1 }
    )
    assert.equal(ctx.jobTitle, undefined)
    assert.equal(ctx.companyName, undefined)
    assert.match(ctx.instruction, /role they interviewed for/)
    assert.equal(ctx.preferredLanguage, "en")
  })

  it("defaults language to en when unknown", async () => {
    const ctx = await buildPrescreenNurtureContext(
      makeStore({ fetchPreferredLanguage: async () => undefined }),
      { candidateId: "u1", jobId: "j1", sessionId: "s1", nurturingNumber: 1 }
    )
    assert.equal(ctx.preferredLanguage, "en")
  })
})

describe("buildNurtureInstruction — guardrails", () => {
  it("instructs brief warmth, no promises, natural variation, and a __NO_SEND__ escape", () => {
    const ins = buildNurtureInstruction({
      jobTitle: "Data Scientist",
      companyName: "Globex",
      nurturingNumber: 3,
    })
    assert.match(ins, /brief/i)
    assert.match(ins, /1-2 sentences/i)
    assert.match(ins, /no promises/i)
    assert.match(ins, /vary your wording/i)
    assert.match(ins, /check-in #3/)
    assert.match(ins, /__NO_SEND__/)
    // Must NOT hardcode a candidate-facing canned message string.
    assert.doesNotMatch(ins, /good news soon!/)
  })

  it("varies its referenced role per nurture number so copy is not templated", () => {
    const a = buildNurtureInstruction({ jobTitle: "X", companyName: "Y", nurturingNumber: 1 })
    const b = buildNurtureInstruction({ jobTitle: "X", companyName: "Y", nurturingNumber: 2 })
    assert.notEqual(a, b)
    assert.match(a, /check-in #1/)
    assert.match(b, /check-in #2/)
  })
})
