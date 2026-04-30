/**
 * Phase 36 T1 — position-constraint tests.
 *
 * Verifies the SINGLE-TURN turn-onset invariant:
 * - Marker MUST appear at index 0 of returned text.
 * - Anti-stutter: refuses injection when text already starts with marker
 *   or any of the prev-turn marker set.
 * - Bilingual: zh + en + mixed inputs all handled.
 *
 * No I/O. Pure function tests.
 */
import { describe, test } from "node:test"
import assert from "node:assert/strict"

import {
  injectAtTurnOnset,
  isAtTurnOnset,
  startsWithMarker,
  startsWithAnyMarker,
} from "./position-constraint.js"

describe("Phase 36 T1 — position-constraint", () => {
  describe("injectAtTurnOnset — happy path", () => {
    test("zh hesitate marker — '嗯…' prefixed to onset", () => {
      const r = injectAtTurnOnset("今晚先睡吧。", "嗯…", "")
      assert.equal(r.ok, true)
      assert.equal(r.injected, "嗯…今晚先睡吧。")
      assert.ok(isAtTurnOnset(r.injected, "嗯…"))
    })

    test("zh clarify marker — '等等，' prefixed", () => {
      const r = injectAtTurnOnset("这个我不太懂。", "等等，", "")
      assert.equal(r.ok, true)
      assert.equal(r.injected, "等等，这个我不太懂。")
    })

    test("en hesitate marker — 'hmm' + ', ' separator", () => {
      const r = injectAtTurnOnset("rest tonight.", "hmm", ", ")
      assert.equal(r.ok, true)
      assert.equal(r.injected, "hmm, rest tonight.")
    })

    test("en em-dash marker — 'oh —' carries its own separator", () => {
      const r = injectAtTurnOnset("rest tonight.", "oh — ", "")
      assert.equal(r.ok, true)
      assert.equal(r.injected, "oh — rest tonight.")
    })

    test("mixed-lang text with zh marker", () => {
      const r = injectAtTurnOnset("我用 React 写过 dashboard.", "嗯…", "")
      assert.equal(r.ok, true)
      assert.equal(r.injected, "嗯…我用 React 写过 dashboard.")
    })

    test("strips leading whitespace from input before prepending", () => {
      const r = injectAtTurnOnset("   今晚先睡。", "嗯…", "")
      assert.equal(r.ok, true)
      assert.equal(r.injected, "嗯…今晚先睡。")
    })
  })

  describe("injectAtTurnOnset — skip conditions", () => {
    test("empty text → ok: false, reason: empty_text", () => {
      const r = injectAtTurnOnset("", "嗯", "")
      assert.equal(r.ok, false)
      assert.equal(r.reason, "empty_text")
    })

    test("empty marker → ok: false, reason: empty_marker", () => {
      const r = injectAtTurnOnset("今晚先睡。", "", "")
      assert.equal(r.ok, false)
      assert.equal(r.reason, "empty_marker")
    })

    test("ANTI-STUTTER: same marker already at start", () => {
      const r = injectAtTurnOnset("嗯…今晚先睡。", "嗯…", "")
      assert.equal(r.ok, false)
      assert.equal(r.reason, "already_starts_with_marker")
      // input unchanged.
      assert.equal(r.injected, "嗯…今晚先睡。")
    })

    test("ANTI-STUTTER: text starts with one of additional markers", () => {
      const r = injectAtTurnOnset("等等，再想想。", "嗯…", "", {
        existingMarkers: ["等等，", "嗯…", "哦…"],
      })
      assert.equal(r.ok, false)
      assert.equal(r.reason, "already_starts_with_policy_marker")
    })

    test("ANTI-STUTTER: text starts with marker after leading whitespace", () => {
      const r = injectAtTurnOnset("   嗯…今晚先睡。", "嗯…", "")
      assert.equal(r.ok, false)
      assert.equal(r.reason, "already_starts_with_marker")
    })
  })

  describe("startsWithMarker / startsWithAnyMarker", () => {
    test("startsWithMarker — exact prefix match", () => {
      assert.equal(startsWithMarker("嗯…今晚先睡", "嗯…"), true)
      assert.equal(startsWithMarker("hmm, rest tonight", "hmm"), true)
      assert.equal(startsWithMarker("今晚先睡。", "嗯…"), false)
    })

    test("startsWithMarker — empty inputs", () => {
      assert.equal(startsWithMarker("", "嗯"), false)
      assert.equal(startsWithMarker("嗯", ""), false)
    })

    test("startsWithAnyMarker — at least one match", () => {
      assert.equal(
        startsWithAnyMarker("嗯…今晚先睡。", ["啊不对，是", "嗯…", "哦…"]),
        true
      )
      assert.equal(
        startsWithAnyMarker("今晚先睡。", ["啊不对，是", "嗯…", "哦…"]),
        false
      )
      assert.equal(startsWithAnyMarker("anything", []), false)
    })
  })

  describe("isAtTurnOnset — defense-in-depth invariant", () => {
    test("marker at index 0 → true", () => {
      assert.equal(isAtTurnOnset("嗯…今晚先睡。", "嗯…"), true)
      assert.equal(isAtTurnOnset("hmm, rest tonight.", "hmm"), true)
    })

    test("marker NOT at index 0 → false", () => {
      assert.equal(isAtTurnOnset("今晚先睡。嗯…", "嗯…"), false)
      assert.equal(isAtTurnOnset("rest tonight, hmm.", "hmm"), false)
    })

    test("empty inputs → false", () => {
      assert.equal(isAtTurnOnset("", "嗯…"), false)
      assert.equal(isAtTurnOnset("嗯", ""), false)
    })
  })

  describe("Latency — < 5ms over 1000 calls (no I/O)", () => {
    test("1000 calls finish within budget", () => {
      const inputs = [
        ["今晚先睡。", "嗯…"],
        ["rest tonight.", "hmm"],
        ["我用 React 写过 dashboard.", "等等，"],
        ["interview was brutal", "wait"],
        ["", "嗯"], // skip
        ["嗯…already.", "嗯…"], // anti-stutter skip
      ]
      const start = performance.now()
      for (let i = 0; i < 1000; i++) {
        const [text, marker] = inputs[i % inputs.length]
        injectAtTurnOnset(text, marker, "")
      }
      const elapsed = performance.now() - start
      // Generous — pure JS string ops; budget is per-call < 5ms; 1000
      // calls < 5000ms is huge headroom. We check < 200ms total to stay
      // honest about typical perf (~0.2ms each).
      assert.ok(elapsed < 200, `1000 calls took ${elapsed.toFixed(1)}ms (> 200ms budget)`)
    })
  })
})
