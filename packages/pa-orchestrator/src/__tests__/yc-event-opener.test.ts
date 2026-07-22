import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  buildYcEventOpenerBody,
  parseHelloWekruitOpener,
  isSharedOnboardingGreetingOrKickoff,
} from "../shared-onboarding.js"

const TOKEN = "3f9c2a10-8b4e-4d6f-9a12-77cc01ab34de" // UUID scanToken shape

describe("YC Startup School event opener (2026-07-21)", () => {
  it("builder → parser round-trips the scanToken as candidateId", () => {
    const body = buildYcEventOpenerBody(TOKEN)
    assert.equal(body, `Hey! I'm at YC Startup School — my code is ${TOKEN}`)
    const parsed = parseHelloWekruitOpener(body)
    assert.deepEqual(parsed, { candidateId: TOKEN })
  })

  it("tolerates autocorrect / phrasing drift", () => {
    const variants = [
      `hey im at yc startup school this is code ${TOKEN}`,
      `Hey, I’m at YC Startup School, this is my code ${TOKEN}`,
      `hi I'm at yc startup school - my code is ${TOKEN}`,
      `I'm at YC Startup School… code: ${TOKEN}`,
    ]
    for (const v of variants) {
      const parsed = parseHelloWekruitOpener(v)
      assert.deepEqual(parsed, { candidateId: TOKEN }, `failed on: ${v}`)
    }
  })

  it("tokenless send still classifies as a greeting/kickoff (no dead silence)", () => {
    assert.equal(parseHelloWekruitOpener("Hey! I'm at YC Startup School — my code is"), null)
    assert.equal(isSharedOnboardingGreetingOrKickoff("Hey! I'm at YC Startup School"), true)
  })

  it("does not swallow unrelated messages", () => {
    assert.equal(parseHelloWekruitOpener("I'm at the airport, code red situation"), null)
    assert.equal(parseHelloWekruitOpener("yc startup school was fun"), null)
  })
})
