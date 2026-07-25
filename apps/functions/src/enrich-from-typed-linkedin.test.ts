import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { enrichFromTypedLinkedinUrl, normalizeTypedLinkedinUrl } from "./enrich-from-typed-linkedin.js"

describe("normalizeTypedLinkedinUrl — real values seen in prod", () => {
  it("adds a missing scheme", () => {
    assert.equal(
      normalizeTypedLinkedinUrl("Linkedin.com/in/avnithv"),
      "https://linkedin.com/in/avnithv",
    )
    assert.equal(
      normalizeTypedLinkedinUrl("linkedin.com/in/adam-jamil"),
      "https://linkedin.com/in/adam-jamil",
    )
  })

  it("keeps a well-formed URL", () => {
    assert.equal(
      normalizeTypedLinkedinUrl("https://www.linkedin.com/in/xuanzuo-liu/"),
      "https://www.linkedin.com/in/xuanzuo-liu/",
    )
  })

  it("rejects junk rather than guessing a path", () => {
    // Live values. "in/zelin" has no host; "Hu" is two letters. Guessing a profile path is how you
    // resolve a STRANGER — refusing is the safe outcome (they still get the one-tap connect).
    assert.equal(normalizeTypedLinkedinUrl("in/zelin"), null)
    assert.equal(normalizeTypedLinkedinUrl("Hu"), null)
    assert.equal(normalizeTypedLinkedinUrl(""), null)
    assert.equal(normalizeTypedLinkedinUrl("   "), null)
  })

  it("rejects a non-LinkedIn host (never fetch some other site's profile)", () => {
    assert.equal(normalizeTypedLinkedinUrl("https://example.com/in/someone"), null)
    assert.equal(normalizeTypedLinkedinUrl("evil-linkedin.com.attacker.io/in/x"), null)
  })
})

function dbWith(user: Record<string, unknown>, captured: Record<string, unknown>[] = []) {
  return {
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists: true, data: () => user }),
        set: async (v: Record<string, unknown>) => {
          captured.push(v)
        },
      }),
    }),
  } as never
}

describe("enrichFromTypedLinkedinUrl — gates", () => {
  it("no-ops without an API key", async () => {
    const r = await enrichFromTypedLinkedinUrl({
      db: dbWith({ linkedinUrl: "https://linkedin.com/in/x" }),
      userId: "u1",
      apiKey: null,
    })
    assert.deepEqual(r, { ok: false, reason: "no_key" })
  })

  it("no-ops when REAL background already exists (OAuth wins over a typed claim)", async () => {
    for (const user of [
      { linkedinOauthLinked: true, linkedinUrl: "https://linkedin.com/in/x" },
      { experienceHighlights: ["a"], linkedinUrl: "https://linkedin.com/in/x" },
      { latestResumeArtifactId: "art_1", linkedinUrl: "https://linkedin.com/in/x" },
    ]) {
      const r = await enrichFromTypedLinkedinUrl({ db: dbWith(user), userId: "u1", apiKey: "k" })
      assert.deepEqual(r, { ok: false, reason: "already_enriched" })
    }
  })

  it("no-ops on an unusable URL — never guesses", async () => {
    const r = await enrichFromTypedLinkedinUrl({
      db: dbWith({ linkedinUrl: "in/zelin" }),
      userId: "u1",
      apiKey: "k",
    })
    assert.deepEqual(r, { ok: false, reason: "no_url" })
  })

  it("treats a Coresignal no-match as a safe stop, not an error", async () => {
    const r = await enrichFromTypedLinkedinUrl({
      db: dbWith({ linkedinUrl: "https://linkedin.com/in/nobody" }),
      userId: "u1",
      apiKey: "k",
      search: async () => null,
      fetch: (async () => {
        throw new Error("must not fetch when there is no match")
      }) as never,
    })
    assert.deepEqual(r, { ok: false, reason: "no_match" })
  })

  it("fails OPEN on a thrown error — enrichment must never break signup", async () => {
    const r = await enrichFromTypedLinkedinUrl({
      db: dbWith({ linkedinUrl: "https://linkedin.com/in/x" }),
      userId: "u1",
      apiKey: "k",
      search: (async () => {
        throw new Error("coresignal down")
      }) as never,
    })
    assert.deepEqual(r, { ok: false, reason: "error" })
  })
})
