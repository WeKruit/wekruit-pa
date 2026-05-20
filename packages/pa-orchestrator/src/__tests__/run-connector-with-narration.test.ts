import assert from "node:assert/strict"
import test from "node:test"
import { FIND_MATCH_PRE_CALL_VARIANTS } from "../job-match-narration.js"
import { frameConnectorResult } from "../run-connector-with-narration.js"

test("frameConnectorResult uses find-match narration templates", () => {
  const en = frameConnectorResult("find-match", "en", 2)
  assert.ok(en?.includes("2"))
  assert.ok(en?.startsWith("ok so I found"))
})

test("find-match pre-call pool has multiple friend-tone variants", () => {
  assert.ok(FIND_MATCH_PRE_CALL_VARIANTS.en.length >= 6)
  assert.ok(FIND_MATCH_PRE_CALL_VARIANTS.zh.length >= 6)
})
