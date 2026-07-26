import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  scrubYcJobOffers,
  scrubYcJobOffersFromBubble,
  YC_PEOPLE_REDIRECT,
  scrubYcInternalNarration,
  YC_MORE_COMING,
} from "./yc-people-guard.js"

describe("yc-people-guard — job-offer scrub", () => {
  it("drops the exact live leak (2026-07-24T15:46Z) but keeps the warm lead-in", () => {
    // Verbatim from pa-outbound, user wpVmiMcAzv9gsNm8Caru.
    const live =
      "hey aadi — love that you're building a structure-aware trust gating mechanism for UDA teacher-student training. want me to pull a few roles that fit this kind of cv/ml + training focus?"
    const out = scrubYcJobOffersFromBubble(live)
    assert.ok(out, "bubble should survive — the first sentence is fine")
    assert.match(out, /love that you're building/)
    assert.doesNotMatch(out, /pull a few roles/)
  })

  it("KEEPS legitimate refusals verbatim (they contain job words too)", () => {
    // These are the guard WORKING live at 01:19Z / 01:49Z — scrubbing them would be a regression.
    const refusals = [
      "ugh i get why you're asking, but for YC startup school i can't pull or send job listings here—this page is people-matching only.",
      "ahh got you, but for YC Startup School on wekruit this chat isn't set up for job listings/job-role matching, it's for people-to-people intros.",
      "right now i can't share job-role listings from the platform for yc—what i can do is share the attendee contact list.",
    ]
    for (const r of refusals) {
      assert.equal(scrubYcJobOffersFromBubble(r), r, `refusal must be untouched: ${r}`)
    }
  })

  it("scrubs the other shapes the model reaches for", () => {
    const offers = [
      "want me to pull roles that fit now, or tweak anything first?",
      "AI product · founder track — also fits product, full-stack, or startup founder roles",
      "if you want a peek at who's building right now, just say the word",
      "i can share some openings that align with your background",
      "want me to find you a few jobs?",
      "here are startups that are hiring in edtech",
    ]
    for (const o of offers) {
      const out = scrubYcJobOffersFromBubble(o)
      assert.ok(
        out === null || !/roles?|jobs?|openings?|who's building|hiring/i.test(out),
        `offer should be scrubbed: ${o} → ${String(out)}`,
      )
    }
  })

  it("substitutes the people redirect when scrubbing empties the bubble (never goes silent)", () => {
    const { bubbles, scrubbed } = scrubYcJobOffers([
      "want me to pull a few roles that fit?",
    ])
    assert.equal(scrubbed, 1)
    assert.equal(bubbles.length, 1)
    assert.equal(bubbles[0], YC_PEOPLE_REDIRECT)
  })

  it("leaves normal people-lane copy byte-identical", () => {
    const clean = [
      "you're in the founder-match pool 🤝 i'll text you right here (and email you) once we find you a good match — founders, investors, operators worth meeting.",
      "who do you want to meet at startup school (founders, investors, operators)?",
      "love that — an ai headhunter is exactly the kind of thing people will care about at startup school.",
    ]
    const { bubbles, scrubbed } = scrubYcJobOffers(clean)
    assert.equal(scrubbed, 0)
    assert.deepEqual(bubbles, clean)
  })
})

describe("yc-people-guard — internal-state narration scrub", () => {
  // Every string below is VERBATIM from pa-outbound during the live YC Startup School event
  // on 2026-07-25, delivered to a real attendee. They are the "really bad experience"
  // screenshots. The tool's own nextAction already banned these exact phrasings in words —
  // the model sent them anyway, which is why this guard is deterministic and not more prompt.
  it("drops the live +19257918082 leak on all three consecutive turns", () => {
    const live = [
      "got you. quick check: i just pushed a batch already, and it looks like you're still on that same screen on your side, so i don't want to spam more right now. which 1–2 investors from the ones i sent should i go deeper on?",
      "totally hear you — but that last investor batch is still the one on your screen right now, so i don't want to spam duplicates. which 1–2 investors from what i already sent should i go deeper on?",
      "ahh got you — i see you already asked for a bigger investor batch, but it looks like the last batch is still on your screen, so i don't want to spam duplicates right now. which 1–2 investors from the ones i already sent should i focus on next?",
    ]
    const { bubbles, scrubbed } = scrubYcInternalNarration(live)
    assert.equal(scrubbed, 3, "all three leaked turns must be caught")
    for (const b of bubbles) {
      assert.doesNotMatch(b, /screen/i)
      assert.doesNotMatch(b, /batch/i)
      assert.doesNotMatch(b, /spam/i)
      assert.doesNotMatch(b, /deeper/i)
      assert.ok(b.trim().length > 0, "never trade a leak for silence")
    }
  })

  it("drops the live +16172568414 leak (the 'i tried to pull' loop)", () => {
    const live = [
      "i tried to pull design-engineer folks, but looks like your previous batch is still on their screen so nothing new came through right this second.",
      "totally get it. i tried to pull more just for cristiano, but you still have that previous batch on screen so nothing new can land right now.",
    ]
    const { bubbles, scrubbed } = scrubYcInternalNarration(live)
    assert.equal(scrubbed, 2)
    // First sentence of #2 is innocent and must survive; the leak sentence must not.
    assert.match(bubbles[1]!, /totally get it/i)
    assert.doesNotMatch(bubbles[1]!, /tried to pull/i)
    // #1 is a single leaked sentence → nothing survives → honest substitute, never empty.
    assert.equal(bubbles[0], YC_MORE_COMING)
  })

  it("KEEPS the honest short-list and no-match copy byte-intact (the guard working)", () => {
    // These are the lines the people lane depends on. Scrubbing any of them would be a
    // regression that trades an honest answer for a vague one.
    const honest = [
      "nobody here matches that exactly — but these are the closest on what you're building 👇",
      "not many here match that closely, so this is a short list rather than a padded one 👇",
      "honestly there's only one person here worth pointing you at for that — but they're a real one 👇",
      "found a few Startup School people worth meeting 👇",
      "only 2 people here match that exactly — those come first, and the rest are close on what you're building 👇",
      "more Startup School profiles are still coming in, and i'll text you the moment there's someone worth your time.",
    ]
    const { bubbles, scrubbed } = scrubYcInternalNarration(honest)
    assert.equal(scrubbed, 0, "honest copy must never be scrubbed")
    assert.deepEqual(bubbles, honest)
  })

  it("does not eat 'batch' as a real YC word", () => {
    // "batch" is YC vocabulary. Only OUR bookkeeping sense is a leak.
    const fine = [
      "Michael Kim — Cofounder @ AgentMail (YC S25)",
      "i don't actually know which batch they're in — worth asking them directly.",
      "a bunch of S25 batch founders are here this week.",
    ]
    const { bubbles, scrubbed } = scrubYcInternalNarration(fine)
    assert.equal(scrubbed, 0)
    assert.deepEqual(bubbles, fine)
  })

  it("catches the echo case: a leaked sentence reproduced from history with no tool call", () => {
    // Measured live at 17:28 on +19257918082: the window guard was NOT firing (budget had
    // expired 21s earlier) and "still on your screen" appears nowhere in the zero-results
    // payload — the model reproduced its own earlier leak from conversation history. No tool
    // return value can reach that; this seam is the only thing that can.
    const echoed = ["that last investor batch is still the one on your screen right now."]
    const { bubbles, scrubbed } = scrubYcInternalNarration(echoed)
    assert.equal(scrubbed, 1)
    assert.equal(bubbles[0], YC_MORE_COMING)
  })

  it("leaves ordinary people-lane prose byte-identical (fast path)", () => {
    const clean = [
      "who do you want to meet at startup school (founders, investors, operators)?",
      "nice, seaweb an ai-native search engine with a brain is a strong lane.",
      "you're in the founder-match pool 🤝 i'll text you right here with people worth meeting.",
    ]
    const { bubbles, scrubbed } = scrubYcInternalNarration(clean)
    assert.equal(scrubbed, 0)
    assert.deepEqual(bubbles, clean)
  })
})
