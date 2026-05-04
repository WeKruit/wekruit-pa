import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { isQuotaExhausted, quotaKillSwitchOn, QUOTA_LIMIT } from "../cv-quota.js"

describe("cv-quota.isQuotaExhausted", () => {
  let original: string | undefined
  beforeEach(() => {
    original = process.env.PA_RESUME_QUOTA_DISABLED
    delete process.env.PA_RESUME_QUOTA_DISABLED
  })
  afterEach(() => {
    if (original === undefined) delete process.env.PA_RESUME_QUOTA_DISABLED
    else process.env.PA_RESUME_QUOTA_DISABLED = original
  })

  it("returns false at count=0", () => {
    assert.equal(isQuotaExhausted(0), false)
  })
  it("returns false at count=1", () => {
    assert.equal(isQuotaExhausted(1), false)
  })
  it("returns true at count=QUOTA_LIMIT", () => {
    assert.equal(isQuotaExhausted(QUOTA_LIMIT), true)
  })
  it("returns true at count > QUOTA_LIMIT", () => {
    assert.equal(isQuotaExhausted(QUOTA_LIMIT + 5), true)
  })
  it("returns false when kill-switch ON regardless of count", () => {
    process.env.PA_RESUME_QUOTA_DISABLED = "true"
    assert.equal(isQuotaExhausted(QUOTA_LIMIT + 100), false)
  })
})

describe("quotaKillSwitchOn", () => {
  let original: string | undefined
  beforeEach(() => {
    original = process.env.PA_RESUME_QUOTA_DISABLED
    delete process.env.PA_RESUME_QUOTA_DISABLED
  })
  afterEach(() => {
    if (original === undefined) delete process.env.PA_RESUME_QUOTA_DISABLED
    else process.env.PA_RESUME_QUOTA_DISABLED = original
  })

  it("matches truthy values", () => {
    for (const v of ["true", "1", "on", "yes", "TRUE"]) {
      process.env.PA_RESUME_QUOTA_DISABLED = v
      assert.equal(quotaKillSwitchOn(), true, `expected true for "${v}"`)
    }
  })
  it("returns false on falsy / unset", () => {
    process.env.PA_RESUME_QUOTA_DISABLED = "false"
    assert.equal(quotaKillSwitchOn(), false)
    delete process.env.PA_RESUME_QUOTA_DISABLED
    assert.equal(quotaKillSwitchOn(), false)
  })
})
