/**
 * Multi-bubble ORDER gate (2026-07-25 incident).
 *
 * Live evidence: a 7-bubble burst was created ~1.2s apart in the right order but two rows were
 * picked up ~15s late by their own concurrent outbox invocation and landed AFTER the closer
 * ("intro, Jerry, Eshaan, Max, CLOSER, Daniel, Ethan"). `paced:true` removes our own dwell but
 * cannot order independent consumers — this gate is the missing edge.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { awaitEarlierBubblesSent, isBlockingEarlierBubble } from "../outbox.js"

type DocData = Record<string, unknown>

/** Minimal fake Firestore serving `pa-outbound` userId queries from a Map. */
function makeDb(rows: Map<string, DocData>) {
  return {
    collection(_name: string) {
      const q = {
        where(_f: string, _op: string, _v: unknown) {
          return q
        },
        orderBy() {
          return q
        },
        limit() {
          return q
        },
        async get() {
          const docs = [...rows.entries()].map(([id, d]) => ({ id, data: () => d }))
          return { empty: docs.length === 0, docs }
        },
      }
      return q
    },
  } as never
}

const T0 = Date.parse("2026-07-25T11:42:02.500Z")
const bubble = (seq: number, status: string, offsetMs: number): DocData => ({
  userId: "u-1",
  seq,
  paced: true,
  status,
  createdAt: new Date(T0 + offsetMs).toISOString(),
})

describe("outbox multi-bubble order gate", () => {
  it("a later-seq row does NOT overtake an earlier unsent one (waits until it lands)", async () => {
    const rows = new Map<string, DocData>([
      ["seq0", bubble(0, "sent", 0)],
      ["seq1", bubble(1, "sending", 1000)], // the late one, still in flight
      ["seq2", bubble(2, "sending", 2000)], // us
    ])
    const db = makeDb(rows)

    let clock = 0
    let polls = 0
    const res = await awaitEarlierBubblesSent(db, {
      docId: "seq2",
      userId: "u-1",
      seq: 2,
      createdAtMs: T0 + 2000,
      nowMs: () => clock,
      sleep: async (ms) => {
        clock += ms
        polls++
        // seq1's own invocation finishes on the third poll.
        if (polls === 3) rows.set("seq1", bubble(1, "sent", 1000))
      },
    })

    assert.equal(polls, 3, "kept waiting while seq=1 was still in flight")
    assert.equal(res.timedOut, false)
    assert.ok(res.waitedMs > 0, "actually waited instead of overtaking")
  })

  it("escape hatch: a permanently stuck predecessor releases the burst instead of wedging it", async () => {
    const rows = new Map<string, DocData>([
      ["seq0", bubble(0, "pending", 0)], // never moves — its invocation died
      ["seq1", bubble(1, "sending", 1000)], // us
    ])
    const db = makeDb(rows)

    let clock = 0
    const logged: string[] = []
    const res = await awaitEarlierBubblesSent(db, {
      docId: "seq1",
      userId: "u-1",
      seq: 1,
      createdAtMs: T0 + 1000,
      log: (event) => logged.push(String(event)),
      nowMs: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
    })

    assert.equal(res.timedOut, true, "gave up rather than blocking forever")
    assert.equal(res.blockedBy, "seq0")
    assert.ok(res.waitedMs >= 20_000, `bounded wait, got ${res.waitedMs}ms`)
    assert.ok(logged.includes("pa.outbox.seq_gate_timeout"), "logged the escape hatch")
  })

  it("returns immediately when nothing earlier is in flight (no added latency)", async () => {
    const db = makeDb(
      new Map<string, DocData>([
        ["seq0", bubble(0, "sent", 0)],
        ["seq1", bubble(1, "sending", 1000)],
      ])
    )
    let slept = 0
    const res = await awaitEarlierBubblesSent(db, {
      docId: "seq1",
      userId: "u-1",
      seq: 1,
      createdAtMs: T0 + 1000,
      nowMs: () => 0,
      sleep: async () => {
        slept++
      },
    })
    assert.equal(slept, 0)
    assert.equal(res.waitedMs, 0)
  })

  it("only in-flight earlier bubbles of the same burst block", () => {
    const self = { seq: 3, createdAtMs: T0 + 3000 }
    // blocks: earlier seq, still in flight
    assert.equal(isBlockingEarlierBubble(bubble(2, "sending", 2000), self), true)
    assert.equal(isBlockingEarlierBubble(bubble(0, "pending", 0), self), true)
    // never blocks: any terminal status (a dead predecessor cannot wedge the burst)
    for (const terminal of ["sent", "failed", "duplicate_skipped", "blocked_no_inbound", "dead_letter"]) {
      assert.equal(isBlockingEarlierBubble(bubble(1, terminal, 1000), self), false, terminal)
    }
    // never blocks: later/equal seq, unpaced rows (the single-bubble path), or a different burst
    assert.equal(isBlockingEarlierBubble(bubble(4, "sending", 4000), self), false)
    assert.equal(isBlockingEarlierBubble(bubble(3, "sending", 2500), self), false)
    assert.equal(
      isBlockingEarlierBubble({ ...bubble(1, "sending", 1000), paced: false }, self),
      false
    )
    assert.equal(isBlockingEarlierBubble(bubble(1, "sending", -5 * 60 * 1000), self), false)
  })
})
