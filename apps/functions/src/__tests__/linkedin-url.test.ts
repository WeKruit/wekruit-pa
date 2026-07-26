/**
 * normalizeLinkedinProfileUrl — every string below is either a REAL message from the YC Startup
 * School event (2026-07-25) or a shape the parser must survive without ever having been coded for.
 *
 * The three marked RESCUED are the ones measured to return null from the live provider as-sent and
 * a real employee id once normalized.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { normalizeLinkedinProfileUrl as norm } from "../linkedin-url.js"

const CANON = "https://www.linkedin.com/in/ada"

describe("normalizeLinkedinProfileUrl — forms that must resolve", () => {
  it("folds every shape a phone produces to one canonical string", () => {
    for (const s of [
      "https://www.linkedin.com/in/ada",
      "http://linkedin.com/in/ada",
      "linkedin.com/in/ada",
      "https://www.linkedin.com/in/ada/",
      "https://www.LinkedIn.com/in/ada",
      "https://www.linkedin.com./in/ada",
      "https://www.linkedin.com/in/ada#experience",
      "https://www.linkedin.com/in/ada/details/experience/",
    ]) {
      assert.equal(norm(s), CANON, `failed on: ${s}`)
    }
  })

  it("RESCUED: the two forms the provider rejects as-sent", () => {
    // Measured live: as-sent → null, normalized → 776788352 / 993069777.
    assert.equal(norm("https://www.linkedin.com/in/ada?utm_source=share_via&utm_medium=member_ios"), CANON)
    assert.equal(norm("https://uk.linkedin.com/in/ada"), CANON)
  })

  it("survives shapes that were never coded for", () => {
    assert.equal(norm("https://de.linkedin.com/de/in/ada"), CANON) // locale host AND locale path
    assert.equal(norm("https://www.linkedin.com/mwlite/in/ada"), CANON) // mobile-lite wrapper
    assert.equal(norm("https://www.linkedin.com/in/ada?trk=x&originalSubdomain=in"), CANON) // unknown params
  })

  it("reads the mangled forms people actually sent", () => {
    // +16133258788 — domain typed without `.com`.
    assert.equal(norm("Sure it's LinkedIn/in/ada"), CANON)
    // +447587460771 — iOS ate the link, only the path survived.
    assert.equal(norm("I'm unable to share a link directly, but my linkedin is at /in/ada"), CANON)
    // Inside a sentence, with trailing punctuation.
    assert.equal(norm("here's mine: linkedin.com/in/ada."), CANON)
    assert.equal(norm("(https://www.linkedin.com/in/ada)"), CANON)
  })

  it("keeps a unicode slug intact", () => {
    assert.equal(norm("https://www.linkedin.com/in/josé"), "https://www.linkedin.com/in/josé")
  })
})

describe("normalizeLinkedinProfileUrl — must refuse", () => {
  it("refuses URLs that name no person", () => {
    // The logged-in self view: real users sent this twice today and it points at nobody.
    assert.equal(norm("https://www.linkedin.com/me?trk=p_mwlite_feed-secondary_nav"), null)
    assert.equal(norm("https://www.linkedin.com/company/wekruit"), null)
    assert.equal(norm("https://www.linkedin.com"), null)
  })

  it("refuses our own bind marker — it is a handle, not a profile", () => {
    assert.equal(norm("https://www.linkedin.com/oauth-linked/CxYoZkel70"), null)
  })

  it("refuses lookalike hosts (exact host match, not substring)", () => {
    assert.equal(norm("https://notlinkedin.com/in/evil"), null)
    assert.equal(norm("https://linkedin.com.evil.tld/in/evil"), null)
  })

  it("never invents a slug from prose", () => {
    assert.equal(norm("i connected my linkedin"), null)
    assert.equal(norm("I forgot my LinkedIn password"), null)
    assert.equal(norm("Check out Rucha's profile on LinkedIn"), null)
    assert.equal(norm("totally not a url"), null)
  })
})
