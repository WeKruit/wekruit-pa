/**
 * v1.9 Phase 89 — feedback survey tests.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { isSkipReply } from "../feedback-survey.js"

describe("isSkipReply", () => {
  it("matches en skip variants", () => {
    assert.equal(isSkipReply("skip"), true)
    assert.equal(isSkipReply("Skip"), true)
    assert.equal(isSkipReply("no thanks"), true)
    assert.equal(isSkipReply("nope"), true)
    assert.equal(isSkipReply("pass"), true)
    assert.equal(isSkipReply("skip."), true)
  })
  it("matches zh skip variants", () => {
    assert.equal(isSkipReply("不用"), true)
    assert.equal(isSkipReply("不想"), true)
    assert.equal(isSkipReply("跳过"), true)
  })
  it("does not match real feedback", () => {
    assert.equal(isSkipReply("5"), false)
    assert.equal(isSkipReply("loved it"), false)
    assert.equal(isSkipReply("could be faster"), false)
  })
})
