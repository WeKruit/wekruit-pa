/**
 * Phase 22 — Cancellation NLU detector tests.
 * RED phase: defines contract before implementation.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { detectProactiveCancellation, CANCELLATION_PATTERNS } from "./cancellation-nlu.js"

describe("CANCELLATION_PATTERNS", () => {
  it("is a readonly array of RegExp", () => {
    assert.ok(Array.isArray(CANCELLATION_PATTERNS))
    assert.ok(CANCELLATION_PATTERNS.length > 0)
    for (const p of CANCELLATION_PATTERNS) {
      assert.ok(p instanceof RegExp, `Expected RegExp, got ${typeof p}`)
    }
  })
})

describe("detectProactiveCancellation — positive cases", () => {
  const positives = [
    "stop reminders",
    "Stop Reminders",
    "stop the reminders",
    "cancel reminders",
    "Cancel Reminders",
    "cancel my reminders",
    "  stop reminders  ", // whitespace padding
  ]

  for (const phrase of positives) {
    it(`matches "${phrase}"`, () => {
      assert.ok(detectProactiveCancellation(phrase), `Expected match for: "${phrase}"`)
    })
  }
})

describe("detectProactiveCancellation — negative cases", () => {
  const negatives = [
    "remind me tomorrow",
    "I'll stop later",
    "OK got it",
    "cancel that meeting",
    "stop by later",
    "stop it",
    "just stop",
    "cancel",
  ]

  for (const phrase of negatives) {
    it(`does NOT match "${phrase}"`, () => {
      assert.ok(!detectProactiveCancellation(phrase), `Expected no match for: "${phrase}"`)
    })
  }
})
