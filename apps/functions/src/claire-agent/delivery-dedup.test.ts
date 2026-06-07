/**
 * delivery-dedup.test.ts — BUG A guard (Adam 2026-06-04): gpt-5.4-nano sometimes emits the SAME bubble
 * twice (the live "still pulling your info—give me a sec" sent-twice). deliverBubbles must drop exact
 * duplicates so a turn never POSTs a byte-identical bubble more than once.
 *   node --import tsx --test apps/functions/src/claire-agent/delivery-dedup.test.ts
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { deliverBubbles } from "./delivery.js"

function makeCtx() {
  const sent: string[] = []
  const ctx = {
    transport: {
      async sendText(v: string) { sent.push(v) },
      async typing() {},
    },
    log: () => {},
  } as unknown as Parameters<typeof deliverBubbles>[0]
  return { ctx, sent }
}

test("deliverBubbles drops an exact-duplicate bubble (the dup-ack bug)", async () => {
  const { ctx, sent } = makeCtx()
  const n = await deliverBubbles(ctx, ["still pulling your info, one sec 🔎", "still pulling your info, one sec 🔎"])
  assert.equal(n, 1)
  assert.deepEqual(sent, ["still pulling your info, one sec 🔎"])
})

test("deliverBubbles keeps DISTINCT bubbles in order", async () => {
  const { ctx, sent } = makeCtx()
  const n = await deliverBubbles(ctx, ["one", "two", "three"])
  assert.equal(n, 3)
  assert.deepEqual(sent, ["one", "two", "three"])
})

test("deliverBubbles drops a non-adjacent duplicate too (keep first)", async () => {
  const { ctx, sent } = makeCtx()
  const n = await deliverBubbles(ctx, ["a", "b", "a"])
  assert.equal(n, 2)
  assert.deepEqual(sent, ["a", "b"])
})
