/**
 * Tests for the prescreen sharedKey registry (SPEC §5a).
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  PRESCREEN_SHARED_KEYS,
  AI_USAGE_SHARED_KEY,
  isRegisteredSharedKey,
} from "../shared-keys.js"

test("ai_usage is the seed registered key", () => {
  assert.equal(AI_USAGE_SHARED_KEY, "ai_usage")
  assert.ok(PRESCREEN_SHARED_KEYS.includes("ai_usage"))
})

test("isRegisteredSharedKey: registered → true, unknown → false", () => {
  assert.equal(isRegisteredSharedKey("ai_usage"), true)
  assert.equal(isRegisteredSharedKey("work_authorization"), false) // not yet authored
  assert.equal(isRegisteredSharedKey(""), false)
  assert.equal(isRegisteredSharedKey(null), false)
  assert.equal(isRegisteredSharedKey(undefined), false)
})

test("every registered key matches the config token shape ^[a-z0-9_]+$", () => {
  for (const k of PRESCREEN_SHARED_KEYS) {
    assert.match(k, /^[a-z0-9_]+$/)
    assert.ok(k.length >= 1 && k.length <= 64)
  }
})
