/**
 * OpenAI key-resilience pure-logic unit tests.
 *
 * Covers the three testable cores of the resilience system:
 *   1. classifyKeyPing  — 401 invalid_api_key vs 429 insufficient_quota vs
 *      429 rate_limit_exceeded vs 2xx vs unknown.
 *   2. decideBudgetAlert — the ≥80% pre-quota threshold decision + severity.
 *   3. computeDrift      — hash-compare → drift => hasDrift (non-zero exit).
 *
 * No real key, no real network — all inputs are mocked status/body/hashes.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"

import {
  classifyKeyPing,
  decideBudgetAlert,
  computeDrift,
  parseCostsResponse,
  isPageableVerdict,
  redactSecrets,
  extractOpenAiErrorCode,
  alertDedupeId,
  DEFAULT_BUDGET_ALERT_FRACTION,
  type KeyStoreHash,
} from "./openai-key-health-logic.js"

const sha = (s: string) => createHash("sha256").update(s).digest("hex")

describe("classifyKeyPing", () => {
  it("returns ok for 2xx", () => {
    assert.equal(classifyKeyPing({ status: 200 }).verdict, "ok")
    assert.equal(classifyKeyPing({ status: 204 }).verdict, "ok")
  })

  it("returns revoked for 401 invalid_api_key (the 2026-06-01 outage)", () => {
    const r = classifyKeyPing({
      status: 401,
      body: JSON.stringify({ error: { code: "invalid_api_key", message: "Incorrect API key" } }),
    })
    assert.equal(r.verdict, "revoked")
    assert.equal(r.errorCode, "invalid_api_key")
  })

  it("returns revoked for any bare 401", () => {
    assert.equal(classifyKeyPing({ status: 401 }).verdict, "revoked")
  })

  it("returns quota_exhausted for 429 insufficient_quota", () => {
    const r = classifyKeyPing({
      status: 429,
      body: JSON.stringify({ error: { type: "insufficient_quota", message: "You exceeded your current quota" } }),
    })
    assert.equal(r.verdict, "quota_exhausted")
  })

  it("returns rate_limited for 429 rate_limit_exceeded (key still alive)", () => {
    const r = classifyKeyPing({
      status: 429,
      body: JSON.stringify({ error: { code: "rate_limit_exceeded", message: "Rate limit reached" } }),
    })
    assert.equal(r.verdict, "rate_limited")
  })

  it("treats a 429 with no body as rate_limited, not quota_exhausted", () => {
    assert.equal(classifyKeyPing({ status: 429 }).verdict, "rate_limited")
  })

  it("returns unknown for 0 (network error) and 5xx", () => {
    assert.equal(classifyKeyPing({ status: 0 }).verdict, "unknown")
    assert.equal(classifyKeyPing({ status: 503 }).verdict, "unknown")
  })

  it("only pages on revoked / quota_exhausted", () => {
    assert.equal(isPageableVerdict("revoked"), true)
    assert.equal(isPageableVerdict("quota_exhausted"), true)
    assert.equal(isPageableVerdict("rate_limited"), false)
    assert.equal(isPageableVerdict("unknown"), false)
    assert.equal(isPageableVerdict("ok"), false)
  })

  it("redacts any sk- token that leaks into an error body snippet", () => {
    const r = classifyKeyPing({
      status: 401,
      body: `Incorrect API key provided: sk-proj-fFdZ4aL7secretsecret. You can find your key...`,
    })
    assert.ok(r.snippet)
    assert.ok(!/secretsecret/.test(r.snippet ?? ""), "raw key must not survive in snippet")
    assert.match(r.snippet ?? "", /REDACTED/)
  })
})

describe("redactSecrets / extractOpenAiErrorCode", () => {
  it("redactSecrets collapses sk- tokens to a prefix", () => {
    const out = redactSecrets("key=sk-proj-ABCDEFGHIJKLMNOP rest")
    assert.ok(!out.includes("ABCDEFGHIJKLMNOP"))
    assert.match(out, /sk-proj-ABC…REDACTED|sk-proj-AB…REDACTED|REDACTED/)
  })

  it("extractOpenAiErrorCode reads error.code then error.type", () => {
    assert.equal(extractOpenAiErrorCode(JSON.stringify({ error: { code: "invalid_api_key" } })), "invalid_api_key")
    assert.equal(extractOpenAiErrorCode(JSON.stringify({ error: { type: "insufficient_quota" } })), "insufficient_quota")
    assert.equal(extractOpenAiErrorCode("not json"), undefined)
    assert.equal(extractOpenAiErrorCode(undefined), undefined)
  })
})

describe("decideBudgetAlert", () => {
  it("does not alert below 80%", () => {
    const r = decideBudgetAlert({ monthToDateUsd: 1500, monthlyBudgetUsd: 2000 })
    assert.equal(r.shouldAlert, false)
    assert.equal(r.severity, "ok")
    assert.equal(r.fractionUsed, 0.75)
  })

  it("alerts at exactly 80% (default fraction)", () => {
    const r = decideBudgetAlert({ monthToDateUsd: 1600, monthlyBudgetUsd: 2000 })
    assert.equal(r.shouldAlert, true)
    assert.equal(r.severity, "warning")
    assert.equal(DEFAULT_BUDGET_ALERT_FRACTION, 0.8)
  })

  it("marks severity=over at or above 100%", () => {
    const r = decideBudgetAlert({ monthToDateUsd: 2100, monthlyBudgetUsd: 2000 })
    assert.equal(r.shouldAlert, true)
    assert.equal(r.severity, "over")
  })

  it("honors a custom alertFraction", () => {
    const r = decideBudgetAlert({ monthToDateUsd: 1000, monthlyBudgetUsd: 2000, alertFraction: 0.5 })
    assert.equal(r.shouldAlert, true)
    assert.equal(r.thresholdUsd, 1000)
  })

  it("fail-open: non-positive / non-finite budget never alerts", () => {
    assert.equal(decideBudgetAlert({ monthToDateUsd: 9999, monthlyBudgetUsd: 0 }).shouldAlert, false)
    assert.equal(decideBudgetAlert({ monthToDateUsd: 9999, monthlyBudgetUsd: -5 }).shouldAlert, false)
    assert.equal(decideBudgetAlert({ monthToDateUsd: 9999, monthlyBudgetUsd: Number.NaN }).shouldAlert, false)
  })

  it("clamps negative month-to-date to 0", () => {
    const r = decideBudgetAlert({ monthToDateUsd: -10, monthlyBudgetUsd: 2000 })
    assert.equal(r.fractionUsed, 0)
    assert.equal(r.shouldAlert, false)
  })
})

describe("parseCostsResponse", () => {
  it("sums amount.value across all buckets/results", () => {
    const json = {
      data: [
        { results: [{ amount: { value: 12.5, currency: "usd" } }] },
        { results: [{ amount: { value: 7.25, currency: "usd" } }, { amount: { value: 0.25 } }] },
      ],
    }
    assert.equal(parseCostsResponse(json), 20)
  })

  it("returns 0 for garbage / empty shapes", () => {
    assert.equal(parseCostsResponse(null), 0)
    assert.equal(parseCostsResponse({}), 0)
    assert.equal(parseCostsResponse({ data: "nope" }), 0)
    assert.equal(parseCostsResponse({ data: [{ results: [{}] }] }), 0)
  })
})

describe("computeDrift", () => {
  const CANON = "firebase:PA_OPENAI_AGENT_API_KEY"
  const good = sha("sk-proj-NEW")
  const dead = sha("sk-proj-OLD")

  it("reports no drift when every store matches canonical (exit 0)", () => {
    const hashes: KeyStoreHash[] = [
      { store: CANON, sha256: good, prefix: "sk-proj-NEW…" },
      { store: "firebase:OPENAI_API_KEY", sha256: good },
      { store: "github:wekruit-pa", sha256: good },
    ]
    const report = computeDrift(CANON, hashes)
    assert.equal(report.driftCount, 0)
    assert.equal(report.hasDrift, false)
    assert.equal(report.rows.length, 2) // canonical excluded
    assert.ok(report.rows.every((r) => r.status === "match"))
  })

  it("flags a single drifting store (partial rotation) → hasDrift=true (non-zero exit)", () => {
    const hashes: KeyStoreHash[] = [
      { store: CANON, sha256: good },
      { store: "firebase:OPENAI_API_KEY", sha256: good },
      { store: "matching:.env", sha256: dead }, // the June-1 partial-rotation case
    ]
    const report = computeDrift(CANON, hashes)
    assert.equal(report.driftCount, 1)
    assert.equal(report.hasDrift, true)
    const drifted = report.rows.find((r) => r.store === "matching:.env")
    assert.equal(drifted?.status, "drift")
  })

  it("never leaks a key value — rows carry only hashes + redacted prefixes", () => {
    const hashes: KeyStoreHash[] = [
      { store: CANON, sha256: good, prefix: "sk-proj-NEW…" },
      { store: "x", sha256: dead, prefix: "sk-proj-OLD…" },
    ]
    const report = computeDrift(CANON, hashes)
    const serialized = JSON.stringify(report)
    // Only the redacted prefix of the drifting (non-canonical) store appears.
    assert.match(serialized, /sk-proj-OLD…/)
    // No un-redacted key value ever — every sk- token must be ellipsis-redacted.
    const skTokens = serialized.match(/sk-[A-Za-z0-9_-]+/g) ?? []
    assert.ok(
      skTokens.every((t) => t.endsWith("…") === false ? !/sk-(proj|admin)-[A-Za-z0-9]{6,}$/.test(t) : true),
      `unredacted sk- token leaked: ${JSON.stringify(skTokens)}`
    )
    // Prefixes are short (<=16 chars incl ellipsis), never a full key.
    for (const r of report.rows) {
      if (r.prefix) assert.ok(r.prefix.length <= 20, `prefix too long: ${r.prefix}`)
    }
  })

  it("unreadable store is informational, not counted as drift", () => {
    const hashes: KeyStoreHash[] = [
      { store: CANON, sha256: good },
      { store: "macmini", sha256: null, unreadable: true },
    ]
    const report = computeDrift(CANON, hashes)
    assert.equal(report.driftCount, 0)
    assert.equal(report.unreadableCount, 1)
    assert.equal(report.hasDrift, false)
    assert.equal(report.rows[0]?.status, "unreadable")
  })

  it("unreadable canonical forces hasDrift=true (cannot trust the audit)", () => {
    const hashes: KeyStoreHash[] = [
      { store: CANON, sha256: null, unreadable: true },
      { store: "firebase:OPENAI_API_KEY", sha256: good },
    ]
    const report = computeDrift(CANON, hashes)
    assert.equal(report.canonicalSha256, null)
    assert.equal(report.hasDrift, true)
  })
})

describe("alertDedupeId", () => {
  it("builds yyyy-mm-dd-<kind> from a UTC ms", () => {
    const ms = Date.UTC(2026, 5, 1, 23, 59) // 2026-06-01
    assert.equal(alertDedupeId("key-revoked", ms), "2026-06-01-key-revoked")
  })
})
