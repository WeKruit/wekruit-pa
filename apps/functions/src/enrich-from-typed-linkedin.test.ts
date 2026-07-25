import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  enrichFromTypedLinkedinUrl,
  extractLinkedinProfileUrl,
  normalizeTypedLinkedinUrl,
} from "./enrich-from-typed-linkedin.js"

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

  it("canonicalizes every shape a phone produces to ONE string", () => {
    // Same normalizer the OAuth connect runs, so a pasted URL and a connected one are byte-identical
    // — and the Coresignal `match_phrase` never sees `?utm_source=share` junk stuck on the slug.
    for (const raw of [
      "https://www.linkedin.com/in/xuanzuo-liu/",
      "http://linkedin.com/in/xuanzuo-liu",
      "WWW.LinkedIn.com/IN/Xuanzuo-Liu",
      "https://www.linkedin.com/in/xuanzuo-liu?utm_source=share&utm_medium=member_ios",
      "https://de.linkedin.com/in/xuanzuo-liu",
    ]) {
      assert.equal(normalizeTypedLinkedinUrl(raw), "https://linkedin.com/in/xuanzuo-liu", raw)
    }
  })

  it("LIVE 2026-07-25 +13129727824 — the exact string Claire re-asked for", () => {
    // She replied "can you paste your linkedin profile URL here exactly (linkedin.com/in/…)" to a
    // message that WAS that URL. The extractor was never the cause; assert that permanently.
    assert.equal(
      normalizeTypedLinkedinUrl("http://linkedin.com/in/sofia-grimm"),
      "https://linkedin.com/in/sofia-grimm",
    )
    assert.equal(
      extractLinkedinProfileUrl("http://linkedin.com/in/sofia-grimm"),
      "https://linkedin.com/in/sofia-grimm",
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

  it("rejects OUR OWN oauth-linked placeholder — it is a bind marker, not a profile", () => {
    // Live: 30 of the 32 stranded YC users carry exactly this in `linkedinUrl`. It is a linkedin.com
    // URL, so without this it would sail through and be sent to Coresignal as a profile.
    assert.equal(normalizeTypedLinkedinUrl("https://www.linkedin.com/oauth-linked/7RLX9e4Qjo"), null)
  })
})

describe("extractLinkedinProfileUrl — a URL pasted into a chat message", () => {
  it("finds the profile URL inside a sentence", () => {
    assert.equal(
      extractLinkedinProfileUrl("sure! https://www.linkedin.com/in/ada-lovelace/ here you go"),
      "https://linkedin.com/in/ada-lovelace",
    )
    assert.equal(
      extractLinkedinProfileUrl("linkedin.com/in/ada-lovelace"),
      "https://linkedin.com/in/ada-lovelace",
    )
  })

  it("drops trailing sentence punctuation off the slug", () => {
    assert.equal(
      extractLinkedinProfileUrl("mine is linkedin.com/in/ada."),
      "https://linkedin.com/in/ada",
    )
  })

  it("ignores anything that is not a /in/ profile", () => {
    assert.equal(extractLinkedinProfileUrl("we're hiring, see linkedin.com/company/wekruit"), null)
    assert.equal(extractLinkedinProfileUrl("https://www.linkedin.com/oauth-linked/abc"), null)
    assert.equal(extractLinkedinProfileUrl("what are you building?"), null)
    assert.equal(extractLinkedinProfileUrl(""), null)
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

  it("no-ops when REAL background already exists", async () => {
    for (const user of [
      { experienceHighlights: ["a"], linkedinUrl: "https://linkedin.com/in/x" },
      { coresignalEmployeeId: 12345, linkedinUrl: "https://linkedin.com/in/x" },
      { latestResumeArtifactId: "art_1", linkedinUrl: "https://linkedin.com/in/x" },
    ]) {
      const r = await enrichFromTypedLinkedinUrl({ db: dbWith(user), userId: "u1", apiKey: "k" })
      assert.deepEqual(r, { ok: false, reason: "already_enriched" })
    }
  })

  it("an OAuth BIND is not background — it must not block the enrich", async () => {
    // The whole 2026-07-25 gap: `linkedinOauthLinked` used to short-circuit here, so the 32 YC
    // users who connected but arrived with no profile could never be enriched by any later path.
    const r = await enrichFromTypedLinkedinUrl({
      db: dbWith({
        linkedinOauthLinked: true,
        linkedinOauthSub: "7RLX9e4Qjo",
        linkedinUrl: "https://www.linkedin.com/oauth-linked/7RLX9e4Qjo",
      }),
      userId: "u1",
      apiKey: "k",
      rawUrl: "https://www.linkedin.com/in/ada-lovelace",
      search: async () => null, // stop before the network; reaching here is the assertion
    })
    assert.deepEqual(r, { ok: false, reason: "no_match" })
  })

  it("a pasted URL wins over the stored placeholder", async () => {
    let searched: string | null = null
    const r = await enrichFromTypedLinkedinUrl({
      db: dbWith({
        linkedinOauthLinked: true,
        linkedinUrl: "https://www.linkedin.com/oauth-linked/7RLX9e4Qjo",
      }),
      userId: "u1",
      apiKey: "k",
      rawUrl: "linkedin.com/in/ada-lovelace",
      search: async (url: string) => {
        searched = url
        return null
      },
    })
    assert.deepEqual(r, { ok: false, reason: "no_match" })
    assert.equal(searched, "https://linkedin.com/in/ada-lovelace")
  })

  it("without a pasted URL, a placeholder-only user is unusable (never search the marker)", async () => {
    const r = await enrichFromTypedLinkedinUrl({
      db: dbWith({
        linkedinOauthLinked: true,
        linkedinUrl: "https://www.linkedin.com/oauth-linked/7RLX9e4Qjo",
      }),
      userId: "u1",
      apiKey: "k",
      search: (async () => {
        throw new Error("must never search our own bind marker")
      }) as never,
    })
    assert.deepEqual(r, { ok: false, reason: "no_url" })
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
