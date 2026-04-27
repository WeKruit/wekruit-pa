import test from "node:test"
import assert from "node:assert/strict"
import { buildVoiceReminder, isVoiceV1Disabled, VOICE_REMINDER_TEXT } from "./voice-reminder.js"

test("buildVoiceReminder returns canonical text when unset", () => {
  assert.equal(buildVoiceReminder({}), VOICE_REMINDER_TEXT)
  assert.equal(buildVoiceReminder({ PA_VOICE_V1_DISABLED: "false" }), VOICE_REMINDER_TEXT)
})

test("buildVoiceReminder returns null when PA_VOICE_V1_DISABLED=true", () => {
  assert.equal(buildVoiceReminder({ PA_VOICE_V1_DISABLED: "true" }), null)
})

test("reminder length is in expected token band (word heuristic)", () => {
  const t = VOICE_REMINDER_TEXT
  const wc = t.split(/\s+/).filter(Boolean).length
  assert.ok(wc >= 40 && wc <= 85, `word count ${wc}`)
})

test("VOICE_REMINDER_TEXT contains anchor substrings", () => {
  assert.match(VOICE_REMINDER_TEXT, /Claire/)
  assert.match(VOICE_REMINDER_TEXT, /🍋/)
  assert.match(VOICE_REMINDER_TEXT, /code-switch/i)
  assert.match(VOICE_REMINDER_TEXT, /Plain text/i)
})

test("isVoiceV1Disabled mirrors buildVoiceReminder nullability", () => {
  assert.equal(isVoiceV1Disabled({ PA_VOICE_V1_DISABLED: "true" }), true)
  assert.equal(isVoiceV1Disabled({}), false)
})
