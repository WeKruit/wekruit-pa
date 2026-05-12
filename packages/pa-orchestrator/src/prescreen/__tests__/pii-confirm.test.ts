/**
 * v1.9 Phase 85 — PiiConfirmPipeline tests.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  validateEmail,
  validatePhone,
  validateLegalName,
} from "../pii-confirm.js"

describe("validateEmail", () => {
  it("accepts canonical emails", () => {
    assert.equal(validateEmail("alice@example.com").ok, true)
    assert.equal(validateEmail("ALICE@EXAMPLE.COM").normalized, "alice@example.com")
    assert.equal(validateEmail("a.b+tag@sub.example.io").ok, true)
  })
  it("rejects malformed", () => {
    assert.equal(validateEmail("not-an-email").ok, false)
    assert.equal(validateEmail("a@b").ok, false)
    assert.equal(validateEmail("").ok, false)
    assert.equal(validateEmail("a@@b.com").ok, false)
  })
})

describe("validatePhone", () => {
  it("accepts E.164 + plain digits", () => {
    assert.equal(validatePhone("+14155550123").ok, true)
    assert.equal(validatePhone("4155550123").ok, true)
    assert.equal(validatePhone("13800138000").ok, true)
    assert.equal(validatePhone("+1 (415) 555-0123").normalized, "+14155550123")
  })
  it("rejects too short / too long", () => {
    assert.equal(validatePhone("12345").ok, false)
    assert.equal(validatePhone("1234567890123456").ok, false)
    assert.equal(validatePhone("abc").ok, false)
  })
})

describe("validateLegalName", () => {
  it("accepts ascii + cjk", () => {
    assert.equal(validateLegalName("Jane Doe").ok, true)
    assert.equal(validateLegalName("张三").ok, true)
    assert.equal(validateLegalName("Anne-Marie O'Brien").ok, true)
  })
  it("trims + collapses whitespace", () => {
    assert.equal(validateLegalName("  John   Smith  ").normalized, "John Smith")
  })
  it("rejects too short / numeric / empty", () => {
    assert.equal(validateLegalName("J").ok, false)
    assert.equal(validateLegalName("123").ok, false)
    assert.equal(validateLegalName("").ok, false)
  })
})
