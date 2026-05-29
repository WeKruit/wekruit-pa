/**
 * Regression: outbound idempotency key must NOT collide across DIFFERENT inbound events.
 *
 * The 2026-05-29 dev-phone silent-kickoff: the onboarding question body is deterministic and
 * the sessionId is stable per user, so the old key (`sessionId:hash(body)`, used because cutover
 * never passed inboundEventId) re-keyed identically on a re-kickoff → ALREADY_EXISTS against an
 * earlier `sent` row → enqueueOutbound returned created:false → the reply was silently dropped.
 *
 * The fix keys on the inbound event id (UNIQUE per inbound) + the body hash. These assertions pin
 * the four cases: re-kickoff sends, true retry dedups, multi-bubble both send, fallback still varies.
 *
 * Run: node --import tsx --test apps/functions/src/__tests__/claire-transport-idempotency.test.ts
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createSendblueTransport } from "../claire-agent/transport.js"

const KICKOFF =
  "hey! for this next phase, what matters most in your next company: career growth, compensation, stability, mission, learning, or something else?"

function harness(extra: Record<string, unknown>) {
  const keys: string[] = []
  const transport = createSendblueTransport({
    db: {} as never,
    toE164: "+14243201960",
    userId: "u1",
    sessionId: "ses_stable",
    enqueueOutbound: async (_db, input) => {
      keys.push(input.idempotencyKey)
      return { id: input.idempotencyKey, created: true }
    },
    ...extra,
  })
  return { transport, keys }
}

test("re-kickoff: SAME body + DIFFERENT inbound event → DIFFERENT keys (the reply MUST send again)", async () => {
  const a = harness({ inboundEventId: "inb_A" })
  const b = harness({ inboundEventId: "inb_B" })
  await a.transport.sendText(KICKOFF)
  await b.transport.sendText(KICKOFF)
  assert.notEqual(a.keys[0], b.keys[0], "identical kickoff body across two inbound events must not collide")
})

test("true retry: SAME inbound event + SAME body → SAME key (dedups a genuine double-send)", async () => {
  const a = harness({ inboundEventId: "inb_A" })
  await a.transport.sendText("ping")
  await a.transport.sendText("ping")
  assert.equal(a.keys[0], a.keys[1])
})

test("multi-bubble turn: SAME inbound event + DIFFERENT bodies → DIFFERENT keys (both bubbles send)", async () => {
  const a = harness({ inboundEventId: "inb_A" })
  await a.transport.sendText("first bubble")
  await a.transport.sendText("second bubble")
  assert.notEqual(a.keys[0], a.keys[1])
})

test("fallback (no event id): key still varies by body so multi-bubble survives", async () => {
  const a = harness({})
  await a.transport.sendText("first bubble")
  await a.transport.sendText("second bubble")
  assert.notEqual(a.keys[0], a.keys[1])
})

test("keys are prefixed claire-reply- and event-scoped", async () => {
  const a = harness({ inboundEventId: "inb_Z" })
  await a.transport.sendText(KICKOFF)
  assert.match(a.keys[0], /^claire-reply-inb_Z:[0-9a-f]{16}$/)
})
