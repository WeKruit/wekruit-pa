/**
 * find-match-delivery.test.ts — DETERMINISTIC rec delivery (Adam 2026-06-01).
 *
 * The LLM repeatedly (3×) dropped the WeKruit collab start tokens, skipped the mandatory prescreen
 * offer, and crammed multiple roles into one bubble. So the find_match TOOL now SENDS the roles + the
 * offer itself (via the transport), one role per bubble, and the agent stays silent (delivered:true →
 * empty messages). These guards lock that in: any match with a prescreen-ready collab role MUST emit a
 * prescreen offer bubble, every role is its own bubble, and the tool returns jobs:[] so the agent can't
 * re-list. Pure/offline — a recording transport + a stubbed ctx.findMatch. No SDK/LLM/network.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { buildMatchingTools } from "./matching-tools.js"
import type { ClaireToolContext, FindMatchResult } from "../types.js"

type SentRow = { text: string; seq?: number; paced?: boolean }

function recordingCtx(findMatch: ClaireToolContext["findMatch"]): {
  ctx: ClaireToolContext
  sent: string[]
  rows: SentRow[]
  marks: () => number
} {
  const sent: string[] = []
  const rows: SentRow[] = []
  let markCount = 0
  const ctx = {
    db: {} as never,
    userId: "u1",
    sessionId: "s1",
    lang: "en",
    transport: {
      markRead: async () => {},
      typing: async () => {},
      sendStatus: async () => {},
      // Capture the opts (seq + paced) so we can assert the DELIVERED order, not just the call order.
      // The live outbox drains by `seq`; unpaced rows are re-dwelled by body length and can reorder.
      sendText: async (t: string, opts?: { seq?: number; paced?: boolean }) => {
        sent.push(t)
        rows.push({ text: t, seq: opts?.seq, paced: opts?.paced })
      },
      tapback: async () => {},
      noReply: async () => {},
    },
    judgeModel: "gpt-4.1-mini",
    log: () => {},
    nowIso: () => "2026-06-01T00:00:00.000Z",
    findMatch,
    // mirror runClaireTurn: the tool flags the turn handled so the post-run deliverBubblesEx drops
    // the agent's own messages[] (the rec-hallucination suppression).
    markDeliveredViaTool: () => {
      markCount++
    },
  } as unknown as ClaireToolContext
  return { ctx, sent, rows, marks: () => markCount }
}

function findMatchTool(ctx: ClaireToolContext) {
  const t = buildMatchingTools(ctx).find((x) => (x as { name?: string }).name === "find_match")
  assert.ok(t, "find_match tool must be registered")
  return t as { invoke: (a: never, raw: string) => Promise<unknown> }
}
async function run(ctx: ClaireToolContext, args: unknown = { requestedCount: 5 }) {
  const raw = await findMatchTool(ctx).invoke({} as never, JSON.stringify(args))
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown>
}

const COLLAB_LINE_1 =
  'Software Engineer (Data & Evals) @ MetaVoice [WeKruit partner role]\nhttps://wekruit.com/j/abc\nto start this screen, just reply "Software Engineer (Data & Evals) @ MetaVoice" — or copy & send me this line:\nWeKruit_metavoice_u1_Job'
const COLLAB_LINE_2 =
  'Product Engineer (Full-Stack) @ Helium [WeKruit partner role]\nhttps://wekruit.com/j/def\nto start this screen, just reply "Product Engineer (Full-Stack) @ Helium" — or copy & send me this line:\nWeKruit_helium_u1_Job'
const OPEN_LINE = "Software Engineer, Production Engineering @ ramp\nhttps://jobs.ashbyhq.com/ramp/xyz"

test("collab batch: tool sends intro + one bubble per role + a MANDATORY offer; returns delivered:true, jobs:[]", async () => {
  const res: FindMatchResult = {
    ok: true,
    recCount: 3,
    jobs: [COLLAB_LINE_1, COLLAB_LINE_2, OPEN_LINE],
    reason: null,
    collab: [
      { jobId: "metavoice", title: "Software Engineer (Data & Evals)", company: "MetaVoice", prescreenReady: true },
      { jobId: "helium", title: "Product Engineer (Full-Stack)", company: "Helium", prescreenReady: true },
    ],
  }
  const { ctx, sent, rows } = recordingCtx(async () => res)
  const out = await run(ctx)

  // delivered → agent must stay silent
  assert.equal(out.delivered, true)
  assert.equal(out.collabCount, 2)
  assert.deepEqual(out.jobs, []) // nothing for the agent to re-list

  // intro + 3 role bubbles + 1 offer = 5 bubbles, each role on its OWN bubble
  assert.equal(sent.length, 5)
  assert.match(sent[0]!, /found a few that fit/i)
  assert.equal(sent[1], COLLAB_LINE_1) // verbatim — token preserved
  assert.equal(sent[2], COLLAB_LINE_2)
  assert.equal(sent[3], OPEN_LINE)
  // the MANDATORY offer names BOTH collab roles + companies and is its OWN bubble
  const offer = sent[4]!
  assert.match(offer, /prescreen/i)
  assert.match(offer, /MetaVoice/)
  assert.match(offer, /Helium/)

  // STRICT ORDER (Adam 2026-06-04): ALL job role bubbles FIRST, the prescreen offer LAST — never
  // interleaved (the live bug was job1, job2, OFFER, job3). Guard the delivered order three ways so
  // a future refactor can't reintroduce the interleave:
  //  (a) the offer is the LAST row, and EVERY job line lands strictly before it.
  const offerIdx = rows.findIndex((r) => /prescreen/i.test(r.text))
  assert.equal(offerIdx, rows.length - 1, "prescreen offer must be the LAST bubble")
  for (const jobLine of [COLLAB_LINE_1, COLLAB_LINE_2, OPEN_LINE]) {
    const jobIdx = rows.findIndex((r) => r.text === jobLine)
    assert.ok(jobIdx > -1 && jobIdx < offerIdx, `job bubble must land before the offer: ${jobLine.slice(0, 24)}`)
  }
  //  (b) seq is strictly monotonic 0..N — the outbox drains by seq, so this IS the delivered order.
  rows.forEach((r, i) => assert.equal(r.seq, i, `row ${i} must carry seq ${i}`))
  //  (c) EVERY row is paced:true — the fix. Unpaced rows get a per-row length-based typing-dwell in
  //      the outbox (dwell scales with body length), which let a short offer race ahead of a longer
  //      job bubble. paced:true => the outbox posts in strict seq order with no reorder.
  assert.ok(rows.every((r) => r.paced === true), "every rec bubble must be paced so seq order is honored")
})

test("no collab in batch: roles delivered, NO offer bubble", async () => {
  const res: FindMatchResult = { ok: true, recCount: 1, jobs: [OPEN_LINE], reason: null, collab: [] }
  const { ctx, sent } = recordingCtx(async () => res)
  const out = await run(ctx)
  assert.equal(out.delivered, true)
  assert.equal(out.collabCount, 0)
  assert.equal(sent.length, 2) // intro + 1 role, no offer
  assert.ok(!sent.some((s) => /prescreen/i.test(s)), "no prescreen offer when no collab")
})

test("collab present but NOT prescreen-ready: no offer (can't start a screen with no config)", async () => {
  const res: FindMatchResult = {
    ok: true,
    recCount: 1,
    jobs: ["Designer @ Invoko [WeKruit partner role]\nhttps://wekruit.com/j/ghi"],
    reason: null,
    collab: [{ jobId: "invoko", title: "Designer", company: "Invoko", prescreenReady: false }],
  }
  const { ctx, sent } = recordingCtx(async () => res)
  const out = await run(ctx)
  assert.equal(out.delivered, true)
  assert.equal(out.collabCount, 0)
  assert.ok(!sent.some((s) => /prescreen/i.test(s)), "no offer when collab role isn't prescreen-ready")
})

test("no match: nothing sent, delivered:false → agent narrates (jobs passed through)", async () => {
  const res: FindMatchResult = { ok: true, recCount: 0, jobs: [], reason: "no fresh roles fit", collab: [] }
  const { ctx, sent } = recordingCtx(async () => res)
  const out = await run(ctx)
  assert.equal(out.delivered, false)
  assert.equal(sent.length, 0)
  assert.equal(out.reason, "no fresh roles fit")
})

test("matcher error (ok:false): nothing sent, delivered:false", async () => {
  const res: FindMatchResult = { ok: false, recCount: 0, jobs: [], reason: "matcher error: boom" }
  const { ctx, sent } = recordingCtx(async () => res)
  const out = await run(ctx)
  assert.equal(out.ok, false)
  assert.equal(out.delivered, false)
  assert.equal(sent.length, 0)
})

// ── REC-HALLUCINATION SUPPRESSION (Adam 2026-06-06) ──────────────────────────────────────────────
// Live bug: after find_match delivered the real recs, the agent talked OVER them — emitting generic
// `Senior Software Engineer @ [company] — … (US)` cards (no company data to fill) plus a fabricated
// `WeKruit fast-track prescreen offer: <résumé company> (Software Engineering)` block built from the
// candidate's OWN experience. Those bubbles were the agent's final messages[], which deliverBubblesEx
// sends UNLESS the turn is marked handled-via-tool. So on delivered:true the tool MUST call
// markDeliveredViaTool; on delivered:false (no-match/error) it must NOT (the agent legitimately speaks).
test("delivered:true → tool marks the turn handled (so post-run drops the agent's hallucinated bubbles)", async () => {
  const res: FindMatchResult = {
    ok: true,
    recCount: 2,
    jobs: [COLLAB_LINE_1, OPEN_LINE],
    reason: null,
    collab: [
      { jobId: "metavoice", title: "Software Engineer (Data & Evals)", company: "MetaVoice", prescreenReady: true },
    ],
  }
  const { ctx, marks } = recordingCtx(async () => res)
  const out = await run(ctx)
  assert.equal(out.delivered, true)
  assert.equal(marks(), 1, "delivered:true MUST mark the turn handled-via-tool exactly once")
})

test("delivered:false (no match) → tool does NOT mark handled (agent must still narrate)", async () => {
  const res: FindMatchResult = { ok: true, recCount: 0, jobs: [], reason: "no fresh roles fit", collab: [] }
  const { ctx, marks } = recordingCtx(async () => res)
  const out = await run(ctx)
  assert.equal(out.delivered, false)
  assert.equal(marks(), 0, "no-match must NOT suppress the agent — it speaks the clarifier")
})
