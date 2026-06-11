/**
 * rec-url-guard.test.ts — 2026-06-10 trust audit (fix 2).
 *
 * Pins the deterministic apply-URL plausibility gate: live evidence included a
 * literal `wekruit.com/j/1` placeholder, a `linkedin.com/slink` spam shortlink,
 * and newsbreak.com aggregator URLs delivered to candidates.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { isPlausibleAtsUrl } from "../rec-url-guard.js"

describe("isPlausibleAtsUrl", () => {
  it("accepts real ATS URLs", () => {
    assert.equal(isPlausibleAtsUrl("https://boards.greenhouse.io/acme/jobs/123"), true)
    assert.equal(isPlausibleAtsUrl("https://jobs.lever.co/acme/abc-def"), true)
    assert.equal(isPlausibleAtsUrl("http://careers.example.com/apply?id=9"), true)
    assert.equal(isPlausibleAtsUrl("https://wekruit.com/j/hs-11005382-invoko-product-designer"), true)
  })

  it("rejects non-http(s) schemes and unparsable strings", () => {
    assert.equal(isPlausibleAtsUrl("ftp://example.com/job"), false)
    assert.equal(isPlausibleAtsUrl("javascript:alert(1)"), false)
    assert.equal(isPlausibleAtsUrl("not a url"), false)
    assert.equal(isPlausibleAtsUrl(""), false)
    assert.equal(isPlausibleAtsUrl("   "), false)
    assert.equal(isPlausibleAtsUrl(undefined), false)
    assert.equal(isPlausibleAtsUrl(null), false)
    assert.equal(isPlausibleAtsUrl(42), false)
  })

  it("rejects hosts without a dot", () => {
    assert.equal(isPlausibleAtsUrl("http://localhost/jobs/1"), false)
    assert.equal(isPlausibleAtsUrl("https://intranet/apply"), false)
  })

  it("rejects the wekruit.com/j/<digits-only> placeholder (live: wekruit.com/j/1)", () => {
    assert.equal(isPlausibleAtsUrl("https://wekruit.com/j/1"), false)
    assert.equal(isPlausibleAtsUrl("https://www.wekruit.com/j/23"), false)
    assert.equal(isPlausibleAtsUrl("http://wekruit.com/j/007?x=1"), false)
    // alphanumeric doc ids stay valid
    assert.equal(isPlausibleAtsUrl("https://wekruit.com/j/abc123"), true)
  })

  it("rejects junk hosts (newsbreak.com) including subdomains", () => {
    assert.equal(isPlausibleAtsUrl("https://newsbreak.com/some-job"), false)
    assert.equal(isPlausibleAtsUrl("https://www.newsbreak.com/some-job"), false)
  })

  it("rejects linkedin.com/slink spam shortlinks but keeps real linkedin job urls", () => {
    assert.equal(isPlausibleAtsUrl("https://www.linkedin.com/slink?code=abc"), false)
    assert.equal(isPlausibleAtsUrl("https://linkedin.com/slink/xyz"), false)
    assert.equal(isPlausibleAtsUrl("https://www.linkedin.com/jobs/view/12345"), true)
  })
})
