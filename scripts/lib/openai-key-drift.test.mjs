/**
 * Unit tests for the shared OpenAI key-drift helpers (scripts/lib).
 *
 * Run: node --test scripts/lib/openai-key-drift.test.mjs
 *
 * No real key, no network — all inputs are literals. Verifies the drift
 * hash-compare (mismatch → hasDrift → caller exits non-zero), redaction (never
 * leaks a value), env parsing, and the sk- key sniff.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  sha256Hex,
  redactKey,
  looksLikeOpenAiKey,
  computeDrift,
  readEnvVarFromContent,
  parseFlags,
} from "./openai-key-drift.mjs"

const CANON = "firebase:PA_OPENAI_AGENT_API_KEY"
const good = sha256Hex("sk-proj-NEWnewNEWnewNEWnew0000000000")
const dead = sha256Hex("sk-proj-OLDoldOLDoldOLDold0000000000")

describe("sha256Hex / redactKey", () => {
  it("hashes deterministically and never returns the value", () => {
    assert.equal(sha256Hex("abc"), sha256Hex("abc"))
    assert.notEqual(sha256Hex("abc"), sha256Hex("abd"))
  })
  it("redactKey returns a short prefix, never the full key", () => {
    const k = "sk-proj-fFdZ4aL7THISisFAKEtestKEY00000000"
    const red = redactKey(k)
    assert.ok(!red.includes("THISisFAKE"), "must not contain the body")
    assert.ok(red.endsWith("…"))
    assert.ok(red.length <= 16)
    assert.equal(redactKey(""), "(empty)")
    assert.equal(redactKey(undefined), "(empty)")
    assert.equal(redactKey("short"), "(short)")
  })
})

describe("looksLikeOpenAiKey", () => {
  it("accepts sk- keys >= 20 chars", () => {
    assert.equal(looksLikeOpenAiKey("sk-proj-abcdefghijklmnopqrstuvwx"), true)
    assert.equal(looksLikeOpenAiKey("sk-admin-abcdefghijklmnopqrstuvwx"), true)
  })
  it("rejects junk", () => {
    assert.equal(looksLikeOpenAiKey(""), false)
    assert.equal(looksLikeOpenAiKey("not-a-key"), false)
    assert.equal(looksLikeOpenAiKey("sk-short"), false)
    assert.equal(looksLikeOpenAiKey(undefined), false)
    assert.equal(looksLikeOpenAiKey(12345), false)
  })
})

describe("computeDrift (scripts/lib parity with the CF logic)", () => {
  it("no drift when all stores match canonical → hasDrift=false (exit 0)", () => {
    const r = computeDrift(CANON, [
      { store: CANON, sha256: good, prefix: "sk-proj-NEW…" },
      { store: "firebase:OPENAI_API_KEY", sha256: good },
      { store: "wekruit-pa/.env:OPENAI_API_KEY", sha256: good },
    ])
    assert.equal(r.driftCount, 0)
    assert.equal(r.hasDrift, false)
    assert.ok(r.rows.every((x) => x.status === "match"))
  })

  it("flags a partial-rotation drift → hasDrift=true (exit non-zero)", () => {
    const r = computeDrift(CANON, [
      { store: CANON, sha256: good },
      { store: "wekruit-matching/.env:OPENAI_API_KEY", sha256: dead },
    ])
    assert.equal(r.driftCount, 1)
    assert.equal(r.hasDrift, true)
    assert.equal(r.rows[0].status, "drift")
  })

  it("unreadable store is not drift; unreadable canonical forces hasDrift", () => {
    const a = computeDrift(CANON, [
      { store: CANON, sha256: good },
      { store: "macmini", sha256: null, unreadable: true },
    ])
    assert.equal(a.driftCount, 0)
    assert.equal(a.unreadableCount, 1)
    assert.equal(a.hasDrift, false)

    const b = computeDrift(CANON, [
      { store: CANON, sha256: null, unreadable: true },
      { store: "firebase:OPENAI_API_KEY", sha256: good },
    ])
    assert.equal(b.canonicalSha256, null)
    assert.equal(b.hasDrift, true)
  })

  it("serialized report never contains a full sk- value", () => {
    const r = computeDrift(CANON, [
      { store: CANON, sha256: good, prefix: "sk-proj-NEW…" },
      { store: "x", sha256: dead, prefix: "sk-proj-OLD…" },
    ])
    const s = JSON.stringify(r)
    const tokens = s.match(/sk-[A-Za-z0-9_-]+/g) ?? []
    // every sk- token must be a redacted prefix (ends with …) — never a key body
    assert.ok(tokens.every((t) => s.includes(t + "…") || t.length <= 11), JSON.stringify(tokens))
  })
})

describe("readEnvVarFromContent", () => {
  const content = [
    "# comment",
    "OTHER=value",
    'OPENAI_API_KEY="sk-proj-quotedKEY00000000"',
    "PA_OPENAI_AGENT_API_KEY=sk-proj-bareKEY00000000",
    "EMPTY=",
  ].join("\n")

  it("reads quoted and bare values", () => {
    assert.equal(readEnvVarFromContent(content, "OPENAI_API_KEY"), "sk-proj-quotedKEY00000000")
    assert.equal(readEnvVarFromContent(content, "PA_OPENAI_AGENT_API_KEY"), "sk-proj-bareKEY00000000")
  })
  it("returns null for missing or empty vars", () => {
    assert.equal(readEnvVarFromContent(content, "NOPE"), null)
    assert.equal(readEnvVarFromContent(content, "EMPTY"), null)
    assert.equal(readEnvVarFromContent(null, "X"), null)
  })
})

describe("parseFlags", () => {
  it("splits boolean flags and --k=v values", () => {
    const { flags, values } = parseFlags(["--apply", "--key-file=/tmp/x", "--no-github", "pos"])
    assert.ok(flags.has("apply"))
    assert.ok(flags.has("no-github"))
    assert.equal(values.get("key-file"), "/tmp/x")
  })
})
