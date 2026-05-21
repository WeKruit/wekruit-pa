/**
 * Identity hardening 2026-05-20 — unit coverage for the Sendblue
 * inbound sender format classifier.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { isE164, looksLikeEmail, classifyInboundSender } from "../handle-format.js"

describe("isE164", () => {
  it("accepts well-formed E.164", () => {
    assert.equal(isE164("+14243201960"), true)
    assert.equal(isE164("+8613800138000"), true)
    assert.equal(isE164("+447911123456"), true)
  })
  it("rejects missing leading +", () => {
    assert.equal(isE164("14243201960"), false)
  })
  it("rejects starting with 0", () => {
    assert.equal(isE164("+04243201960"), false)
  })
  it("rejects too short", () => {
    assert.equal(isE164("+1234"), false)
  })
  it("rejects too long", () => {
    assert.equal(isE164("+1234567890123456"), false)
  })
  it("rejects email", () => {
    assert.equal(isE164("alice@icloud.com"), false)
  })
  it("rejects empty / non-string", () => {
    assert.equal(isE164(""), false)
    assert.equal(isE164(undefined as unknown as string), false)
  })
})

describe("looksLikeEmail", () => {
  it("accepts typical addresses", () => {
    assert.equal(looksLikeEmail("alice@icloud.com"), true)
    assert.equal(looksLikeEmail("user@gmail.com"), true)
    assert.equal(looksLikeEmail("a.b@c.co.uk"), true)
  })
  it("rejects missing @", () => {
    assert.equal(looksLikeEmail("alice.icloud.com"), false)
  })
  it("rejects missing domain dot", () => {
    assert.equal(looksLikeEmail("alice@localhost"), false)
  })
  it("rejects E.164", () => {
    assert.equal(looksLikeEmail("+14243201960"), false)
  })
})

describe("classifyInboundSender", () => {
  it("returns e164_phone for valid phone", () => {
    assert.equal(classifyInboundSender("+14243201960"), "e164_phone")
  })
  it("returns email_apple_id for email", () => {
    assert.equal(classifyInboundSender("alice@icloud.com"), "email_apple_id")
  })
  it("returns unknown for malformed", () => {
    assert.equal(classifyInboundSender("1234"), "unknown")
    assert.equal(classifyInboundSender(""), "unknown")
  })
})
