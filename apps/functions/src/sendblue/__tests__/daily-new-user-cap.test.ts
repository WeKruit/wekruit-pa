import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { DAILY_NEW_USER_CAP, dailyCountsDocId, isDailyCapped } from "../pool.js"

describe("sendblue daily new-user cap", () => {
  it("keys the counter by UTC day so the window rolls with no reset job", () => {
    assert.equal(dailyCountsDocId("2026-07-25T23:59:59.999Z"), "2026-07-25")
    assert.equal(dailyCountsDocId("2026-07-26T00:00:00.000Z"), "2026-07-26")
  })

  it("caps a number only once it has actually taken its allowance today", () => {
    const counts = { "+17174919939": DAILY_NEW_USER_CAP, "+16146202403": DAILY_NEW_USER_CAP - 1 }
    assert.equal(isDailyCapped(counts, "+17174919939"), true)
    assert.equal(isDailyCapped(counts, "+16146202403"), false)
    // Unseen number = zero used, never capped. The counter starting empty must not brick routing.
    assert.equal(isDailyCapped(counts, "+12674243238"), false)
  })

  it("an unreadable counter degrades to UNCAPPED, never to blocked", () => {
    // readDailyNewUsers returns {} on error; a person's first reply must not depend on bookkeeping.
    assert.equal(isDailyCapped({}, "+17174919939"), false)
  })
})
