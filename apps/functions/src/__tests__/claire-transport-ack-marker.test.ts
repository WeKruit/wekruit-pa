/**
 * Feature 2 (ack tapback): when Claire correctly sends NO text reply for an ack —
 * via react_to_user (tapback) or no_reply — the turn must still be ACKNOWLEDGED so
 * (a) the user isn't left in dead silence (the tapback rides the same thread) and
 * (b) the unanswered-inbound alert sweep can EXCLUDE this handled turn.
 *
 * These assertions pin the durable `pa-inbound-acks` marker the transport writes on
 * tapback / no_reply, keyed by inboundEventId, so recovery-agent's sweep can read it.
 *
 * Run: node --import tsx --test apps/functions/src/__tests__/claire-transport-ack-marker.test.ts
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createSendblueTransport, PA_INBOUND_ACK_COLLECTION } from "../claire-agent/transport.js"

type Write = { collection: string; id: string; data: Record<string, unknown> }

function fakeDb() {
  const writes: Write[] = []
  const db = {
    collection(collection: string) {
      return {
        doc(id: string) {
          return {
            async set(data: Record<string, unknown>) {
              writes.push({ collection, id, data })
            },
          }
        },
      }
    },
  }
  return { db, writes }
}

function harness(extra: Record<string, unknown>) {
  const { db, writes } = fakeDb()
  const reactions: string[] = []
  const transport = createSendblueTransport({
    db: db as never,
    toE164: "+14243201960",
    userId: "u-ack",
    sessionId: "ses_ack",
    inboundMessageHandle: "h-inbound-1",
    sendReaction: (async (input: { reaction: string }) => {
      reactions.push(input.reaction)
      return {}
    }) as never,
    ...extra,
  })
  return { transport, writes, reactions }
}

test("tapback writes a durable pa-inbound-acks marker keyed by inboundEventId", async () => {
  const h = harness({ inboundEventId: "inb_ack_1" })
  await h.transport.tapback("like")
  // marker async via void; allow the microtask to settle.
  await new Promise((r) => setTimeout(r, 0))

  assert.deepEqual(h.reactions, ["like"], "the tapback still fires (user sees acknowledgment)")
  const marker = h.writes.find((w) => w.collection === PA_INBOUND_ACK_COLLECTION)
  assert.ok(marker, "a pa-inbound-acks marker is written")
  assert.equal(marker!.id, "inb_ack_1", "keyed by the inbound event id")
  assert.equal(marker!.data.via, "tapback")
  assert.equal(marker!.data.userId, "u-ack")
})

test("no_reply also writes the ack marker (deliberate silence is a handled turn, not a drop)", async () => {
  const h = harness({ inboundEventId: "inb_ack_2" })
  await h.transport.noReply("nothing owed")
  await new Promise((r) => setTimeout(r, 0))

  const marker = h.writes.find((w) => w.collection === PA_INBOUND_ACK_COLLECTION)
  assert.ok(marker, "no_reply writes the marker")
  assert.equal(marker!.id, "inb_ack_2")
  assert.equal(marker!.data.via, "no_reply")
})

test("no inboundEventId (proactive turn) → no marker write, no throw", async () => {
  const h = harness({}) // no inboundEventId
  await h.transport.tapback("love")
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(h.reactions.length, 1, "tapback still fires")
  assert.equal(
    h.writes.filter((w) => w.collection === PA_INBOUND_ACK_COLLECTION).length,
    0,
    "no marker without an inbound event id (nothing to key on)",
  )
})

test("dryRun: no marker, no reaction (ledger only)", async () => {
  const h = harness({ inboundEventId: "inb_ack_3", dryRun: true })
  await h.transport.tapback("like")
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(h.reactions.length, 0, "no real reaction in dryRun")
  assert.equal(
    h.writes.filter((w) => w.collection === PA_INBOUND_ACK_COLLECTION).length,
    0,
    "no durable marker in dryRun",
  )
})
