/**
 * anti-silence-fallback.test.ts — the ANTI-SILENCE FALLBACK seam (Adam 2026-06-04, "Hi → no response,
 * feels glitchy").
 *
 * Root cause: a DETERMINISTIC pattern turn (cold opener / "still pulling…" hold / post-parse pitch)
 * emits ≥1 bubble, but the cross-turn near-dup dedup in deliverBubbles drops EVERY one (the model
 * re-emitted something already sent this session). deliverBubbles then returned 0 and the turn was
 * marked HANDLED-but-SILENT → the candidate saw a read receipt and nothing.
 *
 * The fix (runClaireTurn): deliverBubblesEx now reports `suppressedAll`. When a turn is fully
 * suppressed AND nothing else went out, runClaireTurn RE-RUNS the agent ONCE on the plain user input
 * (every deterministic directive stripped, plain triage) so the model composes a fresh, non-duplicate
 * reply and delivers THAT. A loop guard (`isSuppressionFallback`) caps it at exactly one extra turn.
 *
 * These tests drive runClaireTurn with an injected `runAgent` stub (offline — the real SDK never runs)
 * and a Firestore stub whose `pa-messages` read seeds a recent-sent message for the cross-turn dedup:
 *   1. dedup suppresses turn-1's bubble → the AGENT FALLBACK fires EXACTLY ONCE and delivers a fresh reply.
 *   2. LOOP GUARD: when the fallback's OWN bubble is ALSO suppressed-all, there is NO third agent run
 *      (at most one extra turn, ever) — the turn ends silent, no infinite loop.
 *   3. a normal (non-suppressed) turn never invokes the fallback (exactly one agent run).
 *
 * Run: node --import tsx --test apps/functions/src/claire-agent/anti-silence-fallback.test.ts
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { runClaireTurn } from "./agent.js"
import type { RunClaireTurnDeps } from "./agent.js"

/**
 * Minimal Firestore stub. The ONLY read that matters for this seam is getRecentSentMessages'
 * `pa-messages` query (sessionId == X → assistant rows). `recentSent` seeds that list; every other
 * collection read (loadGlobalContext's pa-users / parsedCandidateResumes, etc.) resolves to
 * empty/missing so the turn degrades to the plainest possible path.
 */
function makeDb(opts: { recentSent?: string[] } = {}) {
  const recentRows = (opts.recentSent ?? []).map((body, i) => ({
    data: () => ({
      role: "assistant",
      body,
      createdAt: `2026-06-04T00:00:0${i}.000Z`,
    }),
  }))
  return {
    collection(name: string) {
      const chain = {
        doc() {
          return { async get() { return { exists: false, data: () => undefined } } }
        },
        where() {
          return chain
        },
        orderBy() {
          return chain
        },
        limit() {
          return {
            async get() {
              return { docs: name === "pa-messages" ? recentRows : [] }
            },
          }
        },
        async get() {
          return { docs: name === "pa-messages" ? recentRows : [] }
        },
      }
      return chain
    },
  } as never
}

/** Recording transport — captures the exact text bubbles that were POSTed. */
function makeTransport() {
  const sent: string[] = []
  const transport = {
    async markRead() {},
    async typing() {},
    async sendStatus() {},
    async sendText(t: string) {
      sent.push(t)
    },
    async tapback() {},
    async noReply() {},
  }
  return { transport: transport as never, sent }
}

/**
 * Queue of agent outputs, one per runClaireTurn agent run. Each entry is the `messages` array the
 * stubbed agent "returns". A counter records how many times the agent actually ran — the load-bearing
 * loop-guard assertion.
 */
function makeRunAgent(outputs: string[][]) {
  let calls = 0
  const runAgent: NonNullable<RunClaireTurnDeps["runAgent"]> = async () => {
    const messages = outputs[calls] ?? []
    calls++
    return { finalOutput: { messages }, rawResponses: [] }
  }
  return { runAgent, calls: () => calls }
}

test("suppressed-all deterministic pattern → agent fallback fires EXACTLY ONCE and delivers a fresh reply", async () => {
  const { transport, sent } = makeTransport()
  // The recent-sent row the dedup will match turn-1's bubble against (byte-identical after normalize).
  const dup = "still pulling your info, one sec"
  const fresh = "got it — what kind of roles are you after?"
  const { runAgent, calls } = makeRunAgent([
    [dup], // turn 1: the deterministic pattern re-emits the already-sent hold → suppressed-all
    [fresh], // fallback turn: a fresh, non-duplicate reply
  ])

  const res = await runClaireTurn(
    { userId: "u_fallback", sessionId: "s1", text: "hi", toE164: "+10000000000" },
    {
      db: makeDb({ recentSent: [dup] }),
      transport,
      runAgent,
      // a deterministic-pattern turn — exactly the class that goes silent when suppressed-all.
      enrichmentInFlight: true,
    },
  )

  // The agent ran TWICE: the original suppressed turn + ONE fallback. Never three.
  assert.equal(calls(), 2, `agent must run exactly twice (original + one fallback); got ${calls()}`)
  // The duplicate was correctly dropped (dedup stays) and the FRESH fallback reply went out.
  assert.deepEqual(sent, [fresh], `only the fresh fallback reply should be delivered; got ${JSON.stringify(sent)}`)
  assert.equal(res.finalText, fresh, "the returned finalText is the fallback reply")
})

test("LOOP GUARD: fallback's OWN bubble also suppressed-all → NO third agent run (at most one extra turn)", async () => {
  const { transport, sent } = makeTransport()
  const dup = "still pulling your info, one sec"
  const { runAgent, calls } = makeRunAgent([
    [dup], // turn 1: suppressed-all → fallback
    [dup], // fallback turn: re-emits the SAME dup → ALSO suppressed-all → must NOT fall back again
    ["this third reply must NEVER be produced"], // guard: if reached, the cap is broken
  ])

  await runClaireTurn(
    { userId: "u_loopguard", sessionId: "s2", text: "hi", toE164: "+10000000000" },
    {
      db: makeDb({ recentSent: [dup] }),
      transport,
      runAgent,
      enrichmentInFlight: true,
    },
  )

  // EXACTLY two agent runs — the original + one fallback. There is no second fallback, so the hard cap
  // holds and the loop can never recur. This run-count is THE loop-guard invariant.
  assert.equal(calls(), 2, `loop guard: agent must run at most twice; got ${calls()}`)
  // The fallback turn GUARANTEES a reply: it runs with skipCrossTurnDedup, so even a bubble similar to
  // history is delivered (the whole point — never go silent). Here the stub re-emits the dup, so that one
  // bubble lands. The loop guard is the run-count above, not silence. (Real agent → fresh contextual text.)
  assert.deepEqual(sent, [dup], `fallback bypasses cross-turn dedup → its reply is delivered; got ${JSON.stringify(sent)}`)
})

test("normal (non-suppressed) turn never invokes the fallback — exactly one agent run", async () => {
  const { transport, sent } = makeTransport()
  const reply = "happy to help — tell me what you're looking for!"
  const { runAgent, calls } = makeRunAgent([[reply], ["should not run"]])

  await runClaireTurn(
    { userId: "u_normal", sessionId: "s3", text: "hey", toE164: "+10000000000" },
    {
      db: makeDb({ recentSent: ["a totally unrelated earlier message about something else entirely"] }),
      transport,
      runAgent,
    },
  )

  assert.equal(calls(), 1, `a delivered turn must not trigger the fallback; agent ran ${calls()} times`)
  assert.deepEqual(sent, [reply], "the normal reply is delivered as-is")
})
