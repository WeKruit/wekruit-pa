/**
 * decision-trace.test.ts — proves buildDecisionTrace is a pure, total builder that turns a thin turn
 * into a single-read "why did Claire do X" doc: it captures the inbound text, the mode, a derived
 * pattern, the ordered tool calls (name → arguments → output), the reply text, delivery/suppression
 * outcome, and usage — and degrades safely on every odd input (never throws).
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { buildDecisionTrace, deriveTracePattern } from "./decision-trace.js"

const NOW = "2026-06-04T00:00:00.000Z"

test("full happy turn: tool calls (object shape) + reply + usage all land in the trace doc", () => {
  const trace = buildDecisionTrace({
    eventId: "evt-1",
    userId: "u-1",
    sessionId: "s-1",
    inboundText: "show me roles",
    mode: "triage",
    decisionFlags: { mode: "triage" },
    turnResult: {
      finalText: "here are 3 roles 🙌",
      // runtime shape: object array (declared string[] on ClaireRunResult, cast through unknown).
      toolCalls: [
        { name: "find_match", arguments: '{"requestedCount":3}', output: '{"count":3}' },
        { name: "no_reply", arguments: "{}" },
      ] as unknown,
      deliveredViaTool: true,
      usage: { inputTokens: 1200, cachedInputTokens: 800, turnsUsed: 2 },
    },
    nowIso: NOW,
  })

  assert.equal(trace.eventId, "evt-1")
  assert.equal(trace.userId, "u-1")
  assert.equal(trace.sessionId, "s-1")
  assert.equal(trace.inboundText, "show me roles")
  assert.equal(trace.mode, "triage")
  assert.equal(trace.pattern, "normal")
  assert.equal(trace.finalText, "here are 3 roles 🙌")
  assert.equal(trace.deliveredViaTool, true)
  assert.equal(trace.suppressed, false)
  assert.equal(trace.handledBy, "thin_claire")
  assert.equal(trace.createdAt, NOW)
  assert.deepEqual(trace.toolCalls, [
    { name: "find_match", arguments: '{"requestedCount":3}', output: '{"count":3}' },
    { name: "no_reply", arguments: "{}" },
  ])
  assert.deepEqual(trace.usage, { inputTokens: 1200, cachedInputTokens: 800, turnsUsed: 2 })
})

test("suppressed turn: no prose + not tool-delivered ⇒ suppressed=true", () => {
  const trace = buildDecisionTrace({
    eventId: "evt-2",
    userId: "u-2",
    sessionId: "s-2",
    inboundText: "👍",
    mode: "triage",
    decisionFlags: { mode: "triage" },
    turnResult: { finalText: "   ", toolCalls: [] as unknown, deliveredViaTool: false },
    nowIso: NOW,
  })
  assert.equal(trace.suppressed, true)
  assert.deepEqual(trace.toolCalls, [])
  assert.equal(trace.usage, undefined)
})

test("pattern derivation is most-specific-branch-wins from deterministic flags (no text classify)", () => {
  assert.equal(deriveTracePattern({ mode: "prescreen", prescreenSessionId: "ps-1" }), "prescreen")
  assert.equal(deriveTracePattern({ mode: "triage", postParsePitch: true }), "pitch")
  assert.equal(deriveTracePattern({ mode: "triage", offerFirstKickoff: true }), "offer_first")
  assert.equal(
    deriveTracePattern({ mode: "triage", linkedinJustConnected: true }),
    "linkedin_just_connected",
  )
  assert.equal(deriveTracePattern({ mode: "triage", enrichmentInFlight: true }), "enrichment_in_flight")
  assert.equal(deriveTracePattern({ mode: "triage", locationSalaryAsk: true }), "location_salary_ask")
  assert.equal(deriveTracePattern({ mode: "triage", gmailNudge: true }), "gmail_nudge")
  assert.equal(deriveTracePattern({ mode: "onboarding" }), "onboarding")
  assert.equal(deriveTracePattern({ mode: "triage" }), "normal")
  // prescreen flag outranks a pitch flag on the same decision (most-specific wins).
  assert.equal(
    deriveTracePattern({ mode: "prescreen", prescreenSessionId: "ps-1", postParsePitch: true }),
    "prescreen",
  )
})

test("totally absent / garbage turnResult degrades safely, never throws", () => {
  const t1 = buildDecisionTrace({
    eventId: "evt-3",
    userId: "u-3",
    sessionId: "s-3",
    inboundText: "hi",
    mode: "onboarding",
    decisionFlags: { mode: "onboarding" },
    turnResult: undefined,
    nowIso: NOW,
  })
  assert.equal(t1.finalText, "")
  assert.deepEqual(t1.toolCalls, [])
  assert.equal(t1.deliveredViaTool, false)
  assert.equal(t1.suppressed, true)
  assert.equal(t1.pattern, "onboarding")

  // garbage toolCalls (not an array, junk entries) → empty list; string[] back-compat → named calls.
  const t2 = buildDecisionTrace({
    eventId: "evt-4",
    userId: "u-4",
    sessionId: "s-4",
    inboundText: "x",
    mode: "triage",
    decisionFlags: { mode: "triage" },
    turnResult: {
      finalText: "ok",
      toolCalls: ["find_match", { name: "" }, null, 42, { name: "send_status" }] as unknown,
      deliveredViaTool: false,
    },
    nowIso: NOW,
  })
  assert.deepEqual(t2.toolCalls, [{ name: "find_match" }, { name: "send_status" }])
  assert.equal(t2.suppressed, false) // has prose
})
