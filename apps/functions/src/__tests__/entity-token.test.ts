import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  canonicalEntityToken,
  canonicalEntityTokens,
  entityParenAlias,
  tokensIntersect,
} from "../entity-token.js"
import { YC_ENTITY_OVERLAY } from "../yc-entity-overlay.generated.js"

const OV = YC_ENTITY_OVERLAY

describe("entity-token — canonicalize, then compare identifiers", () => {
  it("resolves school variants to one identity (the recall the facet exists for)", () => {
    const berkeley = canonicalEntityToken("school", "University of California, Berkeley", OV)
    assert.ok(berkeley)
    for (const variant of ["Berkeley", "UC Berkeley", "UC-Berkeley", "Cal", "Haas"]) {
      assert.equal(canonicalEntityToken("school", variant, OV), berkeley, `"${variant}" must resolve to Berkeley`)
    }
    const stanford = canonicalEntityToken("school", "Stanford University", OV)
    assert.equal(canonicalEntityToken("school", "Stanford", OV), stanford)
    const mit = canonicalEntityToken("school", "Massachusetts Institute of Technology", OV)
    assert.equal(canonicalEntityToken("school", "MIT", OV), mit)
  })

  it("folds a constituent college into its university, but not a separately-admitted programme", () => {
    const berkeley = canonicalEntityToken("school", "University of California, Berkeley", OV)
    assert.equal(canonicalEntityToken("school", "UC Berkeley College of Engineering", OV), berkeley)
    assert.equal(
      canonicalEntityToken("school", "University of California, Berkeley, Haas School of Business", OV),
      berkeley,
    )
    // Attending a university-branded high school does not make somebody an alum.
    const stanford = canonicalEntityToken("school", "Stanford University", OV)
    assert.notEqual(canonicalEntityToken("school", "Stanford Online High School", OV), stanford)
  })

  it("strips legal suffixes and alumni prefixes so a company is one identity", () => {
    const stripe = canonicalEntityToken("company", "Stripe", OV)
    assert.equal(stripe, "stripe")
    for (const variant of ["Stripe, Inc.", "stripe inc", "ex-Stripe", "former Stripe", "STRIPE"]) {
      assert.equal(canonicalEntityToken("company", variant, OV), stripe, `"${variant}" must resolve to Stripe`)
    }
  })

  it("does NOT match a company that merely shares a word — the substring bug, inverted", () => {
    const meta = canonicalEntityToken("company", "Meta", OV)
    for (const other of ["Metaculus", "MetaProp", "The Meta-Layer Initiative"]) {
      assert.notEqual(canonicalEntityToken("company", other, OV), meta, `"${other}" is not Meta`)
    }
  })

  it("places degree prose and postal prose into the closed vocabularies", () => {
    assert.equal(canonicalEntityToken("major", "Bachelor of Science - BS, Computer Science", OV), "computer_science")
    assert.equal(canonicalEntityToken("major", "computer science", OV), "computer_science")
    assert.equal(
      canonicalEntityToken("location", "San Francisco, California, United States", OV),
      "san_francisco_bay_area",
    )
    assert.equal(canonicalEntityToken("location", "Cambridge, Massachusetts, United States", OV), "boston_metro")
  })

  it("returns null rather than guessing — a non-major and a country are not identities", () => {
    // Adam 2026-07-25 "查不到就不要硬匹配": no identity means fewer results and an honest
    // relax path, never a substring fallback.
    for (const notAMajor of ["High School Diploma", "Bachelor's degree", "Dual Enrollment"]) {
      assert.equal(canonicalEntityToken("major", notAMajor, OV), null, `"${notAMajor}" is not a field of study`)
    }
    for (const notAMetro of ["United States", "Canada", "India"]) {
      assert.equal(canonicalEntityToken("location", notAMetro, OV), null, `"${notAMetro}" is not one metro`)
    }
    assert.equal(canonicalEntityToken("company", "", OV), null)
    assert.equal(canonicalEntityToken("school", null, OV), null)
  })

  it("reads the abbreviation out of a parenthetical", () => {
    assert.equal(entityParenAlias("Amazon Web Services (AWS)"), "aws")
    assert.equal(entityParenAlias("Stripe"), null)
  })

  it("intersects as sets, and an empty side never matches", () => {
    assert.equal(tokensIntersect(["a", "b"], ["b"]), true)
    assert.equal(tokensIntersect(["a"], ["b"]), false)
    assert.equal(tokensIntersect([], ["a"]), false)
    assert.equal(tokensIntersect(["a"], []), false)
    assert.deepEqual(canonicalEntityTokens("company", ["Stripe", "Stripe, Inc.", null, ""], OV), ["stripe"])
  })
})
