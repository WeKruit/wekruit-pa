import test from "node:test"
import assert from "node:assert/strict"
import {
  LAYOFF_ONBOARDING_SOURCE,
  composeOnboardingInput,
  renderLayoffOnboardingOpener,
} from "../onboarding.js"
import type { AgentDef } from "@pa/core-types"

const agent = {
  id: "claire",
  name: "Claire",
  systemPrompt: "First message: Here. What language works for you? Chinese / English / both mixed?",
  tools: [],
  memoryMode: "none" as const,
} as unknown as AgentDef

test("source-aware onboarding renders a layoff opener from the shared onboarding module", () => {
  const opener = renderLayoffOnboardingOpener({
    source: LAYOFF_ONBOARDING_SOURCE,
    displayName: "Adam Yang",
    layoffContext: { lastCompany: "Rain", jobTitle: "Software Engineer" },
  })

  assert.equal(
    opener,
    "Hi Adam, Claire from WeKruit. I saw you signed up after the Rain layoff. I can help map what you want next and keep track of roles that fit. What kind of role would you like to look for now?",
  )
})

test("composeOnboardingInput uses layoff source instead of the generic cn/en first message", () => {
  const input = composeOnboardingInput("send_first_mes", agent, {
    userMessage: "WeKruit_LAID_OFF",
    sourceAware: {
      source: LAYOFF_ONBOARDING_SOURCE,
      displayName: "Adam Yang",
      layoffContext: { lastCompany: "Rain", jobTitle: "Software Engineer" },
    },
  })

  assert.match(input, /send_first_mes_layoff/)
  assert.match(input, /after the Rain layoff/)
  assert.doesNotMatch(input, /Chinese \/ English/)
})
