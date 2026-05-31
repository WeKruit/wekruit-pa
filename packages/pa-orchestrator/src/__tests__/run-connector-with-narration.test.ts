import assert from "node:assert/strict"
import test from "node:test"
import { FIND_MATCH_PRE_CALL_VARIANTS } from "../job-match-narration.js"
import { frameConnectorResult } from "../run-connector-with-narration.js"

test("frameConnectorResult uses find-match narration templates", () => {
  const en = frameConnectorResult("find-match", "en", 2)
  assert.equal(en, "ok so I found 2 roles that look like a fit —")
  const singular = frameConnectorResult("find-match", "en", 1)
  assert.equal(singular, "ok so I found 1 role that looks like a fit —")
})

test("find-match pre-call pool has multiple friend-tone variants", () => {
  assert.ok(FIND_MATCH_PRE_CALL_VARIANTS.en.length >= 6)
})
