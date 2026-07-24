import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  scrubYcJobOffers,
  scrubYcJobOffersFromBubble,
  YC_PEOPLE_REDIRECT,
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
