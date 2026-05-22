import assert from "node:assert/strict"
import test from "node:test"

import { normalizePhoneLookup } from "../Users.helpers.js"

test("conversation phone lookup normalizes common US phone formats", () => {
  assert.equal(normalizePhoneLookup("+16505761618"), "+16505761618")
  assert.equal(normalizePhoneLookup("650-576-1618"), "+16505761618")
  assert.equal(normalizePhoneLookup("(650) 576-1618"), "+16505761618")
  assert.equal(normalizePhoneLookup("1 650 576 1618"), "+16505761618")
})

test("conversation phone lookup ignores non-phone searches", () => {
  assert.equal(normalizePhoneLookup("Brianna"), null)
  assert.equal(normalizePhoneLookup("j2PhKOMdOi4i0RLNwgxq"), null)
})
