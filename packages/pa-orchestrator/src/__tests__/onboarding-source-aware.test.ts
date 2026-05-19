import test from "node:test"
import assert from "node:assert/strict"
import { composeOnboardingInput, WEKRUIT_LAYOFF_SOURCE } from "../onboarding.js"
import type { AgentDef } from "@pa/core-types"

// 2026-05-19 — layoff-flavored opener bits (renderLayoffOnboardingOpener +
// SourceAwareOnboardingContext) were deleted. Candidate SMS opener must
// never leak source provenance. These tests assert send_first_mes stays
// generic regardless of source.

const agent = {
  id: "claire",
  name: "Claire",
  systemPrompt: "First message: Hey, Claire from WeKruit.",
  tools: [],
  memoryMode: "none" as const,
} as unknown as AgentDef

test("composeOnboardingInput never emits a layoff-flavored opener", () => {
  const input = composeOnboardingInput("send_first_mes", agent, {
    userMessage: "Hi",
  })

  assert.doesNotMatch(input, /send_first_mes_layoff/)
  assert.doesNotMatch(input, /layoff/i)
  assert.doesNotMatch(input, /WeKruit_Laid_Off/)
})

test("source label stays canonical for DB provenance use", () => {
  assert.equal(WEKRUIT_LAYOFF_SOURCE, "WeKruit_Laid_Off")
})
