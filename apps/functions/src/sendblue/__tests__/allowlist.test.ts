import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"

import {
  useDmAllowlist,
  getPeerAllowlist,
  isSamePeer,
  normalizePeer,
} from "../allowlist.js"

const ENV_KEYS = [
  "IMESSAGE_DM_ALLOWLIST",
  "IMESSAGE_PEERS",
  "IMESSAGE_PEER",
  "IMESSAGE_DEFAULT_PEER",
] as const

let saved: Record<string, string | undefined>

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k]
}

describe("useDmAllowlist (fail-closed default)", () => {
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
    clearEnv()
  })
  afterEach(() => {
    clearEnv()
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v
    }
  })

  it("returns true when env unset (fail-closed default per 17-CONTEXT)", () => {
    assert.equal(useDmAllowlist(), true)
  })

  it("returns false ONLY when IMESSAGE_DM_ALLOWLIST=0", () => {
    process.env.IMESSAGE_DM_ALLOWLIST = "0"
    assert.equal(useDmAllowlist(), false)
  })

  it("stays true for any other value (1, true, foo, empty string)", () => {
    process.env.IMESSAGE_DM_ALLOWLIST = "1"
    assert.equal(useDmAllowlist(), true)
    process.env.IMESSAGE_DM_ALLOWLIST = "true"
    assert.equal(useDmAllowlist(), true)
    process.env.IMESSAGE_DM_ALLOWLIST = ""
    assert.equal(useDmAllowlist(), true)
  })
})

describe("getPeerAllowlist parsing + normalization", () => {
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
    clearEnv()
  })
  afterEach(() => {
    clearEnv()
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v
    }
  })

  it("returns empty array when no env set", () => {
    assert.deepEqual(getPeerAllowlist(), [])
  })

  it("parses CSV from IMESSAGE_PEERS, normalizes to E.164", () => {
    process.env.IMESSAGE_PEERS = "5551234567,+15557654321"
    assert.deepEqual(getPeerAllowlist().sort(), ["+15551234567", "+15557654321"].sort())
  })

  it("parses semicolon and newline separators", () => {
    process.env.IMESSAGE_PEERS = "5551234567;+15557654321\nfoo@example.com"
    const out = getPeerAllowlist()
    assert.ok(out.includes("+15551234567"))
    assert.ok(out.includes("+15557654321"))
    assert.ok(out.includes("foo@example.com"))
  })

  it("merges IMESSAGE_PEER + IMESSAGE_PEERS + IMESSAGE_DEFAULT_PEER", () => {
    process.env.IMESSAGE_PEER = "5551111111"
    process.env.IMESSAGE_PEERS = "5552222222"
    process.env.IMESSAGE_DEFAULT_PEER = "+15553333333"
    const out = getPeerAllowlist()
    assert.ok(out.includes("+15551111111"))
    assert.ok(out.includes("+15552222222"))
    assert.ok(out.includes("+15553333333"))
  })

  it("lowercases email peers", () => {
    process.env.IMESSAGE_PEERS = "Foo@Example.COM"
    assert.deepEqual(getPeerAllowlist(), ["foo@example.com"])
  })
})

describe("isSamePeer (E.164 last-10 match + email case-insensitive)", () => {
  it("returns true for last-10-digit match across E.164 forms", () => {
    assert.equal(isSamePeer("+15551234567", "5551234567"), true)
    assert.equal(isSamePeer("15551234567", "+15551234567"), true)
    assert.equal(isSamePeer("(555) 123-4567", "+15551234567"), true)
  })

  it("returns false on null `a`", () => {
    assert.equal(isSamePeer(null, "+15551234567"), false)
  })

  it("returns false on email vs phone mismatch", () => {
    assert.equal(isSamePeer("+15551234567", "foo@example.com"), false)
  })

  it("compares email peers case-insensitively", () => {
    assert.equal(isSamePeer("Foo@Example.COM", "foo@example.com"), true)
  })

  it("returns false when digits < 10 and forms differ (no last-10 fallback)", () => {
    // Different digit counts can't satisfy last-10-digit rule; identical short
    // strings DO match via na===nb.
    assert.equal(isSamePeer("12345", "67890"), false)
    assert.equal(isSamePeer("12345", "+1555111234567890"), false)
  })
})

describe("normalizePeer", () => {
  it("normalizes US 10-digit to +1XXXXXXXXXX", () => {
    assert.equal(normalizePeer("5551234567"), "+15551234567")
  })
  it("preserves leading + and strips formatting", () => {
    assert.equal(normalizePeer("(555) 123-4567"), "+15551234567")
    assert.equal(normalizePeer("+1 (555) 123-4567"), "+15551234567")
  })
  it("lowercases email", () => {
    assert.equal(normalizePeer("FOO@bar.COM"), "foo@bar.com")
  })
  it("returns empty string on empty/whitespace", () => {
    assert.equal(normalizePeer(""), "")
    assert.equal(normalizePeer("   "), "")
  })
})
