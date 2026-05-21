import test from "node:test"
import assert from "node:assert/strict"
import { parseIdList } from "./CoresignalBatchNew.helpers.js"

test("parseIdList — JSON array of numbers", () => {
  const r = parseIdList("[1, 2, 3, 4]")
  assert.deepEqual(r.ids, [1, 2, 3, 4])
  assert.equal(r.invalidLines.length, 0)
})

test("parseIdList — JSON array with string numbers coerces", () => {
  const r = parseIdList(`["1", "2", "3"]`)
  assert.deepEqual(r.ids, [1, 2, 3])
})

test("parseIdList — JSON array drops invalid entries", () => {
  const r = parseIdList(`[1, "abc", 3, null, -5, 0]`)
  assert.deepEqual(r.ids, [1, 3])
  assert.ok(r.invalidLines.length >= 3)
})

test("parseIdList — newline-separated integers", () => {
  const r = parseIdList("725992096\n757303208\n841392314")
  assert.deepEqual(r.ids, [725992096, 757303208, 841392314])
  assert.equal(r.invalidLines.length, 0)
})

test("parseIdList — comma + space separated", () => {
  const r = parseIdList("1, 2, 3  4\t5")
  assert.deepEqual(r.ids, [1, 2, 3, 4, 5])
})

test("parseIdList — strips non-digit chars from tokens", () => {
  const r = parseIdList("id-123 id-456")
  assert.deepEqual(r.ids, [123, 456])
})

test("parseIdList — empty input returns empty", () => {
  const r = parseIdList("")
  assert.deepEqual(r.ids, [])
  assert.equal(r.invalidLines.length, 0)
})

test("parseIdList — whitespace-only input returns empty", () => {
  const r = parseIdList("   \n\t  ")
  assert.deepEqual(r.ids, [])
})

test("parseIdList — malformed JSON falls back to line parse", () => {
  const r = parseIdList("[1, 2, 3,")
  // Falls through to line parser which strips '[' and ','
  // -> tokens "1", "2", "3"
  assert.deepEqual(r.ids, [1, 2, 3])
})

test("parseIdList — accepts large ids (CoreSignal range)", () => {
  const r = parseIdList("[725992096, 977619828]")
  assert.deepEqual(r.ids, [725992096, 977619828])
})

test("parseIdList — does not dedupe (callsite handles uniqueness)", () => {
  const r = parseIdList("[1, 1, 2, 2, 3]")
  assert.deepEqual(r.ids, [1, 1, 2, 2, 3])
})
