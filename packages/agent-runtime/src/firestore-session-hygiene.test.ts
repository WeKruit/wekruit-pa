import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { unwrapStructuredOutputRow } from "./firestore-session.js"

describe("session history hygiene — SDK wrapper unwrapping", () => {
  it("flattens the SDK structured-output wrapper into the prose actually sent", () => {
    // Verbatim shape seen live: 52 of 297 assistant rows on 2026-07-24 looked like this.
    const row = { role: "assistant", body: '{"messages":["hey 👋 quick pulse check","who do you want to meet?"]}' }
    const out = unwrapStructuredOutputRow(row)
    assert.equal(out.body, "hey 👋 quick pulse check\n\nwho do you want to meet?")
  })

  it("leaves ordinary assistant prose untouched", () => {
    const row = { role: "assistant", body: "got it — read through your résumé." }
    assert.equal(unwrapStructuredOutputRow(row).body, row.body)
  })

  it("leaves user rows untouched even if they look like JSON", () => {
    const row = { role: "user", body: '{"messages":["i typed this myself"]}' }
    // We only rewrite what addItems wrote; a user pasting JSON is their real message.
    assert.equal(unwrapStructuredOutputRow(row).body, row.body)
  })

  it("is safe on malformed JSON — treats it as ordinary text", () => {
    for (const body of ['{"messages":[unclosed', '{"messages":"not-an-array"}', "{", '{"other":[1]}']) {
      assert.equal(unwrapStructuredOutputRow({ role: "assistant", body }).body, body)
    }
  })

  it("keeps the row when the wrapper carries no usable text", () => {
    const body = '{"messages":[]}'
    assert.equal(unwrapStructuredOutputRow({ role: "assistant", body }).body, body)
  })
})
