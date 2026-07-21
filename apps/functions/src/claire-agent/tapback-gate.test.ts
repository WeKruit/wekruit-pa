/**
 * tapback-gate.test.ts — deterministic inbound-tapback no-op gate.
 *
 * RED (pre-gate, live 2026-06-19): a candidate's iMessage REACTION on one of
 * Claire's own messages arrived as plaintext `Loved "<excerpt of Claire's msg>"`
 * and was treated as a fresh user turn — Claire re-acked AND re-ran find_match,
 * dumping a duplicate batch of roles.
 *
 * These tests drive the real runTapbackGate (deps.fetchRecentAssistantBodies as
 * the test seam for the pa-messages read) and pin the contract:
 *
 *   1. Every reaction verb (Loved/Liked/Disliked/Laughed at/Emphasized/Questioned)
 *      on a recent Claire message → handled=true, verified=true. NO outbound (the
 *      gate sends nothing — it only returns handled).
 *   2. Curly AND straight quotes both detected.
 *   3. A genuine user message that merely CONTAINS "loved" (not the reaction shape)
 *      → handled=false (must reach the agent).
 *   4. A well-formed reaction whose quote does NOT match a recent Claire message →
 *      still handled=true (no-op) but verified=false (logged unverified).
 *   5. iMessage-truncated excerpt (prefix + ellipsis) of a long Claire message →
 *      verified=true.
 *   6. The gate performs ZERO sends — it has no send seam at all; downstream
 *      callers short-circuit on handled, so the no-op path emits nothing outbound.
 *
 * Run: node --import tsx --test apps/functions/src/claire-agent/tapback-gate.test.ts
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { runTapbackGate } from "./tapback-gate.js"

const CLAIRE_MSG =
  'pulling fresh data-analysis roles based on your SQL/Python + dashboards + retention impact — give me a few seconds 🔎'

// db is never touched when fetchRecentAssistantBodies is provided.
const STUB_DB = {} as never

function deps(bodies: string[]) {
  const logs: Array<{ event: string; payload?: Record<string, unknown> }> = []
  return {
    logs,
    options: {
      fetchRecentAssistantBodies: async () => bodies,
      log: (event: string, payload?: Record<string, unknown>) => {
        logs.push({ event, payload })
      },
    },
  }
}

test("every reaction verb on a recent Claire message → handled + verified no-op", async () => {
  const verbs = ["Loved", "Liked", "Disliked", "Laughed at", "Emphasized", "Questioned"]
  for (const verb of verbs) {
    const d = deps([CLAIRE_MSG])
    const result = await runTapbackGate(
      STUB_DB,
      { eventId: "evt-1", userId: "user-1", text: `${verb} "${CLAIRE_MSG}"` },
      d.options,
    )
    assert.equal(result.handled, true, `${verb} must be handled`)
    assert.equal(result.verified, true, `${verb} must verify against Claire's message`)
    // The gate emits the no-op log and nothing else; it has no send capability.
    assert.ok(
      d.logs.some((l) => l.event === "pa.inbound.tapback_reaction_noop"),
      `${verb} must log the no-op`,
    )
  }
})

test("curly quotes are detected", async () => {
  const d = deps([CLAIRE_MSG])
  const result = await runTapbackGate(
    STUB_DB,
    { eventId: "evt-2", userId: "user-1", text: `Loved “${CLAIRE_MSG}”` },
    d.options,
  )
  assert.equal(result.handled, true)
  assert.equal(result.verified, true)
})

test("straight quotes are detected", async () => {
  const d = deps([CLAIRE_MSG])
  const result = await runTapbackGate(
    STUB_DB,
    { eventId: "evt-3", userId: "user-1", text: `Loved "${CLAIRE_MSG}"` },
    d.options,
  )
  assert.equal(result.handled, true)
  assert.equal(result.verified, true)
})

test("a real message that merely contains 'loved' is NOT swallowed", async () => {
  const d = deps([CLAIRE_MSG])
  const result = await runTapbackGate(
    STUB_DB,
    { eventId: "evt-4", userId: "user-1", text: "I loved that role, can you send more like it?" },
    d.options,
  )
  assert.equal(result.handled, false, "genuine message must fall through to the agent")
  assert.equal(d.logs.length, 0, "no no-op log for a non-reaction")
})

test("a real message in 'Loved \"X\"' shape but with a trailing clause is NOT a tapback", async () => {
  const d = deps([CLAIRE_MSG])
  const result = await runTapbackGate(
    STUB_DB,
    { eventId: "evt-5", userId: "user-1", text: 'Loved "The Great Gatsby" — what did you think?' },
    d.options,
  )
  // Not anchored: trailing clause means it's not the pure reaction format.
  assert.equal(result.handled, false)
})

test("well-formed reaction whose quote does NOT match Claire → handled but verified=false", async () => {
  const d = deps(["a totally different assistant message"])
  const result = await runTapbackGate(
    STUB_DB,
    { eventId: "evt-6", userId: "user-1", text: 'Loved "some message we never sent"' },
    d.options,
  )
  assert.equal(result.handled, true, "well-formed reaction is no-op even if unverified")
  assert.equal(result.verified, false)
  const noop = d.logs.find((l) => l.event === "pa.inbound.tapback_reaction_noop")
  assert.ok(noop)
  assert.equal(noop?.payload?.verified, false)
})

test("iMessage-truncated excerpt (prefix + ellipsis) verifies against the long message", async () => {
  const longMsg =
    "Here are 3 fresh roles I think fit you well based on everything you told me about your background and what you are looking for next in your career"
  const truncated = longMsg.slice(0, 90) + "…"
  const d = deps([longMsg])
  const result = await runTapbackGate(
    STUB_DB,
    { eventId: "evt-7", userId: "user-1", text: `Liked "${truncated}"` },
    d.options,
  )
  assert.equal(result.handled, true)
  assert.equal(result.verified, true, "truncated prefix must match the full Claire body")
})

test("verification read failure falls open to an unverified no-op (never throws)", async () => {
  const logs: Array<{ event: string }> = []
  const result = await runTapbackGate(
    STUB_DB,
    { eventId: "evt-8", userId: "user-1", text: `Loved "${CLAIRE_MSG}"` },
    {
      fetchRecentAssistantBodies: async () => {
        throw new Error("firestore down")
      },
      log: (event: string) => logs.push({ event }),
    },
  )
  assert.equal(result.handled, true, "must still no-op on a read failure (never re-ack/re-pull)")
  assert.equal(result.verified, false)
  assert.ok(logs.some((l) => l.event === "tapback_gate.verify_failed"))
})

test("non-reaction text returns handled=false with no work done", async () => {
  const d = deps([CLAIRE_MSG])
  const result = await runTapbackGate(
    STUB_DB,
    { eventId: "evt-9", userId: "user-1", text: "find me some new roles please" },
    d.options,
  )
  assert.equal(result.handled, false)
})
