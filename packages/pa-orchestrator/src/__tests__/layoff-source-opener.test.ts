import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { WEKRUIT_LAYOFF_SOURCE } from "../onboarding.js"

describe("layoff source label", () => {
  it("keeps the layoff source tag canonical inside pa-orchestrator", () => {
    // 2026-05-19 — composeLayoffFirstMessage + renderLayoffOnboardingOpener
    // were deleted. Only the DB-side source label survives because pa-users
    // analytics and the verified-marketplace filter still key on it.
    assert.equal(WEKRUIT_LAYOFF_SOURCE, "WeKruit_Laid_Off")
  })
})
