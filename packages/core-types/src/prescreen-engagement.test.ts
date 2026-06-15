import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  computePrescreenEngagement,
  engagementTone,
  summarizeEngagementSignal,
  ENGAGEMENT_SIGNAL_VERSION,
} from "./prescreen-engagement.js"

describe("computePrescreenEngagement — counts", () => {
  it("no replies → low, zeroed metrics, never throws", () => {
    const s = computePrescreenEngagement([])
    assert.equal(s.level, "low")
    assert.equal(s.answeredCount, 0)
    assert.equal(s.totalWords, 0)
    assert.equal(s.avgWordsPerAnswer, 0)
    assert.equal(s.shortAnswerRatio, 0)
    assert.match(s.evidence, /no candidate replies/i)
  })

  it("ignores empty / whitespace / null replies", () => {
    const s = computePrescreenEngagement(["", "   ", null, undefined, "yes"])
    assert.equal(s.answeredCount, 1)
    assert.equal(s.totalWords, 1)
  })

  it("counts words, chars, short and detailed answers", () => {
    const long =
      "I led the migration of our billing service from a monolith to event-driven microservices over two quarters, cutting p99 latency in half and onboarding three engineers"
    const s = computePrescreenEngagement(["ok", long])
    assert.equal(s.answeredCount, 2)
    assert.equal(s.shortAnswerCount, 1) // "ok" is < 4 words
    assert.equal(s.detailedAnswerCount, 1) // the long one is >= 25 words
    assert.ok(s.maxWordsInAnswer >= 25)
    assert.ok(s.totalChars > 100)
  })
})

describe("computePrescreenEngagement — bucketing (advisory)", () => {
  it("one-word / one-line answers → low", () => {
    const s = computePrescreenEngagement(["yes", "idk", "ok sure", "maybe"])
    assert.equal(s.level, "low")
    assert.match(s.evidence, /minimal, low-effort/i)
  })

  it("short total even with one longer line → low", () => {
    const s = computePrescreenEngagement(["I worked there"]) // 3 words, under LOW_TOTAL_WORDS
    assert.equal(s.level, "low")
  })

  it("several substantial, specific answers → high", () => {
    const a1 =
      "At Stripe I owned the dispute automation pipeline, designing the rules engine and shipping it to production where it handled forty thousand cases a month"
    const a2 =
      "Before that I built the internal analytics dashboard in React and TypeScript, integrating it with our Snowflake warehouse and rolling it out to the whole sales org"
    const a3 =
      "I mentored two junior engineers through their first on-call rotations and wrote the runbooks that cut our mean time to recovery roughly in half"
    const s = computePrescreenEngagement([a1, a2, a3])
    assert.equal(s.level, "high")
    assert.equal(s.label, "Detailed / engaged")
    assert.ok(s.detailedAnswerCount >= 1)
    assert.match(s.evidence, /detailed, specific/i)
  })

  it("a couple of medium answers → medium (not high, not low)", () => {
    const s = computePrescreenEngagement([
      "I have about three years building React apps for fintech startups",
      "Mostly TypeScript and some Python on the backend side",
    ])
    assert.equal(s.level, "medium")
  })
})

describe("engagement helpers", () => {
  it("tone maps high→ok, medium→info, low→warn (nudge, not hard reject)", () => {
    assert.equal(engagementTone("high"), "ok")
    assert.equal(engagementTone("medium"), "info")
    assert.equal(engagementTone("low"), "warn")
    assert.equal(engagementTone(undefined), "muted")
  })

  it("summary always flags itself advisory / never a reject reason", () => {
    const s = computePrescreenEngagement(["yes", "no"])
    const line = summarizeEngagementSignal(s)
    assert.match(line, /advisory/i)
    assert.match(line, /never a reject reason/i)
    assert.match(line, /LOW/)
  })

  it("carries a version for migrations", () => {
    assert.equal(computePrescreenEngagement(["hi"]).version, ENGAGEMENT_SIGNAL_VERSION)
  })
})
