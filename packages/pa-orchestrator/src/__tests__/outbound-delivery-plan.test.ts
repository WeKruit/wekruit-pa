/**
 * Adam 2026-05-19 voice polish §3 — outbound delivery plan unit tests.
 *
 * Invariants this file enforces:
 *   - smsCount === leadingEmojiSms?1:0 + textParts.length, and always ≤ 2.
 *   - tapback never contributes to smsCount.
 *   - force1 → mode=text_only_1, no flourish, no tapback.
 *   - emoji policy "banned" → no leadingEmojiSms ever surfaces.
 *   - reactionsAllowed=false → no tapback ever surfaces.
 *   - hasMessageHandle=false → no tapback ever surfaces.
 *   - Seed determinism — same input set returns the same plan.
 */
import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import {
  countPlanSmsBubbles,
  planOutboundDelivery,
  type OutboundDeliveryMode,
  type PlanOutboundDeliveryInput,
} from "../voice/outbound-delivery-plan.js"
import { getVoiceProfile, type ResolvedVoiceProfile } from "../voice/voice-profiles/index.js"

function profileWith(overrides: Partial<ResolvedVoiceProfile> = {}): ResolvedVoiceProfile {
  const base = getVoiceProfile("friend_onboarding")
  return {
    ...base,
    ...overrides,
    resolvedEmoji: overrides.resolvedEmoji ?? base.choreography.emoji,
    resolvedSlangBudget: overrides.resolvedSlangBudget ?? base.choreography.slangBudget,
    userStylePreference: overrides.userStylePreference ?? null,
    choreography: {
      ...base.choreography,
      ...(overrides.choreography ?? {}),
    },
  }
}

const LONG_REPLY =
  "I hear you on growth being top of mind. Career growth and learning are how you keep momentum, " +
  "so I'll bias toward roles where you can ship, learn, and stretch. Quick follow-up: how do you " +
  "feel about scale — early-stage chaos vs scale-up with structure?"

const SHORT_REPLY = "Got it — what city are you in?"

const SUBSTANTIVE_INBOUND =
  "Honestly career growth matters more than comp right now, I want to ship and learn fast at a place where I can lead a small team and get exposure to senior eng."

const TERSE_INBOUND = "ok"

describe("planOutboundDelivery — invariants", () => {
  for (let seedI = 0; seedI < 20; seedI++) {
    it(`smsCount ≤ 2 and consistent with parts (seed ${seedI})`, () => {
      const plan = planOutboundDelivery({
        reply: LONG_REPLY,
        turnId: `turn-${seedI}`,
        profile: profileWith(),
        inboundBody: SUBSTANTIVE_INBOUND,
        hasMessageHandle: true,
      })
      const expected = (plan.leadingEmojiSms ? 1 : 0) + plan.textParts.length
      assert.equal(plan.smsCount, expected, `smsCount mismatch in mode ${plan.mode}`)
      assert.ok(plan.smsCount <= 2, `smsCount must be ≤ 2 but got ${plan.smsCount} in ${plan.mode}`)
      assert.ok(plan.smsCount >= 1, `smsCount must be ≥ 1 but got ${plan.smsCount} in ${plan.mode}`)
      assert.ok(plan.textParts.length >= 1, "must always ship at least one text bubble")
      // Defensive: countPlanSmsBubbles agrees with declared smsCount.
      assert.equal(countPlanSmsBubbles(plan), plan.smsCount)
    })
  }

  it("force1 → text_only_1 with no flourish", () => {
    const plan = planOutboundDelivery({
      reply: LONG_REPLY,
      turnId: "any",
      profile: profileWith(),
      inboundBody: SUBSTANTIVE_INBOUND,
      hasMessageHandle: true,
      force1: true,
    })
    assert.equal(plan.mode, "text_only_1")
    assert.equal(plan.tapback, undefined)
    assert.equal(plan.leadingEmojiSms, undefined)
    assert.equal(plan.smsCount, 1)
    assert.deepEqual(plan.textParts, [LONG_REPLY])
    assert.equal(plan.reason, "force1")
  })
})

describe("planOutboundDelivery — profile gates", () => {
  it("emoji=banned → never plans leadingEmojiSms", () => {
    const profile = profileWith({
      resolvedEmoji: "banned",
      choreography: { ...getVoiceProfile("friend_onboarding").choreography, emoji: "banned" },
    })
    for (let i = 0; i < 50; i++) {
      const plan = planOutboundDelivery({
        reply: LONG_REPLY,
        turnId: `banned-${i}`,
        profile,
        inboundBody: SUBSTANTIVE_INBOUND,
        hasMessageHandle: true,
      })
      assert.equal(plan.leadingEmojiSms, undefined, `mode ${plan.mode} leaked emoji at seed ${i}`)
      const forbidden: OutboundDeliveryMode[] = ["emoji_then_text", "tapback_emoji_text"]
      assert.ok(!forbidden.includes(plan.mode), `mode ${plan.mode} should be stripped`)
    }
  })

  it("reactionsAllowed=false → never plans tapback", () => {
    const profile = profileWith({
      choreography: {
        ...getVoiceProfile("friend_onboarding").choreography,
        reactionsAllowed: false,
      },
    })
    for (let i = 0; i < 50; i++) {
      const plan = planOutboundDelivery({
        reply: LONG_REPLY,
        turnId: `no-react-${i}`,
        profile,
        inboundBody: SUBSTANTIVE_INBOUND,
        hasMessageHandle: true,
      })
      assert.equal(plan.tapback, undefined, `mode ${plan.mode} leaked tapback at seed ${i}`)
      const forbidden: OutboundDeliveryMode[] = ["tapback_then_text", "tapback_emoji_text"]
      assert.ok(!forbidden.includes(plan.mode), `mode ${plan.mode} should be stripped`)
    }
  })

  it("hasMessageHandle=false → never plans tapback (Sendblue API contract)", () => {
    for (let i = 0; i < 50; i++) {
      const plan = planOutboundDelivery({
        reply: LONG_REPLY,
        turnId: `no-handle-${i}`,
        profile: profileWith(),
        inboundBody: SUBSTANTIVE_INBOUND,
        hasMessageHandle: false,
      })
      assert.equal(plan.tapback, undefined, `mode ${plan.mode} leaked tapback at seed ${i}`)
    }
  })

  it("all flourish modes blocked → text_only_1 or text_split_2 only", () => {
    const profile = profileWith({
      resolvedEmoji: "banned",
      choreography: {
        ...getVoiceProfile("friend_onboarding").choreography,
        emoji: "banned",
        reactionsAllowed: false,
      },
    })
    for (let i = 0; i < 30; i++) {
      const plan = planOutboundDelivery({
        reply: LONG_REPLY,
        turnId: `locked-${i}`,
        profile,
        inboundBody: SUBSTANTIVE_INBOUND,
        hasMessageHandle: false,
      })
      assert.ok(
        plan.mode === "text_only_1" || plan.mode === "text_split_2",
        `expected text-only modes, got ${plan.mode}`,
      )
      assert.equal(plan.tapback, undefined)
      assert.equal(plan.leadingEmojiSms, undefined)
    }
  })
})

describe("planOutboundDelivery — splittability", () => {
  it("short replies never get split_2 mode", () => {
    for (let i = 0; i < 50; i++) {
      const plan = planOutboundDelivery({
        reply: SHORT_REPLY,
        turnId: `short-${i}`,
        profile: profileWith(),
        inboundBody: SUBSTANTIVE_INBOUND,
        hasMessageHandle: true,
      })
      assert.notEqual(plan.mode, "text_split_2", `seed ${i} produced split_2 on short reply`)
      if (plan.mode === "tapback_then_text") {
        assert.equal(plan.textParts.length, 1, "tapback+short reply should not split")
      }
    }
  })

  it("long replies CAN choose text_split_2 with two parts", () => {
    let sawSplit = false
    for (let i = 0; i < 200 && !sawSplit; i++) {
      const plan = planOutboundDelivery({
        reply: LONG_REPLY,
        turnId: `long-${i}`,
        profile: profileWith(),
        inboundBody: SUBSTANTIVE_INBOUND,
        hasMessageHandle: true,
      })
      if (plan.mode === "text_split_2") {
        sawSplit = true
        assert.equal(plan.textParts.length, 2)
      }
    }
    assert.ok(sawSplit, "expected at least one text_split_2 across 200 seeded long-reply turns")
  })
})

describe("planOutboundDelivery — substantive boost", () => {
  it("substantive inbound surfaces flourish modes (emoji/tapback) at least sometimes", () => {
    let flourish = 0
    for (let i = 0; i < 200; i++) {
      const plan = planOutboundDelivery({
        reply: LONG_REPLY,
        turnId: `sub-${i}`,
        profile: profileWith(),
        inboundBody: SUBSTANTIVE_INBOUND,
        hasMessageHandle: true,
      })
      if (
        plan.mode === "emoji_then_text" ||
        plan.mode === "tapback_then_text" ||
        plan.mode === "tapback_emoji_text"
      ) {
        flourish++
      }
    }
    // Substantive weights sum to 0.40 over flourish modes. 200 seeded picks
    // should land at least 30 flourish modes (well above noise floor).
    assert.ok(flourish > 30, `expected >30 flourish picks across 200 seeds, got ${flourish}`)
  })

  it("terse inbound and force1 produce no flourish", () => {
    const plan = planOutboundDelivery({
      reply: SHORT_REPLY,
      turnId: "any",
      profile: profileWith(),
      inboundBody: TERSE_INBOUND,
      hasMessageHandle: true,
      force1: true,
    })
    assert.equal(plan.tapback, undefined)
    assert.equal(plan.leadingEmojiSms, undefined)
    assert.equal(plan.mode, "text_only_1")
  })
})

describe("planOutboundDelivery — determinism", () => {
  it("same turnId + inputs produce identical plans", () => {
    const base: PlanOutboundDeliveryInput = {
      reply: LONG_REPLY,
      turnId: "stable-seed-001",
      profile: profileWith(),
      inboundBody: SUBSTANTIVE_INBOUND,
      hasMessageHandle: true,
    }
    const a = planOutboundDelivery(base)
    const b = planOutboundDelivery(base)
    assert.deepEqual(a, b)
  })

  it("different turnIds yield (at least sometimes) different modes", () => {
    const seenModes = new Set<OutboundDeliveryMode>()
    for (let i = 0; i < 50; i++) {
      const plan = planOutboundDelivery({
        reply: LONG_REPLY,
        turnId: `seed-${i}`,
        profile: profileWith(),
        inboundBody: SUBSTANTIVE_INBOUND,
        hasMessageHandle: true,
      })
      seenModes.add(plan.mode)
    }
    assert.ok(seenModes.size >= 3, `expected ≥3 distinct modes across 50 seeds, saw ${[...seenModes].join(",")}`)
  })
})
