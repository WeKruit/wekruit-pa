/**
 * v2.1 S6 — PII-leak audit tests.
 *
 * Asserts:
 *   - Clean transcript → 0 leaks.
 *   - SSN / DOB / email / phone / $ / URL / street-address pre-consent
 *     → flagged.
 *   - Same patterns POST-consent → NOT flagged (user-side PII allowed
 *     after consent; SMS handoff dispatcher owns post-consent agent
 *     PII; v2.1 smoke treats post-consent agent emissions as allowed).
 *   - User-side pre-consent content → never flagged (rule scope is
 *     agent-emitted PII only).
 *   - No consent event present → all agent segments treated as
 *     pre-consent.
 */
import test from "node:test"
import assert from "node:assert/strict"
import {
  auditTranscript,
  PII_PATTERNS,
  CONSENT_EVENT,
} from "../pii-audit.mjs"

test("clean transcript yields 0 leaks", () => {
  const r = auditTranscript({
    transcript: [
      { role: "agent", text: "Hi! Thanks for taking the call.", atIso: "2026-05-15T00:00:00Z" },
      { role: "user", text: "Sure thing.", atIso: "2026-05-15T00:00:05Z" },
    ],
    events: [{ type: CONSENT_EVENT, atIso: "2026-05-15T00:00:01Z" }],
  })
  assert.equal(r.leaks.length, 0)
})

test("pre-consent agent SSN is a leak", () => {
  const r = auditTranscript({
    transcript: [
      { role: "agent", text: "Your SSN is 123-45-6789.", atIso: "2026-05-15T00:00:00Z" },
    ],
    events: [{ type: CONSENT_EVENT, atIso: "2026-05-15T00:00:01Z" }],
  })
  assert.equal(r.leaks.length, 1)
  assert.equal(r.leaks[0].kind, "ssn")
  assert.equal(r.leaks[0].matched, "123-45-6789")
})

test("pre-consent agent email is a leak", () => {
  const r = auditTranscript({
    transcript: [
      { role: "agent", text: "I have you as foo@bar.com.", atIso: "2026-05-15T00:00:00Z" },
    ],
    events: [{ type: CONSENT_EVENT, atIso: "2026-05-15T00:00:02Z" }],
  })
  assert.equal(r.leaks.length, 1)
  assert.equal(r.leaks[0].kind, "email")
})

test("pre-consent agent phone is a leak", () => {
  const r = auditTranscript({
    transcript: [
      { role: "agent", text: "Reach you at +14155551212?", atIso: "2026-05-15T00:00:00Z" },
    ],
    events: [{ type: CONSENT_EVENT, atIso: "2026-05-15T00:00:05Z" }],
  })
  assert.ok(r.leaks.find((l) => l.kind === "phone"))
})

test("pre-consent agent dollar/URL/street-address are leaks", () => {
  const r = auditTranscript({
    transcript: [
      {
        role: "agent",
        text: "Pay $120,000 at https://wekruit.com/o; we ship to 1600 Pennsylvania Ave.",
        atIso: "2026-05-15T00:00:00Z",
      },
    ],
    events: [{ type: CONSENT_EVENT, atIso: "2026-05-15T00:00:05Z" }],
  })
  const kinds = r.leaks.map((l) => l.kind)
  assert.ok(kinds.includes("dollar"))
  assert.ok(kinds.includes("url"))
  assert.ok(kinds.includes("street"))
})

test("pre-consent agent DOB is a leak", () => {
  const r = auditTranscript({
    transcript: [
      { role: "agent", text: "Born 05/15/1990?", atIso: "2026-05-15T00:00:00Z" },
    ],
    events: [{ type: CONSENT_EVENT, atIso: "2026-05-15T00:00:05Z" }],
  })
  assert.equal(r.leaks.length, 1)
  assert.equal(r.leaks[0].kind, "dob")
})

test("post-consent agent PII is allowed (no leak)", () => {
  const r = auditTranscript({
    transcript: [
      {
        role: "agent",
        text: "Hi! This call is recorded.",
        atIso: "2026-05-15T00:00:00Z",
      },
      {
        role: "agent",
        text: "Confirming foo@bar.com and 123-45-6789.",
        atIso: "2026-05-15T00:00:10Z",
      },
    ],
    events: [{ type: CONSENT_EVENT, atIso: "2026-05-15T00:00:05Z" }],
  })
  assert.equal(r.leaks.length, 0)
})

test("user-side PII pre-consent is NEVER flagged", () => {
  const r = auditTranscript({
    transcript: [
      { role: "user", text: "My SSN is 123-45-6789.", atIso: "2026-05-15T00:00:00Z" },
      { role: "user", text: "I'm at foo@bar.com.", atIso: "2026-05-15T00:00:02Z" },
    ],
    events: [{ type: CONSENT_EVENT, atIso: "2026-05-15T00:00:05Z" }],
  })
  assert.equal(r.leaks.length, 0)
})

test("no consent event → all agent segments treated as pre-consent", () => {
  const r = auditTranscript({
    transcript: [
      { role: "agent", text: "Hi foo@bar.com.", atIso: "2026-05-15T00:00:00Z" },
      { role: "agent", text: "Pay $200.", atIso: "2026-05-15T00:00:10Z" },
    ],
    events: [],
  })
  assert.ok(r.leaks.length >= 2)
})

test("multi-pattern same segment yields multiple leaks", () => {
  const r = auditTranscript({
    transcript: [
      {
        role: "agent",
        text: "ID 123-45-6789, email foo@bar.com, phone +14155551212.",
        atIso: "2026-05-15T00:00:00Z",
      },
    ],
    events: [{ type: CONSENT_EVENT, atIso: "2026-05-15T00:00:05Z" }],
  })
  const kinds = new Set(r.leaks.map((l) => l.kind))
  assert.ok(kinds.has("ssn"))
  assert.ok(kinds.has("email"))
  assert.ok(kinds.has("phone"))
})

test("PII_PATTERNS keys cover all 7 mandated kinds", () => {
  const expected = ["ssn", "dob", "email", "phone", "dollar", "url", "street"]
  for (const k of expected) {
    assert.ok(k in PII_PATTERNS, `missing pattern: ${k}`)
  }
})

test("malformed transcript entries are ignored, not thrown", () => {
  const r = auditTranscript({
    transcript: [
      null,
      { role: "agent" }, // missing text
      { role: "agent", text: 42 }, // non-string text
    ],
    events: [],
  })
  assert.equal(r.leaks.length, 0)
})
