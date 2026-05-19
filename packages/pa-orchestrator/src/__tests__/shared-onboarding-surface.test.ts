/**
 * Adam 2026-05-19 voice polish §2 — shared onboarding surface intent tests
 * (sidecar / additive coverage).
 *
 * `shared-onboarding-resume-anchor.test.ts` already locks in the main_goal /
 * culture_stage anchor wiring + the location_relocation no-anchor invariant.
 * This file covers the smaller wiring surface that polish §2 specifically
 * touches:
 *
 *   - culture_stage with company-only context (no titles) still produces a
 *     "Given your <company> background," anchor
 *   - ackHint prop is forwarded into the invariants block verbatim (used by
 *     ack_then_ask mode after a substantive user answer)
 *   - lang prop hard-locks the SMS language invariant (en/zh)
 *
 * Keeping these in their own file prevents the anchor file from ballooning
 * and makes the polish §2 acceptance criteria easy to grep for.
 */
import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import { buildOnboardingSurfaceIntent } from "../shared-onboarding-surface.js"
import { getVoiceProfile, type ResolvedVoiceProfile } from "../voice/voice-profiles/index.js"

function profile(): ResolvedVoiceProfile {
  const base = getVoiceProfile("friend_onboarding")
  return {
    ...base,
    resolvedEmoji: base.choreography.emoji,
    resolvedSlangBudget: base.choreography.slangBudget,
    userStylePreference: null,
  }
}

describe("buildOnboardingSurfaceIntent — culture_stage company-only anchor", () => {
  it("anchors on company list when no titles on file", () => {
    const intent = buildOnboardingSurfaceIntent({
      slot: "culture_stage",
      mode: "ask",
      voiceProfile: profile(),
      promptContext: {
        recentCompanies: ["Stripe"],
      },
      lang: "en",
    })
    assert.match(intent, /Resume anchor \(required if present\): Given your Stripe background,/)
  })
})

describe("buildOnboardingSurfaceIntent — ack hint propagation", () => {
  it("ackHint forwards into the invariants block when present", () => {
    const intent = buildOnboardingSurfaceIntent({
      slot: "culture_stage",
      mode: "ask",
      voiceProfile: profile(),
      promptContext: {
        recentCompanies: ["Tesla"],
      },
      ackHint: "Briefly mirror their answer before pivoting.",
      lang: "en",
    })
    assert.match(intent, /Ack hint: Briefly mirror their answer before pivoting\./)
  })

  it("absent ackHint produces no Ack hint line", () => {
    const intent = buildOnboardingSurfaceIntent({
      slot: "culture_stage",
      mode: "ask",
      voiceProfile: profile(),
      promptContext: {
        recentCompanies: ["Tesla"],
      },
      lang: "en",
    })
    assert.doesNotMatch(intent, /Ack hint:/)
  })
})

describe("buildOnboardingSurfaceIntent — language lock", () => {
  it("lang=zh injects Chinese-only invariant", () => {
    const intent = buildOnboardingSurfaceIntent({
      slot: "main_goal",
      mode: "ask",
      voiceProfile: profile(),
      promptContext: {},
      lang: "zh",
    })
    assert.match(intent, /Write the SMS in Chinese only\./)
  })

  it("lang=en injects English-only invariant", () => {
    const intent = buildOnboardingSurfaceIntent({
      slot: "main_goal",
      mode: "ask",
      voiceProfile: profile(),
      promptContext: {},
      lang: "en",
    })
    assert.match(intent, /Write the SMS in English only\./)
  })
})
