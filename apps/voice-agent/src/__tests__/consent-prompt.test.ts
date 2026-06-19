import { test } from "node:test"
import assert from "node:assert/strict"

import { buildConsentPrompt } from "../consent-prompt.js"
import type { VoiceCallContext } from "../voice-context-types.js"

function ctxFor(lang: "zh" | "en" | undefined, mode: "casual_onboarding" | "professional_prescreen"): VoiceCallContext {
  return {
    bookingId: "bk",
    purpose: "prescreen",
    prescreenSessionId: "ps",
    userProfile: { userId: "u", preferredLang: lang, missingFields: [] },
    jobBrief: {
      jobId: "j",
      jobTitle: "t",
      companyName: "c",
      missingFields: [],
    },
    prescreenConfig: {
      jobId: "j",
      version: 1,
      jobTitle: "t",
      threshold: 0.5,
      confidenceThreshold: 0.5,
      maxClarifyRounds: 2,
      voiceMode: mode,
      questions: [],
      parsedFromZod: true,
      missingFields: [],
    },
  }
}

test("consent: en professional contains 'recorded' + 'STOP' + 'WeKruit'", () => {
  const s = buildConsentPrompt(ctxFor("en", "professional_prescreen"))
  assert.match(s, /recorded/i)
  assert.match(s, /STOP/)
  assert.match(s, /WeKruit/)
})

test("consent: en casual is distinct from professional", () => {
  const casual = buildConsentPrompt(ctxFor("en", "casual_onboarding"))
  const pro = buildConsentPrompt(ctxFor("en", "professional_prescreen"))
  assert.notEqual(casual, pro)
  // Both contain STOP for opt-out parity.
  assert.match(casual, /STOP/)
  assert.match(pro, /STOP/)
})

test("consent: zh contains 录音 + STOP + WeKruit", () => {
  const s = buildConsentPrompt(ctxFor("zh", "professional_prescreen"))
  assert.match(s, /录音/)
  assert.match(s, /STOP/)
  assert.match(s, /WeKruit/)
})

test("consent: undefined lang defaults to English", () => {
  const s = buildConsentPrompt(ctxFor(undefined, "professional_prescreen"))
  assert.match(s, /recorded/i)
})

test("consent: prompt does NOT contain any literal PII detector triggers", () => {
  for (const mode of ["casual_onboarding", "professional_prescreen"] as const) {
    for (const lang of ["zh", "en"] as const) {
      const s = buildConsentPrompt(ctxFor(lang, mode))
      // No phone, email, URL, dollar literal — these are PA-side concerns.
      assert.doesNotMatch(s, /https?:\/\//)
      assert.doesNotMatch(s, /@[a-z0-9.-]+\.[a-z]/i)
      assert.doesNotMatch(s, /\$\d/)
    }
  }
})
