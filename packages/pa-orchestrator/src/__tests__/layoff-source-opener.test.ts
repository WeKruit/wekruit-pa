import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { WEKRUIT_LAYOFF_SOURCE, composeLayoffFirstMessage } from "../onboarding.js"

describe("layoff source opener", () => {
  it("keeps the layoff source tag canonical inside pa-orchestrator", () => {
    assert.equal(WEKRUIT_LAYOFF_SOURCE, "WeKruit_Laid_Off")
  })

  it("renders a human first message without forcing positivity", () => {
    const body = composeLayoffFirstMessage({
      firstName: " Ada ",
      lastCompany: " Rain ",
    })

    assert.equal(
      body,
      "Hey Ada, Claire from WeKruit. I saw you signed up after the Rain layoff. I can help you sort out what you want next — got a minute?",
    )
    assert.doesNotMatch(body, /glad|excited|congrats/i)
  })

  it("falls back cleanly when layoff context is partial", () => {
    assert.equal(
      composeLayoffFirstMessage(),
      "Hey there, Claire from WeKruit. I saw you signed up after a layoff. I can help you sort out what you want next — got a minute?",
    )
  })
})
