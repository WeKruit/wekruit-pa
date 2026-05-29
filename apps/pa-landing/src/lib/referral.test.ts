// @ts-nocheck - landing app typecheck only includes Vite/browser types; this file runs with node --test via tsx.
import assert from "node:assert/strict"
import test from "node:test"
import {
  clearReferralSlug,
  normalizeReferralSlug,
  readReferralSlug,
  rememberReferralSlug,
  REFERRAL_SLUG_STORAGE_KEY,
} from "./referral.js"

function withStorage(fn: () => void): void {
  const values = new Map<string, string>()
  globalThis.window = {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  }
  try {
    fn()
  } finally {
    delete globalThis.window
  }
}

test("referral slug storage only persists normalized valid slugs", () => {
  withStorage(() => {
    assert.equal(normalizeReferralSlug(" Maya-Chen "), "Maya-Chen")
    assert.equal(normalizeReferralSlug("../bad"), null)
    assert.equal(rememberReferralSlug(" Maya-Chen "), "Maya-Chen")
    assert.equal(readReferralSlug(), "Maya-Chen")
    clearReferralSlug("other-slug")
    assert.equal(readReferralSlug(), "maya-chen")
    clearReferralSlug("maya-chen")
    assert.equal(window.localStorage.getItem(REFERRAL_SLUG_STORAGE_KEY), null)
  })
})
