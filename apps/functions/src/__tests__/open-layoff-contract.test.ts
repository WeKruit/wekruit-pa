import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { WEKRUIT_LAYOFF_SOURCE, composeLayoffFirstMessage } from "@pa/pa-orchestrator"
import { normalizeAndValidatePhone, phoneIndexId } from "../openLayoff.js"

describe("open layoff contract", () => {
  it("uses the shared orchestrator source tag and opener", () => {
    assert.equal(WEKRUIT_LAYOFF_SOURCE, "WeKruit_Laid_Off")
    assert.match(composeLayoffFirstMessage({ firstName: "Ada", lastCompany: "Rain" }), /^Hey Ada, Claire from WeKruit\./)
  })

  it("normalizes a real test SMS number to E.164", () => {
    assert.deepEqual(normalizeAndValidatePhone("(305) 450-7715"), {
      ok: true,
      e164: "+13054507715",
    })
  })

  it("rejects email handles and short phone strings", () => {
    assert.deepEqual(normalizeAndValidatePhone("candidate@example.com"), {
      ok: false,
      reason: "email_not_phone",
    })
    assert.deepEqual(normalizeAndValidatePhone("12345"), {
      ok: false,
      reason: "too_short",
    })
  })

  it("derives stable dedup index ids without exposing raw phones", () => {
    const one = phoneIndexId("+13054507715")
    const two = phoneIndexId("+13054507715")

    assert.equal(one, two)
    assert.match(one, /^p_[a-z0-9]+$/)
    assert.ok(!one.includes("3054507715"))
  })
})
