/**
 * S3 voice state machine — pure-reducer tests.
 *
 * Covers acceptance:
 *   "state machine rejects invalid transitions (connected→queued)"
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  canTransition,
  isForwardTransition,
  assertTransition,
  isTerminal,
  InvalidVoiceTransitionError,
  type VoiceState,
} from "../state-machine.js"

describe("voice state-machine reducer", () => {
  it("allows the canonical L10 path queued → reconciled", () => {
    const path: VoiceState[] = [
      "queued",
      "dialing",
      "connected",
      "completed",
      "reconciled",
    ]
    for (let i = 0; i < path.length - 1; i++) {
      assert.ok(
        canTransition(path[i]!, path[i + 1]!),
        `should allow ${path[i]} → ${path[i + 1]}`,
      )
    }
  })

  it("allows dialing → failed (no answer / SIP error)", () => {
    assert.ok(canTransition("dialing", "failed"))
  })

  it("allows connected → failed (mid-call drop)", () => {
    assert.ok(canTransition("connected", "failed"))
  })

  it("allows failed → reconciled (terminal sweep)", () => {
    assert.ok(canTransition("failed", "reconciled"))
  })

  it("rejects connected → queued (regression-attempt)", () => {
    assert.equal(canTransition("connected", "queued"), false)
  })

  it("rejects completed → dialing (regression-attempt)", () => {
    assert.equal(canTransition("completed", "dialing"), false)
  })

  it("rejects reconciled → anything-but-self", () => {
    assert.equal(canTransition("reconciled", "completed"), false)
    assert.equal(canTransition("reconciled", "failed"), false)
    assert.equal(canTransition("reconciled", "dialing"), false)
  })

  it("treats self-transitions as allowed but not forward", () => {
    assert.ok(canTransition("dialing", "dialing"))
    assert.equal(isForwardTransition("dialing", "dialing"), false)
  })

  it("forward predicate excludes self and disallowed", () => {
    assert.ok(isForwardTransition("dialing", "connected"))
    assert.equal(isForwardTransition("connected", "queued"), false)
  })

  it("assertTransition throws InvalidVoiceTransitionError on disallowed", () => {
    assert.throws(
      () => assertTransition("connected", "queued"),
      (err) =>
        err instanceof InvalidVoiceTransitionError &&
        err.from === "connected" &&
        err.to === "queued",
    )
  })

  it("isTerminal flags completed/failed/reconciled, not queued/dialing/connected", () => {
    assert.ok(isTerminal("completed"))
    assert.ok(isTerminal("failed"))
    assert.ok(isTerminal("reconciled"))
    assert.equal(isTerminal("queued"), false)
    assert.equal(isTerminal("dialing"), false)
    assert.equal(isTerminal("connected"), false)
  })
})
