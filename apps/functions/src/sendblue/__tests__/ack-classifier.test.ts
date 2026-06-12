import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  classifyInboundReplyNeed,
  inboundAwaitsRealReply,
} from "../ack-classifier.js"

describe("classifyInboundReplyNeed", () => {
  it("classifies pure acks that follow a Claire message as pure_ack", () => {
    for (const ack of ["thanks", "Thanks!", "ok", "okay", "k", "sounds good", "will do", "got it", "ty", "perfect", "👍", "🙏"]) {
      assert.equal(
        classifyInboundReplyNeed(ack, { followsClaireMessage: true }),
        "pure_ack",
        `expected pure_ack for ${JSON.stringify(ack)}`,
      )
    }
  })

  it("treats a bare greeting as greeting (owes a TEXT reply), never pure_ack", () => {
    for (const g of ["hi", "Hey", "hello", "yo", "what's up", "你好"]) {
      assert.equal(classifyInboundReplyNeed(g, { followsClaireMessage: true }), "greeting", g)
    }
    // The greeting carve-out: a greeting still awaits a real reply.
    assert.equal(inboundAwaitsRealReply("hi", { followsClaireMessage: true }), true)
  })

  it("classifies STOP / opt-out as stop (terminal, no reply owed)", () => {
    for (const s of ["STOP", "stop", "unsubscribe", "Cancel", "remove me", "delete me"]) {
      assert.equal(classifyInboundReplyNeed(s, { followsClaireMessage: true }), "stop", s)
    }
    assert.equal(inboundAwaitsRealReply("STOP", { followsClaireMessage: true }), false)
  })

  it("classifies substantive messages as other (a real reply IS owed)", () => {
    for (const m of [
      "can you tell me more about the role?",
      "I'm interested but what's the salary",
      "did my screen go through?",
      "actually I want remote only",
    ]) {
      assert.equal(classifyInboundReplyNeed(m, { followsClaireMessage: true }), "other", m)
      assert.equal(inboundAwaitsRealReply(m, { followsClaireMessage: true }), true)
    }
  })

  it("a pure ack with NO preceding Claire message is NOT pure_ack (engage instead)", () => {
    // "ok" cold-opened (no prior Claire turn) → other (we still engage).
    assert.equal(classifyInboundReplyNeed("ok", { followsClaireMessage: false }), "other")
    // A bare emoji cold-opened → greeting (treat as opener), still owes a reply.
    assert.equal(classifyInboundReplyNeed("👍", { followsClaireMessage: false }), "greeting")
  })

  it("inboundAwaitsRealReply: false for pure ack, true for greeting/other", () => {
    assert.equal(inboundAwaitsRealReply("thanks", { followsClaireMessage: true }), false)
    assert.equal(inboundAwaitsRealReply("hi", { followsClaireMessage: true }), true)
    assert.equal(inboundAwaitsRealReply("what's the pay", { followsClaireMessage: true }), true)
  })

  it("is conservative: ack-word combos and long messages are other, never a false ack", () => {
    assert.equal(classifyInboundReplyNeed("thanks but actually can we do remote", { followsClaireMessage: true }), "other")
    assert.equal(classifyInboundReplyNeed("ok so when is the interview", { followsClaireMessage: true }), "other")
  })
})
