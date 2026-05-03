import assert from "node:assert/strict"
import test from "node:test"
import {
  extractTagsFromUserMessage,
  buildTagWriteback,
} from "./realtime-tagger.js"

test("empty message → no extraction", () => {
  const r = extractTagsFromUserMessage("")
  assert.equal(r.hasUpdate, false)
  assert.equal(r.visaStatus, null)
})

test("zh visa: '我是 OPT'", () => {
  const r = extractTagsFromUserMessage("我是 OPT 第一年")
  assert.equal(r.visaStatus, "opt")
  assert.equal(r.hasUpdate, true)
})

test("en visa: 'I'm on H1B'", () => {
  const r = extractTagsFromUserMessage("I'm on H1B currently")
  assert.equal(r.visaStatus, "h1b")
})

test("location: 'I'm in NYC looking for SWE'", () => {
  const r = extractTagsFromUserMessage("I'm in NYC looking for SWE")
  assert.deepEqual(r.targetLocations, ["NYC"])
})

test("location bilingual: '我在 SF 但 also open to remote'", () => {
  const r = extractTagsFromUserMessage("我在 SF 但 also open to remote")
  assert.ok(r.targetLocations?.includes("SF Bay Area"))
  assert.ok(r.targetLocations?.includes("remote"))
})

test("yoe new-grad zh", () => {
  const r = extractTagsFromUserMessage("我刚毕业找工作")
  assert.deepEqual(r.yoeRange, [0, 1])
})

test("yoe '5 years'", () => {
  const r = extractTagsFromUserMessage("I have 5 years of backend experience")
  assert.deepEqual(r.yoeRange, [5, 5])
})

test("startup pref 'prefer startups' (no bigco mention)", () => {
  const r = extractTagsFromUserMessage("I prefer startups for the hustle")
  assert.equal(r.prefersStartup, true)
})

test("startup pref ambiguous when both signals present", () => {
  // "I prefer startups, hate enterprise" → both startup + enterprise hit
  // → ambiguous → null. Mirrors onboarding parser behavior.
  const r = extractTagsFromUserMessage("I prefer startups, hate enterprise")
  assert.equal(r.prefersStartup, null)
})

test("startup pref bigco zh", () => {
  const r = extractTagsFromUserMessage("我想去大厂")
  assert.equal(r.prefersStartup, false)
})

test("startup pref ambiguous → null", () => {
  const r = extractTagsFromUserMessage("我想找工作")
  assert.equal(r.prefersStartup, null)
})

test("multi-signal message merges correctly", () => {
  const r = extractTagsFromUserMessage(
    "I'm a new grad on OPT looking for SWE roles in NYC, prefer startups"
  )
  assert.deepEqual(r.yoeRange, [0, 1])
  assert.equal(r.visaStatus, "opt")
  assert.deepEqual(r.targetLocations, ["NYC"])
  assert.equal(r.prefersStartup, true)
  assert.equal(r.hasUpdate, true)
})

test("buildTagWriteback omits null fields", () => {
  const r = extractTagsFromUserMessage("I'm on OPT")
  const wb = buildTagWriteback(r)
  assert.ok(wb)
  assert.equal(wb!.statedPreferences.visaStatus, "opt")
  assert.equal("targetLocations" in wb!.statedPreferences, false)
})

test("buildTagWriteback returns null when no update", () => {
  const r = extractTagsFromUserMessage("hello")
  assert.equal(buildTagWriteback(r), null)
})

test("no false positive on benign chat", () => {
  const r = extractTagsFromUserMessage("听起来挺烦的，我懂")
  assert.equal(r.hasUpdate, false)
})

test("ny mention in non-location context — known false positive (acceptable)", () => {
  // "I love NY pizza" — current regex matches "ny\b" → tags as NYC.
  // This is acceptable false-positive given low cost (just adds to
  // location list; user can override via dashboard).
  const r = extractTagsFromUserMessage("I love NY pizza")
  assert.deepEqual(r.targetLocations, ["NYC"])
})
