/**
 * v1.9 Phase 85 — PiiConfirmPipeline tests.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  validateEmail,
  validatePhone,
  validateLegalName,
  validateYoe,
  validateVisa,
  validateLocation,
  validateSalaryRange,
  validateIndustry,
  validateCompanySize,
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

describe("validateYoe (Level 1)", () => {
  it("parses single year", () => {
    assert.deepEqual(validateYoe("3"), { ok: true, lowYears: 3, highYears: 3 })
    assert.deepEqual(validateYoe("5 years"), { ok: true, lowYears: 5, highYears: 5 })
  })
  it("parses ranges", () => {
    assert.deepEqual(validateYoe("3-5"), { ok: true, lowYears: 3, highYears: 5 })
    assert.deepEqual(validateYoe("3 to 5"), { ok: true, lowYears: 3, highYears: 5 })
  })
  it("parses '10+' as range", () => {
    assert.deepEqual(validateYoe("10+"), { ok: true, lowYears: 10, highYears: 15 })
  })
  it("parses '<1'", () => {
    assert.deepEqual(validateYoe("<1"), { ok: true, lowYears: 0, highYears: 1 })
  })
  it("parses word numbers", () => {
    assert.deepEqual(validateYoe("five"), { ok: true, lowYears: 5, highYears: 5 })
  })
  it("rejects garbage", () => {
    assert.equal(validateYoe("hello").ok, false)
  })
})

describe("validateVisa (Level 1)", () => {
  it("recognizes citizen variants", () => {
    assert.equal(validateVisa("US citizen").status, "citizen")
    assert.equal(validateVisa("USC").status, "citizen")
  })
  it("recognizes green card / PR", () => {
    assert.equal(validateVisa("green card").status, "permanent_resident")
    assert.equal(validateVisa("GC").status, "permanent_resident")
    assert.equal(validateVisa("LPR").status, "permanent_resident")
  })
  it("recognizes sponsor-needed visa types", () => {
    assert.equal(validateVisa("H1B").status, "sponsor_needed")
    assert.equal(validateVisa("OPT").status, "sponsor_needed")
    assert.equal(validateVisa("STEM OPT").status, "sponsor_needed")
    assert.equal(validateVisa("F-1").status, "sponsor_needed")
    assert.equal(validateVisa("need sponsorship").status, "sponsor_needed")
  })
  it("falls back to 'other' for non-empty unknowns", () => {
    assert.equal(validateVisa("naturalized something").status, "other")
  })
})

describe("validateLocation (Level 1)", () => {
  it("recognizes remote / anywhere", () => {
    assert.deepEqual(validateLocation("remote").normalized, ["anywhere"])
    assert.deepEqual(validateLocation("anywhere").normalized, ["anywhere"])
  })
  it("splits multi-city", () => {
    assert.deepEqual(validateLocation("SF, NYC, Seattle").normalized, ["sf", "nyc", "seattle"])
  })
  it("rejects too short", () => {
    assert.equal(validateLocation("").ok, false)
    assert.equal(validateLocation("x").ok, false)
  })
})

describe("validateSalaryRange (Level 1)", () => {
  it("parses k notation", () => {
    assert.equal(validateSalaryRange("120k").minUsd, 120000)
    assert.equal(validateSalaryRange("$120k").minUsd, 120000)
  })
  it("picks minimum from range", () => {
    assert.equal(validateSalaryRange("100k-150k").minUsd, 100000)
    assert.equal(validateSalaryRange("$100k to $150k").minUsd, 100000)
  })
  it("parses bare digits", () => {
    assert.equal(validateSalaryRange("120000").minUsd, 120000)
    assert.equal(validateSalaryRange("120").minUsd, 120000)
  })
  it("recognizes open", () => {
    assert.equal(validateSalaryRange("open").minUsd, 0)
    assert.equal(validateSalaryRange("negotiable").minUsd, 0)
  })
})

describe("validateIndustry (Level 1)", () => {
  it("normalizes multi-industry", () => {
    assert.deepEqual(validateIndustry("AI, fintech, gaming").normalized, ["ai", "fintech", "gaming"])
  })
  it("recognizes open", () => {
    assert.deepEqual(validateIndustry("open").normalized, ["open"])
    assert.deepEqual(validateIndustry("any").normalized, ["open"])
  })
})

describe("validateCompanySize (Level 1)", () => {
  it("maps keyword to bucket", () => {
    assert.equal(validateCompanySize("seed").size, "seed")
    assert.equal(validateCompanySize("Series A").size, "early_startup")
    assert.equal(validateCompanySize("FAANG").size, "enterprise")
    assert.equal(validateCompanySize("Fortune 500").size, "enterprise")
    assert.equal(validateCompanySize("scale up").size, "scale_up")
  })
  it("infers from headcount", () => {
    assert.equal(validateCompanySize("around 30 people").size, "early_startup")
    assert.equal(validateCompanySize("200 employees").size, "scale_up")
    assert.equal(validateCompanySize("10000 employees").size, "enterprise")
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
