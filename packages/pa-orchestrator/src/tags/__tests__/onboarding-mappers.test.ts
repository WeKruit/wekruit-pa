/**
 * Phase 54 (USER-TAG-03) — Unit tests for onboarding-mappers.
 *
 * Coverage:
 *   - mapAnswerToRoleFunction: bilingual keyword matching, multi-pick, empty
 *   - mapAnswerToVisa: 4-enum collapse (OPT/CPT/H1B → sponsor_needed)
 *   - mapAnswerToLocations: alias resolution (SF → san_francisco_bay_area)
 *   - bucketYoe: numeric → bucket strings
 *   - mapAnswerToYoeBucket: free-text → bucket
 *   - detectLang: CJK vs Latin counting + thresholds
 */

import assert from "node:assert/strict"
import test from "node:test"
import {
  mapAnswerToRoleFunction,
  mapAnswerToVisa,
  mapAnswerToLocations,
  bucketYoe,
  mapAnswerToYoeBucket,
  detectLang,
} from "../onboarding-mappers.js"

// ---------------------------------------------------------------------------
// mapAnswerToRoleFunction
// ---------------------------------------------------------------------------

test("mapAnswerToRoleFunction: SWE keywords → software_engineering", () => {
  assert.deepEqual(mapAnswerToRoleFunction("software engineer"), [
    "software_engineering",
  ])
  assert.deepEqual(mapAnswerToRoleFunction("frontend dev"), [
    "software_engineering",
  ])
  assert.deepEqual(mapAnswerToRoleFunction("full stack"), [])
  assert.deepEqual(mapAnswerToRoleFunction("fullstack"), [
    "software_engineering",
  ])
  // (Chinese-input case removed — product is English-only)
})

test("mapAnswerToRoleFunction: PM keywords → product_management", () => {
  assert.deepEqual(mapAnswerToRoleFunction("PM"), ["product_management"])
  assert.deepEqual(mapAnswerToRoleFunction("Product Manager"), [
    "product_management",
  ])
})

test("mapAnswerToRoleFunction: business analysis → business_analyst", () => {
  assert.deepEqual(mapAnswerToRoleFunction("business analysis"), [
    "business_analyst",
  ])
  assert.deepEqual(mapAnswerToRoleFunction("Executive Assistant"), [
    "business_analyst",
  ])
  assert.deepEqual(mapAnswerToRoleFunction("program operations coordinator"), [
    "business_analyst",
  ])
})

test("mapAnswerToRoleFunction: data role → data_analysis", () => {
  assert.deepEqual(mapAnswerToRoleFunction("data scientist"), ["data_analysis"])
  assert.deepEqual(mapAnswerToRoleFunction("ML engineer"), ["data_analysis"])
  assert.deepEqual(mapAnswerToRoleFunction("data analytics & insights extern"), [
    "data_analysis",
  ])
})

test("mapAnswerToRoleFunction: empty / null / non-string → []", () => {
  assert.deepEqual(mapAnswerToRoleFunction(""), [])
  assert.deepEqual(mapAnswerToRoleFunction(null), [])
  assert.deepEqual(mapAnswerToRoleFunction(undefined), [])
  assert.deepEqual(mapAnswerToRoleFunction("    "), [])
})

test("mapAnswerToRoleFunction: unrecognized → []", () => {
  assert.deepEqual(mapAnswerToRoleFunction("librarian"), [])
  assert.deepEqual(mapAnswerToRoleFunction("retail clerk"), [])
})

test("mapAnswerToRoleFunction: teaching assistant → education_and_training", () => {
  assert.deepEqual(mapAnswerToRoleFunction("teaching assistant"), [
    "education_and_training",
  ])
  assert.deepEqual(mapAnswerToRoleFunction("math tutor"), [
    "education_and_training",
  ])
})

test("mapAnswerToRoleFunction: multi-pick when multiple keywords", () => {
  // Both data and PM
  const res = mapAnswerToRoleFunction("data scientist and product manager")
  assert.ok(res.includes("data_analysis"))
  assert.ok(res.includes("product_management"))
  assert.equal(res.length, 2)
})

// ---------------------------------------------------------------------------
// mapAnswerToVisa
// ---------------------------------------------------------------------------

test("mapAnswerToVisa: citizen detection", () => {
  assert.equal(mapAnswerToVisa("US citizen"), "citizen")
  assert.equal(mapAnswerToVisa("USC"), "citizen")
})

test("mapAnswerToVisa: green card → permanent_resident", () => {
  assert.equal(mapAnswerToVisa("green card"), "permanent_resident")
  assert.equal(mapAnswerToVisa("GC holder"), "permanent_resident")
  assert.equal(mapAnswerToVisa("permanent resident"), "permanent_resident")
})

test("mapAnswerToVisa: OPT/CPT/H1B/H4 EAD all collapse to sponsor_needed (D4)", () => {
  assert.equal(mapAnswerToVisa("on OPT"), "sponsor_needed")
  assert.equal(mapAnswerToVisa("STEM OPT"), "sponsor_needed")
  assert.equal(mapAnswerToVisa("CPT"), "sponsor_needed")
  assert.equal(mapAnswerToVisa("H1B holder"), "sponsor_needed")
  assert.equal(mapAnswerToVisa("h-1b"), "sponsor_needed")
  assert.equal(mapAnswerToVisa("need sponsorship"), "sponsor_needed")
  assert.equal(mapAnswerToVisa("F-1 student"), "sponsor_needed")
})

test("mapAnswerToVisa: empty / unrecognized → other", () => {
  assert.equal(mapAnswerToVisa(""), "other")
  assert.equal(mapAnswerToVisa(null), "other")
  assert.equal(mapAnswerToVisa("not sure"), "other")
})

// ---------------------------------------------------------------------------
// mapAnswerToLocations
// ---------------------------------------------------------------------------

test("mapAnswerToLocations: SF → san_francisco_bay_area", () => {
  assert.deepEqual(mapAnswerToLocations("SF"), ["san_francisco_bay_area"])
  assert.deepEqual(mapAnswerToLocations("Bay Area"), [
    "san_francisco_bay_area",
  ])
})

test("mapAnswerToLocations: NYC → new_york_metro", () => {
  assert.deepEqual(mapAnswerToLocations("NYC"), ["new_york_metro"])
  assert.deepEqual(mapAnswerToLocations("New York"), ["new_york_metro"])
})

test("mapAnswerToLocations: remote keyword → remote_united_states", () => {
  assert.deepEqual(mapAnswerToLocations("remote"), ["remote_united_states"])
})

test("mapAnswerToLocations: anywhere → remote_anywhere", () => {
  assert.deepEqual(mapAnswerToLocations("anywhere"), ["remote_anywhere"])
})

test("mapAnswerToLocations: multi-city pick", () => {
  const res = mapAnswerToLocations("SF or NYC")
  assert.ok(res.includes("san_francisco_bay_area"))
  assert.ok(res.includes("new_york_metro"))
})

test("mapAnswerToLocations: empty / unknown → []", () => {
  assert.deepEqual(mapAnswerToLocations(""), [])
  assert.deepEqual(mapAnswerToLocations(null), [])
  assert.deepEqual(mapAnswerToLocations("uncharted territory"), [])
})

test("mapAnswerToLocations: china cities", () => {
  assert.deepEqual(mapAnswerToLocations("Shanghai"), ["shanghai"])
})

// ---------------------------------------------------------------------------
// bucketYoe
// ---------------------------------------------------------------------------

test("bucketYoe: numeric thresholds", () => {
  assert.equal(bucketYoe(0), "0-1")
  assert.equal(bucketYoe(1), "0-1")
  assert.equal(bucketYoe(2), "2-3")
  assert.equal(bucketYoe(3), "2-3")
  assert.equal(bucketYoe(4), "4-6")
  assert.equal(bucketYoe(6), "4-6")
  assert.equal(bucketYoe(7), "7-10")
  assert.equal(bucketYoe(10), "7-10")
  assert.equal(bucketYoe(11), "10+")
  assert.equal(bucketYoe(20), "10+")
})

test("bucketYoe: invalid input → null", () => {
  assert.equal(bucketYoe(null), null)
  assert.equal(bucketYoe(undefined), null)
  assert.equal(bucketYoe(NaN), null)
  assert.equal(bucketYoe(-1), null)
})

// ---------------------------------------------------------------------------
// mapAnswerToYoeBucket
// ---------------------------------------------------------------------------

test("mapAnswerToYoeBucket: new-grad signals → 0-1", () => {
  assert.equal(mapAnswerToYoeBucket("new grad"), "0-1")
  assert.equal(mapAnswerToYoeBucket("just graduated"), "0-1")
})

test("mapAnswerToYoeBucket: numeric strings", () => {
  assert.equal(mapAnswerToYoeBucket("3 years"), "2-3")
  assert.equal(mapAnswerToYoeBucket("5 yrs"), "4-6")
})

test("mapAnswerToYoeBucket: 10+ explicit", () => {
  assert.equal(mapAnswerToYoeBucket("10+"), "10+")
})

test("mapAnswerToYoeBucket: empty / unrecognized → null", () => {
  assert.equal(mapAnswerToYoeBucket(""), null)
  assert.equal(mapAnswerToYoeBucket(null), null)
  assert.equal(mapAnswerToYoeBucket("a long time"), null)
})

// ---------------------------------------------------------------------------
// detectLang
// ---------------------------------------------------------------------------

test("detectLang: pure CJK → zh", () => {
  assert.equal(detectLang(["你好", "我是软件工程师"]), "zh")
})

test("detectLang: pure Latin → en", () => {
  assert.equal(detectLang(["hello", "I am a software engineer"]), "en")
})

test("detectLang: mixed → mixed", () => {
  // 4 cjk + 4 latin → 50/50 → mixed
  assert.equal(
    detectLang(["I am 一个 software 工程师"]),
    "mixed"
  )
})

test("detectLang: empty input → null", () => {
  assert.equal(detectLang([]), null)
  assert.equal(detectLang(null), null)
  assert.equal(detectLang(undefined), null)
})
