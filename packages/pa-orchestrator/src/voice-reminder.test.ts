import assert from "node:assert/strict"
import test from "node:test"
import { buildVoiceReminder, isVoiceV1Disabled, VOICE_REMINDER_TEXT } from "./voice-reminder.js"

test("isVoiceV1Disabled true when PA_VOICE_V1_DISABLED=true", () => {
  assert.equal(
    isVoiceV1Disabled({ ...process.env, PA_VOICE_V1_DISABLED: "true" }),
    true
  )
  assert.equal(buildVoiceReminder({ ...process.env, PA_VOICE_V1_DISABLED: "true" }), null)
})

test("buildVoiceReminder returns canonical block when not disabled", () => {
  const r = buildVoiceReminder({ ...process.env, PA_VOICE_V1_DISABLED: "false" })
  assert.equal(r, VOICE_REMINDER_TEXT)
})
