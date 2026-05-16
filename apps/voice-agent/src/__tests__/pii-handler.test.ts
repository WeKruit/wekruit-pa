import { test } from "node:test"
import assert from "node:assert/strict"

import { redactForVoice, hasVoicePiiConsent } from "../pii-handler.js"
import type { VoiceUserProfile } from "../voice-context-types.js"

const noConsentProfile: Pick<VoiceUserProfile, "piiConsentAt" | "missingFields"> = {
  missingFields: [],
  // piiConsentAt intentionally undefined
}

const consentedProfile: Pick<VoiceUserProfile, "piiConsentAt" | "missingFields"> = {
  piiConsentAt: "2026-05-01T00:00:00Z",
  missingFields: [],
}

test("hasVoicePiiConsent: undefined → false", () => {
  assert.equal(hasVoicePiiConsent({}), false)
  assert.equal(hasVoicePiiConsent({ piiConsentAt: undefined }), false)
})

test("hasVoicePiiConsent: empty string → false", () => {
  assert.equal(hasVoicePiiConsent({ piiConsentAt: "" }), false)
})

test("hasVoicePiiConsent: non-empty string → true", () => {
  assert.equal(hasVoicePiiConsent({ piiConsentAt: "2026-05-01" }), true)
})

test("redactForVoice: consented → passthrough verbatim", () => {
  const text = "Please email me at adam@wekruit.com or call +14157075057."
  const out = redactForVoice({ agentText: text, profile: consentedProfile })
  assert.equal(out.speakText, text)
  assert.equal(out.redacted, false)
  assert.equal(out.smsHandoffTokens.length, 0)
})

test("redactForVoice: no consent + clean text → passthrough", () => {
  const text = "Tell me about your most recent project."
  const out = redactForVoice({ agentText: text, profile: noConsentProfile })
  assert.equal(out.speakText, text)
  assert.equal(out.redacted, false)
  assert.equal(out.smsHandoffTokens.length, 0)
})

test("redactForVoice: email redacted with sms_handoff:email token", () => {
  const text = "Send your resume to recruiter@example.com today."
  const out = redactForVoice({ agentText: text, profile: noConsentProfile })
  assert.equal(out.redacted, true)
  assert.equal(out.smsHandoffTokens.length, 1)
  assert.equal(out.smsHandoffTokens[0].kind, "email")
  assert.equal(out.smsHandoffTokens[0].source, "recruiter@example.com")
  assert.match(out.speakText, /\[sms_handoff:email:0\]/)
  assert.doesNotMatch(out.speakText, /recruiter@example\.com/)
})

test("redactForVoice: phone (E.164) redacted", () => {
  const text = "Call +14157075057 to confirm."
  const out = redactForVoice({ agentText: text, profile: noConsentProfile })
  assert.equal(out.redacted, true)
  assert.ok(
    out.smsHandoffTokens.some((t) => t.kind === "phone"),
    `expected a phone token; got ${JSON.stringify(out.smsHandoffTokens)}`
  )
  assert.doesNotMatch(out.speakText, /4157075057/)
})

test("redactForVoice: NANP phone redacted", () => {
  const text = "Call (415) 707-5057 or 415.707.5057."
  const out = redactForVoice({ agentText: text, profile: noConsentProfile })
  assert.equal(out.redacted, true)
  assert.equal(
    out.smsHandoffTokens.filter((t) => t.kind === "phone").length,
    2
  )
})

test("redactForVoice: dollar amount redacted", () => {
  const text = "The offer is $140,000 base plus equity."
  const out = redactForVoice({ agentText: text, profile: noConsentProfile })
  assert.equal(out.redacted, true)
  assert.ok(out.smsHandoffTokens.some((t) => t.kind === "amount"))
  assert.doesNotMatch(out.speakText, /140,000/)
})

test("redactForVoice: shorthand 120k redacted", () => {
  const text = "Looking at 120k or higher."
  const out = redactForVoice({ agentText: text, profile: noConsentProfile })
  assert.equal(out.redacted, true)
  assert.ok(out.smsHandoffTokens.some((t) => t.kind === "amount"))
})

test("redactForVoice: URL redacted", () => {
  const text = "Apply here: https://wekruit.com/j/abc123 — fast."
  const out = redactForVoice({ agentText: text, profile: noConsentProfile })
  assert.equal(out.redacted, true)
  assert.ok(out.smsHandoffTokens.some((t) => t.kind === "url"))
  assert.doesNotMatch(out.speakText, /https?:\/\//)
})

test("redactForVoice: multi-PII compound", () => {
  const text =
    "Email recruiter@example.com or call +14157075057. Salary $140,000 — apply at https://wekruit.com/j/x."
  const out = redactForVoice({ agentText: text, profile: noConsentProfile })
  assert.equal(out.redacted, true)
  const kinds = out.smsHandoffTokens.map((t) => t.kind).sort()
  assert.deepEqual(kinds, ["amount", "email", "phone", "url"])
  // every kind redaction substrings present in speakText
  for (const k of kinds) {
    assert.match(out.speakText, new RegExp(`\\[sms_handoff:${k}:`))
  }
})

test("redactForVoice: empty input → empty output", () => {
  const out = redactForVoice({ agentText: "", profile: noConsentProfile })
  assert.equal(out.speakText, "")
  assert.equal(out.redacted, false)
  assert.equal(out.smsHandoffTokens.length, 0)
})

test("redactForVoice: overlap suppression (URL containing dollar-like)", () => {
  // URL should win over interior amount-like matches.
  const text = "See https://example.com/120000-page for details."
  const out = redactForVoice({ agentText: text, profile: noConsentProfile })
  assert.equal(out.redacted, true)
  const kinds = out.smsHandoffTokens.map((t) => t.kind)
  assert.ok(kinds.includes("url"), `kinds=${JSON.stringify(kinds)}`)
  // URL token replaces the whole url; no leftover digits exposed
  assert.doesNotMatch(out.speakText, /120000-page/)
})
