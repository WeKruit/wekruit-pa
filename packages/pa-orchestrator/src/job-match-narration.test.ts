import assert from "node:assert/strict"
import test from "node:test"
import {
  composeFindMatchPreCall,
  composeMatchCollabPreCall,
  FIND_MATCH_PRE_CALL_VARIANTS,
} from "./job-match-narration.js"

test("composeFindMatchPreCall returns curated en variants", () => {
  const line = composeFindMatchPreCall("en", "user-1:evt-1", () => 0)
  assert.ok(FIND_MATCH_PRE_CALL_VARIANTS.en.includes(line))
})

test("composeFindMatchPreCall returns curated zh variants", () => {
  const line = composeFindMatchPreCall("zh", "user-1:evt-1", () => 0)
  assert.ok(FIND_MATCH_PRE_CALL_VARIANTS.zh.includes(line))
})

test("composeFindMatchPreCall cycles variants over random picks", () => {
  const seen = new Set<string>()
  for (let i = 0; i < 40; i++) {
    seen.add(composeFindMatchPreCall("en", undefined, () => i / 40))
  }
  assert.ok(seen.size > 1)
})

test("composeFindMatchPreCall is stable for the same seed", () => {
  const a = composeFindMatchPreCall("en", "stable-seed")
  const b = composeFindMatchPreCall("en", "stable-seed")
  assert.equal(a, b)
})

test("composeFindMatchPreCall pre-call lines stay short (iMessage-friendly)", () => {
  for (const line of FIND_MATCH_PRE_CALL_VARIANTS.en) {
    assert.ok(line.length <= 72, line)
  }
  for (const line of FIND_MATCH_PRE_CALL_VARIANTS.zh) {
    assert.ok(line.length <= 48, line)
  }
})

test("composeMatchCollabPreCall returns collab-specific copy", () => {
  const en = composeMatchCollabPreCall("en", "u:e")
  assert.match(en, /partner|collab|interview/i)
})
