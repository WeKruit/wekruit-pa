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
import { buildMatchingTools, deliverRecBubbles } from "./matching-tools.js"
import { claireToolUseBehavior } from "../agent.js"
import type { ClaireToolContext, FindMatchResult } from "../types.js"

type SentRow = { text: string; seq?: number; paced?: boolean }

/**
 * A Firestore stub shaped EXACTLY for getRecentSentMessages' query:
 *   db.collection(PA_MESSAGES).where("sessionId","==",x).limit(200).get() → { docs:[{data()}] }
 * Each prior message is returned as an `assistant` row sourced from the real outbox
 * (`rawMeta.source === "pa-outbound"`) so it counts as "what Claire actually SENT". Used to drive the
 * re-pull silence guard: when the matcher returns roles byte-identical to these, the guard fires.
 */
function recentSentDbStub(priorBodies: string[], sessionId = "s1", userId = "u1"): unknown {
  const docs = priorBodies.map((body, i) => ({
    data: () => ({
      role: "assistant",
      sessionId,
      userId,
      body,
      createdAt: `2026-06-09T00:0${i}:00.000Z`,
      rawMeta: { source: "pa-outbound" },
    }),
  }))
  return {
    collection: () => ({
      where: () => ({
        limit: () => ({ get: async () => ({ docs }) }),
      }),
    }),
  }
}

function recordingCtx(findMatch: ClaireToolContext["findMatch"]): {
  ctx: ClaireToolContext
  sent: string[]
  rows: SentRow[]
} {
  const sent: string[] = []
  const rows: SentRow[] = []
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
  } as unknown as ClaireToolContext
  return { ctx, sent, rows }
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

// ── RE-PULL SILENCE GUARD (Shivam incident, 2026-06-09) ───────────────────────────────────────────
// Live bug: candidate said "Yeah" (= check my statuses) → agent re-ran find_match → matcher returned
// the SAME roles already sent → deliverRecBubbles posted byte-identical role bubbles → the outbox
// dropped EVERY one as `duplicate_skipped` (downstream, invisible to the agent) → ZERO message → total
// silence. The fix: when EVERY deliverable role bubble is a recent near-dup, do NOT re-post the identical
// batch; send ONE guaranteed-fresh status-aware line so the candidate ALWAYS hears back.

test("re-pull: ALL roles are recent duplicates → no role bubbles re-posted, ONE fresh line sent, delivered:true", async () => {
  // The candidate already received these exact two role lines this session (prior outbox rows).
  const res: FindMatchResult = {
    ok: true,
    recCount: 2,
    jobs: [COLLAB_LINE_1, OPEN_LINE],
    reason: null,
    collab: [{ jobId: "metavoice", title: "Software Engineer (Data & Evals)", company: "MetaVoice", prescreenReady: true }],
  }
  const { ctx, sent } = recordingCtx(async () => res)
  ;(ctx as { db: unknown }).db = recentSentDbStub([COLLAB_LINE_1, OPEN_LINE])
  const out = await deliverRecBubbles(ctx, res)

  // NOT the normal batch — no intro, no per-role bubble, no offer. Exactly ONE fresh line.
  assert.equal(sent.length, 1, "exactly one fresh status-aware line is sent on a pure re-pull")
  assert.ok(!sent.some((s) => s === COLLAB_LINE_1 || s === OPEN_LINE), "no identical role bubble re-posted")
  assert.ok(!sent.some((s) => /found a few that fit/i.test(s)), "no intro bubble re-posted")
  // The fresh line acknowledges the same-set reality and offers a real next step (status / widen).
  assert.match(sent[0]!, /same|already|nothing (newer|fresh)|status|screen|wider|broaden|widen/i)
  // delivered:true ⇒ the agent stays silent (no duplicate narration) — the fresh line is on the wire.
  assert.equal(out.delivered, true)
  assert.equal(out.collabCount, 0)
})

test("re-pull: SOME role is new → normal delivery (guard does NOT fire)", async () => {
  // Only COLLAB_LINE_1 was sent before; COLLAB_LINE_2 is brand new → deliver normally.
  const res: FindMatchResult = {
    ok: true,
    recCount: 2,
    jobs: [COLLAB_LINE_1, COLLAB_LINE_2],
    reason: null,
    collab: [
      { jobId: "metavoice", title: "Software Engineer (Data & Evals)", company: "MetaVoice", prescreenReady: true },
      { jobId: "helium", title: "Product Engineer (Full-Stack)", company: "Helium", prescreenReady: true },
    ],
  }
  const { ctx, sent } = recordingCtx(async () => res)
  ;(ctx as { db: unknown }).db = recentSentDbStub([COLLAB_LINE_1])
  const out = await deliverRecBubbles(ctx, res)

  // Full normal batch: intro + 2 roles + offer = 4 bubbles (both roles delivered verbatim).
  assert.equal(out.delivered, true)
  assert.ok(sent.some((s) => s === COLLAB_LINE_1), "the seen role is still delivered as part of the fresh batch")
  assert.ok(sent.some((s) => s === COLLAB_LINE_2), "the new role is delivered")
  assert.ok(sent.some((s) => /found a few that fit/i.test(s)), "intro present (normal path)")
})

test("re-pull: NO prior sends (empty recent) → normal delivery (fail-open / first send)", async () => {
  const res: FindMatchResult = { ok: true, recCount: 1, jobs: [OPEN_LINE], reason: null, collab: [] }
  const { ctx, sent } = recordingCtx(async () => res)
  ;(ctx as { db: unknown }).db = recentSentDbStub([])
  const out = await deliverRecBubbles(ctx, res)
  assert.equal(out.delivered, true)
  assert.equal(sent.length, 2) // intro + 1 role, normal path
  assert.ok(sent.some((s) => s === OPEN_LINE))
})

test("re-pull guard NEVER ends a real-text turn silent: a pure re-pull always puts ≥1 message on the wire", async () => {
  // The invariant: even when every role is a duplicate, the candidate is NOT left silent.
  const res: FindMatchResult = { ok: true, recCount: 1, jobs: [OPEN_LINE], reason: null, collab: [] }
  const { ctx, sent } = recordingCtx(async () => res)
  ;(ctx as { db: unknown }).db = recentSentDbStub([OPEN_LINE])
  await deliverRecBubbles(ctx, res)
  assert.ok(sent.length >= 1, "a turn with real user text NEVER ends with zero messages sent")
})

// ── REC-HALLUCINATION: SDK-NATIVE TURN FINALIZATION (Adam 2026-06-06) ─────────────────────────────
// Live bug: after find_match delivered the real recs, the agent ran a generation step and talked OVER
// them — emitting generic `Senior Software Engineer @ [company] — … (US)` cards (no company data to
// fill the placeholder) plus a fabricated `WeKruit fast-track prescreen offer: <résumé company>
// (Software Engineering)` block built from the candidate's OWN experience. The fix is the @openai/
// agents `toolUseBehavior` ToolToFinalOutputFunction: on a find_match result with delivered:true it
// returns isFinalOutput:true → the SDK STOPS the agent loop WITHOUT running the LLM again (no
// generation step = no hallucination). On delivered:false it returns isFinalOutput:false → the LLM
// runs again and narrates the no-match clarifier. The finalOutput string is the agent's own
// ClaireReplySchema shape ({messages:[]}) so processFinalOutput parses it to zero bubbles.
test("toolUseBehavior: find_match delivered:true → isFinalOutput:true with empty-messages output (no LLM re-run)", () => {
  const outcome = claireToolUseBehavior({}, [
    { type: "function_output", tool: { name: "find_match" }, output: { ok: true, delivered: true, jobs: [] } },
  ])
  assert.equal(outcome.isFinalOutput, true)
  assert.equal(
    (outcome as { finalOutput: string }).finalOutput,
    JSON.stringify({ messages: [] }),
    "must finalize with the agent's terminal output ({messages:[]}) so no bubbles are composed",
  )
})

test("toolUseBehavior: find_match delivered:true passed as a JSON STRING output is still finalized", () => {
  const outcome = claireToolUseBehavior({}, [
    { type: "function_output", tool: { name: "find_match" }, output: JSON.stringify({ delivered: true }) },
  ])
  assert.equal(outcome.isFinalOutput, true)
})

test("toolUseBehavior: find_match delivered:false (no match) → NOT final → LLM runs again to narrate", () => {
  const outcome = claireToolUseBehavior({}, [
    { type: "function_output", tool: { name: "find_match" }, output: { ok: true, delivered: false, jobs: [] } },
  ])
  assert.equal(outcome.isFinalOutput, false)
})

test("toolUseBehavior: a non-find_match tool result never finalizes (agent keeps composing)", () => {
  const outcome = claireToolUseBehavior({}, [
    { type: "function_output", tool: { name: "set_matching_preferences" }, output: { ok: true } },
  ])
  assert.equal(outcome.isFinalOutput, false)
})

test("toolUseBehavior: no tool results this turn → NOT final", () => {
  assert.equal(claireToolUseBehavior({}, []).isFinalOutput, false)
})

// ─── YC EVENT HOLD ───

function ycUserDbStub(userDoc: Record<string, unknown>): unknown {
  return {
    collection: (name: string) => ({
      doc: () => ({ get: async () => ({ exists: true, data: () => userDoc }) }),
      where: () => ({ limit: () => ({ get: async () => ({ docs: [] }) }) }),
      _name: name,
    }),
  }
}

test("YC event entrant BEFORE the operator send: find_match holds (no matcher call, no timestamp reason)", async () => {
  let matcherCalled = false
  const { ctx, sent } = recordingCtx(async () => {
    matcherCalled = true
    return { ok: true, recCount: 1, jobs: [OPEN_LINE], reason: null }
  })
  ;(ctx as { db: unknown }).db = ycUserDbStub({ firstTouchCampaign: "yc-startup-school", source: "yc_startup_school" })
  const out = await run(ctx)
  assert.equal(out.ok, false)
  assert.match(String(out.reason), /once there is a good match/i)
  assert.doesNotMatch(String(out.reason), /7pm|July 25|tonight/i)
  assert.equal(matcherCalled, false, "matcher must NOT run before the operator send")
  assert.equal(sent.length, 0, "no role bubbles delivered")
})

test("YC entrant STAYS held even AFTER the operator send (unconditional — YC people matching, never jobs)", async () => {
  let matcherCalled = false
  const { ctx, sent } = recordingCtx(async () => {
    matcherCalled = true
    return { ok: true, recCount: 1, jobs: [OPEN_LINE], reason: null }
  })
  ;(ctx as { db: unknown }).db = ycUserDbStub({
    source: "yc_startup_school",
    ycEveningMatchSentAt: "2026-07-23T02:00:00.000Z",
  })
  const out = await run(ctx)
  assert.equal(out.ok, false)
  assert.equal(matcherCalled, false, "ycEveningMatchSentAt no longer lifts the hold — YC never job-matches")
  assert.equal(sent.length, 0, "no job roles delivered post-send either")
})

test("existing-user event entrant (ycEventEntryAt, sticky source) is ALSO held pre-send", async () => {
  let matcherCalled = false
  const { ctx } = recordingCtx(async () => {
    matcherCalled = true
    return { ok: true, recCount: 0, jobs: [], reason: null }
  })
  ;(ctx as { db: unknown }).db = ycUserDbStub({ source: "candidate", ycEventEntryAt: "2026-07-23T01:00:00.000Z" })
  const out = await run(ctx)
  assert.equal(out.ok, false)
  assert.equal(matcherCalled, false)
})

test("website /yc-startup user (source==yc, no event flag) is ALSO held — YC never job-matches (Adam 2026-07-23)", async () => {
  let matcherCalled = false
  const { ctx, sent } = recordingCtx(async () => {
    matcherCalled = true
    return { ok: true, recCount: 1, jobs: [OPEN_LINE], reason: null }
  })
  ;(ctx as { db: unknown }).db = ycUserDbStub({ source: "yc_startup_school" })
  const out = await run(ctx)
  assert.equal(out.ok, false)
  assert.match(String(out.reason), /once there is a good match|people/i)
  assert.doesNotMatch(String(out.reason), /7pm|July 25|tonight/i)
  assert.equal(matcherCalled, false, "source==yc must NOT run the job matcher — investors sign up too")
  assert.equal(sent.length, 0, "no job roles delivered to a yc user")
})
