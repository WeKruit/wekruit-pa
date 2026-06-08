/**
 * dedup.test.ts — Adam R1 (2026-06-04): ABSOLUTE no duplicate message, INCLUDING SIMILAR.
 *
 * Covers the pure util (dedup.ts) AND the cross-turn integration in deliverBubbles (delivery.ts):
 *   - normalizeForComparison: lowercase / strip emoji / strip punctuation / collapse whitespace
 *   - isNearDuplicate: exact-normalized equality, emoji/punctuation variants, Jaccard near-rewrite,
 *     short-message guard (distinct short acks survive)
 *   - getRecentSentMessages: reads assistant rows for the session, fail-open on error/missing ctx
 *   - deliverBubbles: within-turn near-dup drop + cross-turn near-dup drop, fail-open
 *
 *   node --import tsx --test apps/functions/src/claire-agent/dedup.test.ts
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  normalizeForComparison,
  isNearDuplicate,
  isNearDuplicateOfAny,
  tokenJaccard,
  tokenContainment,
} from "./dedup.js"
import { deliverBubbles, getRecentSentMessages } from "./delivery.js"

// ───────────────────────────── normalizeForComparison ─────────────────────────────

test("normalizeForComparison lowercases", () => {
  assert.equal(normalizeForComparison("Still PULLING your info"), "still pulling your info")
})

test("normalizeForComparison strips emoji (incl. variation selectors)", () => {
  assert.equal(normalizeForComparison("still pulling your info 🔍"), "still pulling your info")
  assert.equal(normalizeForComparison("one sec 🔎"), "one sec")
})

test("normalizeForComparison strips punctuation and em/en dashes", () => {
  assert.equal(normalizeForComparison("still pulling—give me a sec"), "still pulling give me a sec")
  assert.equal(normalizeForComparison("still pulling your info, one sec."), "still pulling your info one sec")
})

test("normalizeForComparison collapses whitespace runs", () => {
  assert.equal(normalizeForComparison("still    pulling  your   info"), "still pulling your info")
})

test("normalizeForComparison is empty-safe", () => {
  assert.equal(normalizeForComparison(""), "")
  assert.equal(normalizeForComparison("   "), "")
  // @ts-expect-error — defensive: util must not throw on non-string
  assert.equal(normalizeForComparison(undefined), "")
})

// ───────────────────────────── isNearDuplicate ─────────────────────────────

test("isNearDuplicate: exact byte-identical → true", () => {
  assert.equal(
    isNearDuplicate("still pulling your info, one sec 🔎", "still pulling your info, one sec 🔎"),
    true,
  )
})

test("isNearDuplicate: THE live bug — same body, different emoji → true", () => {
  // The two "still pulling" lines Adam called out: identical words, different trailing emoji.
  const a = "still pulling your info, one sec 🔎"
  const b = "still pulling your info, one sec 🔍"
  assert.equal(isNearDuplicate(a, b), true)
})

test("isNearDuplicate: different-length reword is NOT string-matched (containment removed to avoid false positives)", () => {
  // Adam's named pair ("still pulling your info, one sec" vs "…—give me a sec") has Jaccard only 0.56.
  // A containment+prefix branch WOULD catch it, but it is INDISTINGUISHABLE from genuinely-distinct asks
  // that share an opener and differ in the payload token ("share your linkedin" vs "share your resume").
  // So string-similarity deliberately returns FALSE here; the recurring "still pulling" hold is instead
  // PINNED to a fixed phrase in prompt.ts → its repeats are byte-identical → caught by exact-equality.
  const a = "still pulling your info, one sec 🔎"
  const b = "still pulling your info—give me a sec 🔍"
  assert.equal(isNearDuplicate(a, b), false)
})

test("isNearDuplicate: NO false positive — distinct asks sharing an opener but differing in payload token", () => {
  // The exact pair the review flagged: these differ only in the LAST word, which is the whole point.
  assert.equal(isNearDuplicate("can you share your linkedin", "can you share your resume"), false)
  assert.equal(isNearDuplicate("want me to pull product roles", "want me to pull design roles"), false)
  assert.equal(isNearDuplicate("do you want remote roles", "do you want onsite roles"), false)
})

test("isNearDuplicate: punctuation/dash variant of same words → true", () => {
  // "still pulling your info one sec" vs "still pulling your info one sec" after norm (comma vs dash).
  const a = "still pulling your info, one sec"
  const b = "still pulling your info — one sec"
  assert.equal(isNearDuplicate(a, b), true)
})

test("isNearDuplicate: case-only variant → true", () => {
  assert.equal(isNearDuplicate("Give Me A Sec While I Look", "give me a sec while i look"), true)
})

test("isNearDuplicate: exact-after-normalization (punctuation/emoji stripped) → true; one-word reword → false", () => {
  // Trailing punctuation/emoji normalizes away → exact normalized match → dup.
  assert.equal(isNearDuplicate("i am still pulling all of your info", "i am still pulling all of your info."), true)
  // A one-word reword (Jaccard 0.78 < 0.85) is NOT matched — same safety as the payload-token case above.
  assert.equal(isNearDuplicate("pulling your info give me a quick sec", "pulling your info give me a quick second"), false)
})

test("isNearDuplicate: genuinely different long messages → false", () => {
  const a = "i can pull some roles that fit you right now if you want"
  const b = "share a few words or a voice note so i match you better"
  assert.equal(isNearDuplicate(a, b), false)
})

test("isNearDuplicate: short distinct acks NOT dropped (require exact match under 4 tokens)", () => {
  assert.equal(isNearDuplicate("ok", "okay"), false)
  assert.equal(isNearDuplicate("yes", "yeah"), false)
  assert.equal(isNearDuplicate("got it", "on it"), false)
  // but identical short ack after normalization IS a dup
  assert.equal(isNearDuplicate("ok!", "ok"), true)
  assert.equal(isNearDuplicate("Got it.", "got it"), true)
})

test("isNearDuplicate: empty/blank never matches", () => {
  assert.equal(isNearDuplicate("", "anything here at all"), false)
  assert.equal(isNearDuplicate("   ", "   "), false)
})

test("tokenJaccard sanity", () => {
  assert.equal(tokenJaccard("a b c d", "a b c d"), 1)
  assert.equal(tokenJaccard("a b c d", "e f g h"), 0)
  // {a,b,c,d} vs {a,b,c,e}: inter 3, union 5 → 0.6
  assert.equal(Math.round(tokenJaccard("a b c d", "a b c e") * 100) / 100, 0.6)
})

test("tokenContainment sanity", () => {
  // {a,b,c} ⊂ {a,b,c,d,e}: inter 3 / min(3,5)=3 → 1.0
  assert.equal(tokenContainment("a b c", "a b c d e"), 1)
  // disjoint → 0
  assert.equal(tokenContainment("a b c", "x y z"), 0)
})

test("containment without a shared opener does NOT flag (prefix gate protects distinct msgs)", () => {
  // Same word SET membership but different order / no shared 3-word prefix → not a near-dup.
  // a: "voice note or résumé share more please" / b: "please share more voice note or résumé"
  // High containment, but the shared prefix is 0 tokens, so the containment branch stays OFF;
  // Jaccard is also < 0.8 only if sets differ — here sets are equal so Jaccard = 1.0 catches it.
  // Use genuinely distinct messages that merely reuse common words but share no opener:
  const a = "you should pull roles for me right now today"
  const b = "right now today pull roles you should not"
  // No shared leading prefix → containment branch off. Jaccard < 0.8 (extra "not" / order). Expect false.
  assert.equal(isNearDuplicate(a, b), false)
})

test("isNearDuplicateOfAny matches against a list", () => {
  const priors = ["totally different message here", "one sec while i pull your info 🔎"]
  assert.equal(isNearDuplicateOfAny("one sec while i pull your info 🔍", priors), true)
  assert.equal(isNearDuplicateOfAny("brand new thing to say entirely", priors), false)
})

// ───────────────────────────── getRecentSentMessages (fail-open + filtering) ─────────────────────

type Row = Record<string, unknown>

function makeDbWithRows(rows: Row[], opts: { throwOnGet?: boolean } = {}) {
  return {
    collection(_name: string) {
      return {
        where(field: string, _op: string, value: unknown) {
          const filtered = rows.filter((r) => r[field] === value)
          return {
            limit(_n: number) {
              return {
                async get() {
                  if (opts.throwOnGet) throw new Error("firestore boom")
                  return { docs: filtered.map((r) => ({ data: () => r })) }
                },
              }
            },
          }
        },
      }
    },
  }
}

test("getRecentSentMessages returns assistant rows for the session, chronological, last N", async () => {
  const db = makeDbWithRows([
    { sessionId: "s1", userId: "u1", role: "assistant", body: "a1", createdAt: "2026-06-04T00:00:01Z" },
    { sessionId: "s1", userId: "u1", role: "user", body: "u-msg", createdAt: "2026-06-04T00:00:02Z" },
    { sessionId: "s1", userId: "u1", role: "assistant", body: "a2", createdAt: "2026-06-04T00:00:03Z" },
    { sessionId: "s2", userId: "u1", role: "assistant", body: "other-session", createdAt: "2026-06-04T00:00:04Z" },
  ])
  const msgs = await getRecentSentMessages({ db: db as never, userId: "u1", sessionId: "s1" }, 5)
  assert.deepEqual(msgs, ["a1", "a2"]) // only s1 + assistant, in createdAt order, user/other-session excluded
})

test("getRecentSentMessages excludes cleared/popped rows", async () => {
  const db = makeDbWithRows([
    { sessionId: "s1", role: "assistant", body: "live", createdAt: "2026-06-04T00:00:01Z" },
    { sessionId: "s1", role: "assistant", body: "gone", createdAt: "2026-06-04T00:00:02Z", cleared: true },
    { sessionId: "s1", role: "assistant", body: "popped", createdAt: "2026-06-04T00:00:03Z", popped: true },
  ])
  const msgs = await getRecentSentMessages({ db: db as never, userId: "u1", sessionId: "s1" }, 5)
  assert.deepEqual(msgs, ["live"])
})

test("getRecentSentMessages caps to limit (most recent)", async () => {
  const rows: Row[] = []
  for (let i = 1; i <= 8; i++) {
    rows.push({ sessionId: "s1", role: "assistant", body: `m${i}`, createdAt: `2026-06-04T00:00:0${i}Z` })
  }
  const db = makeDbWithRows(rows)
  const msgs = await getRecentSentMessages({ db: db as never, userId: "u1", sessionId: "s1" }, 3)
  assert.deepEqual(msgs, ["m6", "m7", "m8"])
})

// ─── REGRESSION: the "dedup keeps triggering / silent turn" self-suppression bug (2026-06-04) ───
// @openai/agents run() persists the agent's structured output to the SAME pa-messages transcript
// (FirestoreSession.addItems, rawMeta.source="agents_sdk_session", body = `{"messages":["…"]}`) BEFORE
// deliverBubblesEx reads recentSent. getRecentSentMessages must EXCLUDE those SDK-session rows so a
// turn never near-dups its own just-written JSON wrapper. Only delivered bubbles (source="pa-outbound")
// are "what Claire sent". Live evidence: +18563790960 / ses_a5b4f2ce…, the "Im open to relocation" turn
// went silent because its single bubble dedup'd against its own `{"messages":[…]}` row (Jaccard 0.97).
test("getRecentSentMessages EXCLUDES the SDK-session JSON wrapper (by source tag) — anti self-suppress", async () => {
  const bubble =
    "sweet, thanks — since you’re open to relocating, i’ll widen the net. what type of role do you want?"
  const db = makeDbWithRows([
    // the turn's own SDK-session row — written by run() BEFORE delivery, NOT a sent iMessage
    {
      sessionId: "s1",
      role: "assistant",
      body: JSON.stringify({ messages: [bubble] }),
      createdAt: "2026-06-04T00:00:02Z",
      rawMeta: { source: "agents_sdk_session" },
    },
    // a genuinely-delivered earlier bubble (the only thing that should count as "sent")
    {
      sessionId: "s1",
      role: "assistant",
      body: "We're US-only right now — where in the US should I look?",
      createdAt: "2026-06-04T00:00:01Z",
      rawMeta: { source: "pa-outbound" },
    },
  ])
  const recentSent = await getRecentSentMessages({ db: db as never, userId: "u1", sessionId: "s1" }, 5)
  assert.deepEqual(recentSent, ["We're US-only right now — where in the US should I look?"])
  // The new bubble must NOT be suppressed against the (correctly-filtered) recentSent set.
  assert.equal(isNearDuplicateOfAny(bubble, recentSent), false)
})

test("getRecentSentMessages EXCLUDES structured-output wrapper by SHAPE even when rawMeta absent", async () => {
  const bubble = "what type of role do you want right now — software engineering, product, data?"
  const db = makeDbWithRows([
    // legacy row: SDK wrapper shape but no rawMeta.source — still must be excluded (defense-in-depth)
    {
      sessionId: "s1",
      role: "assistant",
      body: JSON.stringify({ messages: [bubble] }),
      createdAt: "2026-06-04T00:00:01Z",
    },
  ])
  const recentSent = await getRecentSentMessages({ db: db as never, userId: "u1", sessionId: "s1" }, 5)
  assert.deepEqual(recentSent, [])
  assert.equal(isNearDuplicateOfAny(bubble, recentSent), false)
})

test("getRecentSentMessages KEEPS a delivered pa-outbound bubble (real cross-turn dup still caught)", async () => {
  // The legitimate cross-turn dedup Adam wants — a repeated hold that WAS sent — must survive the
  // filter so the guard still fires on real duplicates. Use an emoji/punctuation variant of the SAME
  // message: it normalizes to the identical token stream (the dedup's exact-equality branch), which is
  // exactly the live "one sec 🔎 / one sec 🔍" class the cross-turn guard exists to catch.
  const hold = "still pulling your info, one sec 🔎"
  const db = makeDbWithRows([
    {
      sessionId: "s1",
      role: "assistant",
      body: hold,
      createdAt: "2026-06-04T00:00:01Z",
      rawMeta: { source: "pa-outbound" },
    },
  ])
  const recentSent = await getRecentSentMessages({ db: db as never, userId: "u1", sessionId: "s1" }, 5)
  assert.deepEqual(recentSent, [hold])
  assert.equal(isNearDuplicateOfAny("still pulling your info, one sec 🔍", recentSent), true)
})

// ─── REGRESSION: turn-start time bound + staleness window (the "cross_turn dedup keeps triggering") ───
// Adam 2026-06-04: cross_turn must mean a GENUINELY-PRIOR turn. (1) A row written DURING this turn (a
// tool that delivered mid-run → a `pa-outbound` row at createdAt >= turnStart) must be excluded, so the
// model's final bubble can never near-dup its own just-sent message → no false silent. (2) A days-old row
// (outside the staleness window) must be excluded, so a distinct turn is never eaten by stale history.
test("getRecentSentMessages EXCLUDES rows written at/after turnStart (this-turn tool send)", async () => {
  // now-anchored so the prior row sits INSIDE the staleness window (the staleness + turn-start cuts both
  // activate together when a turnStart is supplied).
  const now = Date.now()
  const turnStart = new Date(now).toISOString()
  const db = makeDbWithRows([
    // written DURING this turn (>= turnStart) — a find_match role bubble delivered mid-run. Must be excluded.
    {
      sessionId: "s1",
      role: "assistant",
      body: "what type of role do you want — software engineering, product, data?",
      createdAt: new Date(now + 50).toISOString(),
      rawMeta: { source: "pa-outbound" },
    },
    // a genuinely-prior turn (< turnStart, in-window) — this IS a real cross-turn message and must survive.
    {
      sessionId: "s1",
      role: "assistant",
      body: "We're US-only right now — where in the US should I look?",
      createdAt: new Date(now - 60_000).toISOString(),
      rawMeta: { source: "pa-outbound" },
    },
  ])
  const recentSent = await getRecentSentMessages(
    { db: db as never, userId: "u1", sessionId: "s1" },
    5,
    turnStart,
  )
  assert.deepEqual(recentSent, ["We're US-only right now — where in the US should I look?"])
  // The model restating the just-sent (this-turn) role clarifier must NOT be suppressed against it now.
  assert.equal(
    isNearDuplicateOfAny("what type of role do you want — software engineering, product, data?", recentSent),
    false,
  )
})

test("getRecentSentMessages drops STALE rows older than the staleness window", async () => {
  // A 2-day-old identical ask must NOT be in the cross-turn set (the live case-A long-session bug). The
  // staleness cut is gated on a turn-start stamp (the production path always threads it), so pass one
  // anchored to now(). The recent (just-now) row stays; the far-past one is dropped as stale.
  const now = Date.now()
  const turnStart = new Date(now).toISOString()
  const recentIso = new Date(now - 30_000).toISOString() // 30s ago → inside the 10-min window, < turnStart
  const db = makeDbWithRows([
    {
      sessionId: "s1",
      role: "assistant",
      body: "what's your target salary?",
      createdAt: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(), // ~2 days ago → STALE, must be dropped
      rawMeta: { source: "pa-outbound" },
    },
    {
      sessionId: "s1",
      role: "assistant",
      body: "great — pulling roles now 👇",
      createdAt: recentIso,
      rawMeta: { source: "pa-outbound" },
    },
  ])
  const recentSent = await getRecentSentMessages(
    { db: db as never, userId: "u1", sessionId: "s1" },
    5,
    turnStart,
  )
  assert.deepEqual(recentSent, ["great — pulling roles now 👇"])
  // A distinct turn re-asking salary today is NOT suppressed by the stale 2-day-old ask.
  assert.equal(isNearDuplicateOfAny("what's your target salary?", recentSent), false)
})

test("getRecentSentMessages with NO turnStart keeps recent prior rows (back-compat, real dup still caught)", async () => {
  // Omitting turnStart must not change legacy behavior for recent rows: a recent (in-window) prior bubble
  // is still returned, so a genuine literal repeat is still suppressed.
  const recentIso = new Date(Date.now() - 5_000).toISOString()
  const db = makeDbWithRows([
    {
      sessionId: "s1",
      role: "assistant",
      body: "still pulling your info, one sec 🔎",
      createdAt: recentIso,
      rawMeta: { source: "pa-outbound" },
    },
  ])
  const recentSent = await getRecentSentMessages({ db: db as never, userId: "u1", sessionId: "s1" }, 5)
  assert.deepEqual(recentSent, ["still pulling your info, one sec 🔎"])
  assert.equal(isNearDuplicateOfAny("still pulling your info, one sec 🔍", recentSent), true)
})

test("getRecentSentMessages fails open on read error → []", async () => {
  const db = makeDbWithRows([{ sessionId: "s1", role: "assistant", body: "x", createdAt: "z" }], {
    throwOnGet: true,
  })
  const msgs = await getRecentSentMessages({
    db: db as never,
    userId: "u1",
    sessionId: "s1",
    log: () => {},
  } as never)
  assert.deepEqual(msgs, [])
})

test("getRecentSentMessages fails open on missing db / session → []", async () => {
  assert.deepEqual(await getRecentSentMessages({ userId: "u1", sessionId: "s1" } as never), [])
  assert.deepEqual(
    await getRecentSentMessages({ db: makeDbWithRows([]) as never, userId: "u1", sessionId: "" }),
    [],
  )
})

// ───────────────────────────── deliverBubbles integration ─────────────────────────────

function makeCtx(db?: unknown, sessionId = "s1", userId = "u1") {
  const sent: string[] = []
  const ctx = {
    db,
    userId,
    sessionId,
    transport: {
      async sendText(v: string) {
        sent.push(v)
      },
      async typing() {},
    },
    log: () => {},
  } as unknown as Parameters<typeof deliverBubbles>[0]
  return { ctx, sent }
}

test("deliverBubbles drops a WITHIN-TURN near-dup (emoji/punctuation variant → normalizes identical), keeps first", async () => {
  const { ctx, sent } = makeCtx(makeDbWithRows([]))
  // Same words, only the trailing emoji + comma differ → normalize to the same string → dropped.
  const n = await deliverBubbles(ctx, [
    "still pulling your info, one sec 🔎",
    "still pulling your info one sec 🔍",
  ])
  assert.equal(n, 1)
  assert.deepEqual(sent, ["still pulling your info, one sec 🔎"])
})

test("deliverBubbles drops a CROSS-TURN near-dup vs recent sent messages", async () => {
  const db = makeDbWithRows([
    {
      sessionId: "s1",
      userId: "u1",
      role: "assistant",
      body: "still pulling your info, one sec 🔎",
      createdAt: "2026-06-04T00:00:01Z",
    },
  ])
  const { ctx, sent } = makeCtx(db)
  // New turn re-emits the SAME pinned hold (only emoji/punctuation differs) → normalizes identical →
  // suppressed entirely (send nothing). The hold is a FIXED phrase in prompt.ts so repeats look like this.
  const n = await deliverBubbles(ctx, ["still pulling your info one sec 🔍."])
  assert.equal(n, 0)
  assert.deepEqual(sent, [])
})

test("deliverBubbles does NOT suppress a genuinely-new bubble vs recent sent", async () => {
  const db = makeDbWithRows([
    {
      sessionId: "s1",
      userId: "u1",
      role: "assistant",
      body: "still pulling your info, one sec 🔎",
      createdAt: "2026-06-04T00:00:01Z",
    },
  ])
  const { ctx, sent } = makeCtx(db)
  const n = await deliverBubbles(ctx, ["got 3 roles that fit you — want to see them?"])
  assert.equal(n, 1)
  assert.deepEqual(sent, ["got 3 roles that fit you — want to see them?"])
})

test("deliverBubbles cross-turn read failing open does NOT block delivery", async () => {
  const db = makeDbWithRows([], { throwOnGet: true })
  const { ctx, sent } = makeCtx(db)
  const n = await deliverBubbles(ctx, ["here is a normal reply that should still go out"])
  assert.equal(n, 1)
  assert.deepEqual(sent, ["here is a normal reply that should still go out"])
})

test("deliverBubbles still works with a stub ctx lacking db (back-compat with existing dedup test)", async () => {
  // The pre-existing delivery-dedup.test.ts uses a ctx with no db/userId/sessionId.
  const sent: string[] = []
  const ctx = {
    transport: {
      async sendText(v: string) {
        sent.push(v)
      },
      async typing() {},
    },
    log: () => {},
  } as unknown as Parameters<typeof deliverBubbles>[0]
  const n = await deliverBubbles(ctx, ["one", "two", "three"])
  assert.equal(n, 3)
  assert.deepEqual(sent, ["one", "two", "three"])
})

test("deliverBubbles still drops EXACT within-turn dup (existing behavior preserved)", async () => {
  const { ctx, sent } = makeCtx(makeDbWithRows([]))
  const n = await deliverBubbles(ctx, [
    "still pulling your info, one sec 🔎",
    "still pulling your info, one sec 🔎",
  ])
  assert.equal(n, 1)
  assert.deepEqual(sent, ["still pulling your info, one sec 🔎"])
})

test("deliverBubbles keeps distinct short acks (not over-suppressed)", async () => {
  const { ctx, sent } = makeCtx(makeDbWithRows([]))
  const n = await deliverBubbles(ctx, ["ok", "got it"])
  assert.equal(n, 2)
  assert.deepEqual(sent, ["ok", "got it"])
})
