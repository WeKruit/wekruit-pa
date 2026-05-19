import assert from "node:assert/strict"
import test from "node:test"
import { getVoiceProfile } from "../voice-profiles/index.js"
import { planReaction } from "../reaction-policy.js"

test("planReaction suppresses neutral messages", () => {
  const profile = getVoiceProfile("friend_onboarding")
  const plan = planReaction({
    profile: { ...profile, resolvedEmoji: "sparse", resolvedSlangBudget: "mirror_user", userStylePreference: null },
    userMessage: "ok",
    recentAssistantTurns: [],
  })
  assert.equal(plan.shouldReact, false)
  assert.equal(plan.reason, "neutral_message")
})

test("planReaction suppresses tap on short positive ack", () => {
  const profile = getVoiceProfile("friend_onboarding")
  const plan = planReaction({
    profile: { ...profile, resolvedEmoji: "sparse", resolvedSlangBudget: "mirror_user", userStylePreference: null },
    userMessage: "thanks!!",
    recentAssistantTurns: [],
  })
  assert.equal(plan.shouldReact, false)
  assert.equal(plan.reason, "short_reply_no_tap")
})

test("planReaction fires on strong positive signal", () => {
  const profile = getVoiceProfile("friend_onboarding")
  const plan = planReaction({
    profile: { ...profile, resolvedEmoji: "sparse", resolvedSlangBudget: "mirror_user", userStylePreference: null },
    userMessage: "thank you so much this is amazing!!",
    recentAssistantTurns: [],
  })
  assert.equal(plan.shouldReact, true)
  assert.equal(plan.reaction, "like")
})

test("planReaction respects cap per N assistant turns", () => {
  const profile = getVoiceProfile("friend_onboarding")
  const plan = planReaction({
    profile: { ...profile, resolvedEmoji: "sparse", resolvedSlangBudget: "mirror_user", userStylePreference: null },
    userMessage: "thanks a ton really appreciate it",
    recentAssistantTurns: [
      {
        id: "a1",
        sessionId: "s",
        userId: "u",
        role: "assistant",
        body: "prev",
        createdAt: new Date().toISOString(),
        rawMeta: { reactionSent: true },
      },
    ],
  })
  assert.equal(plan.shouldReact, false)
  assert.equal(plan.reason, "cap_per_n_turns")
})
