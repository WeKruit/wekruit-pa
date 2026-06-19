import test from "node:test"
import assert from "node:assert/strict"

import {
  buildVoiceCallAckClarifier,
  shouldHoldVoiceCallAckFromMatching,
} from "./voice-call-ack-guard.js"

test("bare affirmative after phone-prescreen role disambiguation is held from find_match", () => {
  const recentAssistant = [
    "got you - that's the Martini Agent Engineer screen. looks like that one's already completed, so we can't restart it, but i can help you pick another matched engineering role to run next. which one do you want: Sekai AI Agent Engineer (Coding Agent), Maximor Staff SWE, or Sekai Technical Lead?",
  ]

  assert.equal(shouldHoldVoiceCallAckFromMatching("Sure", recentAssistant), true)
  assert.match(buildVoiceCallAckClarifier(recentAssistant), /phone screen/i)
  assert.match(buildVoiceCallAckClarifier(recentAssistant), /Sekai AI Agent Engineer/i)
})

test("bare affirmative after real role-pull offer stays available for find_match", () => {
  const recentAssistant = [
    "hey Adam - I've got your software engineering background and US-only preference. want me to pull a few roles that fit?",
  ]

  assert.equal(shouldHoldVoiceCallAckFromMatching("sure", recentAssistant), false)
})

test("bare affirmative after active call offer stays available for resolve_voice_call_offer", () => {
  const recentAssistant = [
    "Want to do the prescreen as a quick call now? I can call you at the number ending in 1960. Reply yes and I'll call now, or no and we'll keep it over text.",
  ]

  assert.equal(shouldHoldVoiceCallAckFromMatching("yes", recentAssistant), false)
})
