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

describe("buildOnboardingSurfaceIntent — SMS persona contract", () => {
  it("injects the personal job-hunting assistant tone rules into every shared-onboarding SMS", () => {
    const intent = buildOnboardingSurfaceIntent({
      slot: "main_goal",
      mode: "ask",
      voiceProfile: profile(),
      promptContext: {
        firstName: "Sarah",
        recentTitles: ["Product Designer"],
        recentCompanies: ["Figma"],
        currentLocation: "Brooklyn",
      },
      lang: "en",
    })

    assert.match(intent, /personal job-hunting assistant/i)
    assert.match(intent, /texting a friend/i)
    assert.match(intent, /One question at a time/i)
    assert.match(intent, /No headers, bullets, markdown, or lists/i)
    assert.match(intent, /No corporate speak/i)
    assert.match(intent, /No internal enum/i)
    assert.match(intent, /Never mention being AI/i)
    assert.match(intent, /main goal for the next company/i)
    assert.match(intent, /career growth, compensation, stability, mission, learning/i)
    assert.match(intent, /recent roles: Product Designer/i)
    assert.doesNotMatch(intent, /Friend roommate tone|tech_swe|job_title|main_goal|recentTitles/)
    assert.doesNotMatch(intent, /Ask the target role onboarding question/i)
  })

  it("marks greeting kickoff as the opening welcome surface without requiring fixed wording", () => {
    const intent = buildOnboardingSurfaceIntent({
      slot: "main_goal",
      mode: "ask",
      voiceProfile: profile(),
      promptContext: {
        firstName: "Sarah",
        recentTitles: ["Product Designer"],
        recentCompanies: ["Figma"],
        currentLocation: "Brooklyn",
      },
      lang: "en",
      opening: true,
    })

    assert.match(intent, /first SMS after the candidate opened with Hello, WeKruit/i)
    assert.match(intent, /first name/i)
    assert.match(intent, /real resume or profile detail/i)
    assert.match(intent, /hiring manager/i)
    assert.match(intent, /https:\/\/candidate\.wekruit\.com\/me\/profile/i)
    assert.match(intent, /do not copy a fixed template/i)
    assert.match(intent, /what matters most in your next company/i)
    assert.doesNotMatch(intent, /what kind of role/i)
  })
})
