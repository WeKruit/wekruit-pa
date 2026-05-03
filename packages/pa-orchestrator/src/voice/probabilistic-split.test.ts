import assert from "node:assert/strict"
import test from "node:test"
import {
  decideReplySplit,
  countSentences,
  __testing,
} from "./probabilistic-split.js"

const { buildRng, foldStringToUint32, findSplitCandidates, looksLikeHotlineTrailer } =
  __testing

// ---------------------------------------------------------------------------
// Force-1 short-circuits
// ---------------------------------------------------------------------------

test("empty reply → count=1, parts=['']", () => {
  const d = decideReplySplit("")
  assert.equal(d.count, 1)
  assert.deepEqual(d.parts, [""])
  assert.equal(d.reason, "empty")
})

test("short reply (<60 chars) → 100% count=1 regardless of seed", () => {
  const reply = "haha yeah okay sure" // 19 chars
  for (const seed of ["a", "b", "c", "turn-1", "turn-99"]) {
    const d = decideReplySplit(reply, { seed })
    assert.equal(d.count, 1, `seed=${seed} should force 1`)
    assert.equal(d.reason, "short_force_1")
  }
})

test("single-sentence reply (>60 chars but no terminator + no transition) → no_split_point or single_sentence", () => {
  // 70-char single sentence, no period, no transition marker
  const reply = "this is one long single sentence with absolutely no internal break"
  const d = decideReplySplit(reply, { seed: "x" })
  assert.equal(d.count, 1)
  // Either gate is acceptable — what matters is force-1.
  assert.ok(
    d.reason === "single_sentence_force_1" || d.reason === "no_split_point",
    `unexpected reason: ${d.reason}`
  )
})

test("hotline trailer reply (988) → force count=1 (P0 crisis safety)", () => {
  const reply =
    "i hear you. this sounds really hard. if you want to talk to someone — text HOME to 741741, or 988 (US Suicide & Crisis Lifeline). anytime."
  for (const seed of ["any-seed-1", "any-seed-2", "another"]) {
    const d = decideReplySplit(reply, { seed })
    assert.equal(d.count, 1, `crisis must NEVER split, seed=${seed}`)
    assert.equal(d.reason, "hotline_trailer_force_1")
  }
})

test("hotline trailer reply (zh 心理援助热线) → force count=1", () => {
  const reply =
    "我听到了，这真的太难了。如果你想找人说话，心理援助热线 400-161-9995（24h），随时拨。"
  const d = decideReplySplit(reply, { seed: "x" })
  assert.equal(d.count, 1)
  assert.equal(d.reason, "hotline_trailer_force_1")
})

test("mem0Degraded marker reply → force count=1", () => {
  const reply =
    "okay so the next steps are blah blah and that should set you up.\n\n（长期语义记忆暂时不可用；我仍使用已确认事实和最近对话。）"
  const d = decideReplySplit(reply, { seed: "x" })
  assert.equal(d.count, 1)
  assert.equal(d.reason, "mem0_marker_force_1")
})

// ---------------------------------------------------------------------------
// Split mechanics
// ---------------------------------------------------------------------------

test("zh '另外' transition marker is preferred split point", () => {
  // Reply must be >= minCharsForSplit (60) and have >=2 sentences. 另外 must
  // land in the 30%-70% position window of the full reply for the candidate
  // to be eligible (see findSplitCandidates). We pad with extra context on
  // both sides so the marker falls near center.
  const reply =
    "好的，我大概懂你想表达的意思了，这个观点其实挺有道理的，我也认同。另外，你之前提到的那个面试时间确认了吗？需要我帮你再看一下日程吗？"
  // Confirm fixture meets the splitter's eligibility gates.
  assert.ok(reply.length >= 60, `fixture must be ≥60 chars, got ${reply.length}`)
  // Force a split with pOne=0 so we definitely take count=2 if a candidate exists.
  const d = decideReplySplit(reply, { seed: "marker-zh", pOne: 0 })
  assert.equal(d.count, 2, `expected count=2, got reason=${d.reason}`)
  assert.ok(d.splitAtIndex! > 0)
  // Second part should start with the transition marker.
  assert.ok(
    d.parts[1]!.startsWith("另外"),
    `parts[1] should start with 另外 but got: ${d.parts[1]}`
  )
})

test("en 'btw' transition marker is preferred split point", () => {
  const reply =
    "yeah totally get what you mean, that makes a lot of sense to me. btw did you ever hear back about that interview slot you were waiting on?"
  const d = decideReplySplit(reply, { seed: "marker-en", pOne: 0 })
  assert.equal(d.count, 2)
  assert.ok(
    /^btw\b/i.test(d.parts[1]!),
    `parts[1] should start with btw but got: ${d.parts[1]}`
  )
})

test("seed determinism — same seed + same input → identical decision", () => {
  const reply =
    "okay so i looked at the job description again. it actually fits your background pretty well. you should probably apply this week before the deadline."
  const d1 = decideReplySplit(reply, { seed: "deterministic-seed" })
  const d2 = decideReplySplit(reply, { seed: "deterministic-seed" })
  assert.equal(d1.count, d2.count)
  assert.equal(d1.reason, d2.reason)
  assert.deepEqual(d1.parts, d2.parts)
  assert.equal(d1.splitAtIndex, d2.splitAtIndex)
})

test("no split point in reply → count=1 fallback", () => {
  // Long reply but built as one big run-on with no terminator AND no marker.
  // We use commas only — those are NOT sentence boundaries in our tokenizer.
  const reply =
    "yeah so i was thinking about the thing you said earlier and it got me wondering whether maybe we should just go with the simpler option since it actually solves the same problem"
  // Force pOne=0 so the only thing that can save count=1 is no_split_point.
  // But this reply is also single-sentence so single_sentence_force_1 fires
  // first — that's fine, both paths converge on count=1 which is the
  // contract.
  const d = decideReplySplit(reply, { seed: "no-split", pOne: 0 })
  assert.equal(d.count, 1)
})

test("weighted random distribution sanity — 100 trials at default p=0.65 → 50-80 ones", () => {
  // A reply that has a clean sentence boundary so EITHER decision is viable.
  const reply =
    "okay i think i get what you're saying now. that interview thing actually kind of changes how i'd approach the resume part."
  let ones = 0
  for (let i = 0; i < 100; i++) {
    const d = decideReplySplit(reply, { seed: `trial-${i}` })
    if (d.count === 1) ones++
  }
  assert.ok(
    ones >= 50 && ones <= 80,
    `expected 50-80 ones at p=0.65, got ${ones}`
  )
})

test("long reply (>100 chars, ≥3 sentences) → p_two bumps to 0.5 → distribution skews", () => {
  const reply =
    "yeah honestly i totally get it. that whole interview prep thing is so draining when you're juggling apps. i think the right move is to focus on two roles tops. that way you can actually personalize each cover letter properly."
  let ones = 0
  for (let i = 0; i < 100; i++) {
    const d = decideReplySplit(reply, { seed: `long-trial-${i}` })
    if (d.count === 1) ones++
  }
  // With p_two=0.5, we expect roughly 50/50 ± reasonable variance.
  assert.ok(
    ones >= 30 && ones <= 70,
    `expected ~50/50 for long reply, got ${ones} ones`
  )
})

test("countSentences — bilingual punctuation handling", () => {
  assert.equal(countSentences(""), 0)
  assert.equal(countSentences("hi"), 1)
  assert.equal(countSentences("hi."), 1)
  assert.equal(countSentences("hi. how are you?"), 2)
  assert.equal(countSentences("你好。今天怎么样？"), 2)
  assert.equal(countSentences("a! b? c."), 3)
  // Trailing-no-terminator should still count the dangling fragment.
  assert.equal(countSentences("first sentence. second one"), 2)
})

test("findSplitCandidates respects 20%-80% position window (Bug 9 widened)", () => {
  // Split candidate indices must fall in [20%, 80%].
  const reply =
    "abcdefghij. klmnopqrst. uvwxyzabcd. efghijklmn. opqrstuvwx. yzabcdefgh. ijklmnopqr. stuvwxyzab"
  const candidates = findSplitCandidates(reply)
  for (const c of candidates) {
    assert.ok(
      c.index >= Math.floor(reply.length * 0.2) &&
        c.index <= Math.floor(reply.length * 0.8),
      `candidate ${c.index} out of [20%, 80%] for len=${reply.length}`
    )
  }
})

test("buildRng returns deterministic stream for same seed", () => {
  const r1 = buildRng("seed-x")
  const r2 = buildRng("seed-x")
  for (let i = 0; i < 10; i++) {
    assert.equal(r1(), r2())
  }
  // Different seed produces a different stream (with overwhelming probability).
  const r3 = buildRng("seed-y")
  let anyDiff = false
  for (let i = 0; i < 10; i++) {
    if (r3() !== buildRng("seed-x")()) {
      anyDiff = true
    }
  }
  assert.ok(anyDiff, "different seeds should produce different streams")
})

test("foldStringToUint32 returns stable hash", () => {
  assert.equal(foldStringToUint32("hello"), foldStringToUint32("hello"))
  assert.notEqual(foldStringToUint32("hello"), foldStringToUint32("world"))
})

test("looksLikeHotlineTrailer covers all three trailer variants", () => {
  // zh
  assert.equal(
    looksLikeHotlineTrailer(
      "我在这。如果你想找人说话，心理援助热线 400-161-9995（24h），随时拨。"
    ),
    true
  )
  // en
  assert.equal(
    looksLikeHotlineTrailer(
      "i'm here. if you want to talk to someone — Crisis Text Line: text HOME to 741741, or 988 (US Suicide & Crisis Lifeline). anytime."
    ),
    true
  )
  // mixed
  assert.equal(
    looksLikeHotlineTrailer(
      "我在这 / i'm here. 心理援助热线 400-161-9995（24h），or text HOME to 741741 (Crisis Text Line). 随时 / anytime."
    ),
    true
  )
  // benign reply with year 1988 must NOT trip
  assert.equal(looksLikeHotlineTrailer("born in 1988 actually"), false)
})

test("split parts preserve no whitespace artifacts at boundary", () => {
  const reply =
    "okay i think that makes sense to me. also you should probably ping them tomorrow morning about that interview slot."
  const d = decideReplySplit(reply, { seed: "trim", pOne: 0 })
  if (d.count === 2) {
    // No leading/trailing whitespace on either part.
    assert.equal(d.parts[0], d.parts[0]!.trim())
    assert.equal(d.parts[1], d.parts[1]!.trim())
    // No part is empty.
    assert.ok(d.parts[0]!.length > 0)
    assert.ok(d.parts[1]!.length > 0)
  }
})

test("guardHotline=false bypass works (test-only escape hatch)", () => {
  // Same hotline reply but with guard disabled — we should be able to
  // exercise the split mechanism on it. This is a unit-test affordance only;
  // production code path always passes guardHotline=true (default).
  const reply =
    "i hear you. this sounds really hard. if you want to talk to someone — text HOME to 741741, or 988. anytime."
  const d = decideReplySplit(reply, { seed: "bypass", pOne: 0, guardHotline: false })
  // Now the decision is no longer forced by hotline_trailer_force_1.
  assert.notEqual(d.reason, "hotline_trailer_force_1")
})
