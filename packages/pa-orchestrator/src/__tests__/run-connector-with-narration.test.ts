import assert from "node:assert/strict"
import test from "node:test"
import { frameConnectorResult } from "../run-connector-with-narration.js"

test("frameConnectorResult uses find-match narration templates", () => {
  const en = frameConnectorResult("find-match", "en", 2)
  assert.ok(en?.includes("2"))
  assert.ok(en?.startsWith("ok so I found"))
})
