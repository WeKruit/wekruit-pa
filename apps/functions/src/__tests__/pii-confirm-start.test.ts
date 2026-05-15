import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { composePiiSkipExistingText } from "../pii-confirm-start.js"

describe("composePiiSkipExistingText", () => {
  it("uses employer follow-up copy only after PASS", () => {
    assert.match(composePiiSkipExistingText("pass"), /employer will reach out directly/i)
  })

  it("uses better-fit copy after FAIL or HARD_STOP", () => {
    const text = composePiiSkipExistingText("fail")
    assert.match(text, /stronger fit/i)
    assert.doesNotMatch(text, /employer will reach out directly/i)
  })
})
