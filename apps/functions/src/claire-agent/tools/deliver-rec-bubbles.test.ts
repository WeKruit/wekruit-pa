/**
 * deliver-rec-bubbles.test.ts — the rec DELIVERY-ORDER + inline-image contract (Adam 2026-06-04).
 *
 * Two live bugs this pins:
 *   1. ORDER: the offer (seq4) landed BEFORE the last job (seq3). deliverRecBubbles must POST in STRICT
 *      order — intro → each role (in order) → mandatory prescreen offer LAST — and emit-pace each send so
 *      the staggered createdAt timestamps give the concurrent outbox an unambiguous arrival order. Every
 *      row is tagged { seq, paced } and seq is strictly monotonic in send order.
 *   2. INLINE IMAGE: a COLLAB role's rec-card image rides WITH its caption bubble (sendText mediaUrl),
 *      not as a separate, decoupled, once/day media row. An open-market role row carries NO mediaUrl.
 *
 *   node --import tsx --test apps/functions/src/claire-agent/tools/deliver-rec-bubbles.test.ts
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { deliverRecBubbles } from "./matching-tools.js"
import type { FindMatchResult } from "../types.js"

type Rec = { text: string; seq?: number; paced?: boolean; mediaUrl?: string }

/** A recording transport that captures every sendText with its opts (the delivery ledger). */
function makeCtx() {
  const sends: Rec[] = []
  const ctx = {
    userId: "u1",
    log: () => {},
    transport: {
      async typing() {},
      async sendText(text: string, opts?: { seq?: number; paced?: boolean; mediaUrl?: string }) {
        sends.push({
          text,
          ...(opts?.seq !== undefined ? { seq: opts.seq } : {}),
          ...(opts?.paced ? { paced: true } : {}),
          ...(opts?.mediaUrl ? { mediaUrl: opts.mediaUrl } : {}),
        })
      },
    },
  } as unknown as Parameters<typeof deliverRecBubbles>[0]
  return { ctx, sends }
}

const COLLAB_LINE =
  'Senior Product Designer @ Invoko [WeKruit partner role]\nhttps://wekruit.com/j/invoko-pd\n' +
  'to start this screen, just reply "Senior Product Designer @ Invoko" — or copy & send me this line:\n' +
  "WeKruit_invoko-pd_u1_Job"
const OPEN_LINE = "Backend Engineer @ Acme\nhttps://acme.example.com/apply/9"
const MEDIA = "https://storage.googleapis.com/inbound-file-store/aBcd_wk-rec-invoko-pd.png"

test("deliverRecBubbles: STRICT order intro → roles (in order) → offer LAST; seq monotonic; all paced", async () => {
  const { ctx, sends } = makeCtx()
  // collab first, then open-market — the find_match merge order. Collab row carries the image inline.
  const res: FindMatchResult = {
    ok: true,
    recCount: 2,
    jobs: [COLLAB_LINE, OPEN_LINE],
    reason: null,
    collab: [{ jobId: "invoko-pd", title: "Senior Product Designer", company: "Invoko", prescreenReady: true }],
    deliverRows: [{ text: COLLAB_LINE, mediaUrl: MEDIA }, { text: OPEN_LINE }],
  }
  const out = await deliverRecBubbles(ctx, res)
  assert.equal(out.delivered, true)
  assert.equal(out.collabCount, 1)

  // 4 bubbles: intro, collab role, open role, offer.
  assert.equal(sends.length, 4)

  // (a) ORDER — intro first, the two role lines in their given order, the prescreen offer LAST.
  assert.match(sends[0]!.text, /found a few that fit right now/i, "intro is first")
  assert.equal(sends[1]!.text, COLLAB_LINE, "collab role bubble second (in order)")
  assert.equal(sends[2]!.text, OPEN_LINE, "open-market role bubble third (in order)")
  assert.match(sends[3]!.text, /prescreen/i, "the mandatory prescreen offer is LAST")
  // The offer must come strictly AFTER every role — never interleaved (the live job1,job2,OFFER,job3 bug).
  const offerIdx = sends.findIndex((s) => /prescreen/i.test(s.text))
  const lastRoleIdx = Math.max(sends.indexOf(sends[1]!), sends.indexOf(sends[2]!))
  assert.ok(offerIdx > lastRoleIdx, "offer index is after the last role index")

  // seq is present, strictly monotonic in send order, and every row is paced (outbox skips its own dwell).
  for (let i = 0; i < sends.length; i++) {
    assert.equal(sends[i]!.seq, i, `seq[${i}] === ${i}`)
    assert.equal(sends[i]!.paced, true, `bubble ${i} is paced`)
  }

  // (b) the COLLAB role row carries the image inline.
  assert.equal(sends[1]!.mediaUrl, MEDIA, "collab role bubble carries its rec-card image inline")
  // (c) the open-market role row has NO image.
  assert.equal(sends[2]!.mediaUrl, undefined, "open-market role bubble has no image")
  // intro + offer never carry an image.
  assert.equal(sends[0]!.mediaUrl, undefined)
  assert.equal(sends[3]!.mediaUrl, undefined)
})

test("deliverRecBubbles: no prescreen-ready collab → no offer bubble (intro + roles only)", async () => {
  const { ctx, sends } = makeCtx()
  const res: FindMatchResult = {
    ok: true,
    recCount: 1,
    jobs: [OPEN_LINE],
    reason: null,
    collab: [],
    deliverRows: [{ text: OPEN_LINE }],
  }
  const out = await deliverRecBubbles(ctx, res)
  assert.equal(out.delivered, true)
  assert.equal(out.collabCount, 0)
  assert.equal(sends.length, 2, "intro + one role, no offer")
  assert.match(sends[0]!.text, /found a few that fit right now/i)
  assert.equal(sends[1]!.text, OPEN_LINE)
  assert.equal(sends[1]!.mediaUrl, undefined)
})

test("deliverRecBubbles: falls back to jobs[] (text-only) when deliverRows absent", async () => {
  const { ctx, sends } = makeCtx()
  const res: FindMatchResult = {
    ok: true,
    recCount: 1,
    jobs: [OPEN_LINE],
    reason: null,
    collab: [],
  }
  const out = await deliverRecBubbles(ctx, res)
  assert.equal(out.delivered, true)
  assert.equal(sends.length, 2)
  assert.equal(sends[1]!.text, OPEN_LINE)
  assert.equal(sends[1]!.mediaUrl, undefined, "no image when there are no deliverRows")
})

test("deliverRecBubbles: empty rows → not delivered (agent narrates the no-match path)", async () => {
  const { ctx, sends } = makeCtx()
  const out = await deliverRecBubbles(ctx, { ok: true, recCount: 0, jobs: [], reason: "no fresh roles" })
  assert.equal(out.delivered, false)
  assert.equal(sends.length, 0)
})
