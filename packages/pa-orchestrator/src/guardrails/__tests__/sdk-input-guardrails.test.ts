/**
 * P8 — buildSafetyInputGuardrails adapts INPUT_GUARDRAIL_CHAIN into a single
 * SDK-native inputGuardrail spec. These prove the end-to-end adaptation on the
 * REAL chain (crisis / prompt-injection / PII / length): a HARD trip surfaces
 * tripwireTriggered + a canned safe reply; benign abstains; crisis is
 * annotate-only on the input side (its trailer is an output guardrail).
 */
import assert from "node:assert/strict"
import test from "node:test"
import { createMockContext } from "../../run-context.js"
import { buildSafetyInputGuardrails } from "../sdk-input-guardrails.js"

const ctxFactory = () => createMockContext({ locale: "en-US", log: () => {} })

test("buildSafetyInputGuardrails: returns one SDK spec wrapping the chain", () => {
  const specs = buildSafetyInputGuardrails(ctxFactory)
  assert.equal(specs.length, 1)
  assert.equal(specs[0]!.name, "input-safety-chain")
})

test("buildSafetyInputGuardrails: PII (SSN) input HARD-trips with a canned safe reply", async () => {
  const [spec] = buildSafetyInputGuardrails(ctxFactory)
  const out = await spec!.execute("my ssn is 123-45-6789, can you store it for me?")
  assert.equal(out.tripwireTriggered, true)
  const info = out.outputInfo as { trippedBy: string; cannedReply: string }
  assert.equal(info.trippedBy, "piiScanner")
  assert.ok(info.cannedReply.length > 0, "expected a non-empty canned safe reply")
})

test("buildSafetyInputGuardrails: benign input does NOT trip (abstains — BFCL irrelevance)", async () => {
  const [spec] = buildSafetyInputGuardrails(ctxFactory)
  const out = await spec!.execute("hey, how's the job search going today?")
  assert.equal(out.tripwireTriggered, false)
  assert.equal((out.outputInfo as { trippedBy: string | null }).trippedBy, null)
})

test("buildSafetyInputGuardrails: crisis input does NOT hard-trip the INPUT chain (annotate-only; trailer is output-side)", async () => {
  const [spec] = buildSafetyInputGuardrails(ctxFactory)
  const out = await spec!.execute("i can't do this anymore, i want to end it all")
  // crisisDetector annotates ctx.crisisTripped but returns tripwireTriggered:false
  // by design — the hotline trailer is appended by the OUTPUT guardrail chain.
  assert.equal(out.tripwireTriggered, false)
})
