/**
 * The extractor, against REAL inbound text from the YC Startup School event (2026-07-25).
 *
 * Every string below is a verbatim message a person actually sent us that day, pulled from
 * `pa-sendblue-webhook-raw`. The split that matters is not "valid URL / invalid URL" — it is
 * "handing us their profile" vs "talking about LinkedIn", because the first must always produce
 * either a URL or an ask-again, and the second must produce neither.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { extractLinkedinProfileUrl, looksLikeLinkedinShareAttempt } from "../enrich-from-typed-linkedin.js"

describe("extractLinkedinProfileUrl — real event inbound", () => {
  it("reads every form that arrived as a working link", () => {
    const cases: [string, string][] = [
      ["https://www.linkedin.com/in/nishant-jain-863253394", "nishant-jain-863253394"],
      ["https://uk.linkedin.com/in/rucha-agashe-687888338", "rucha-agashe-687888338"],
      ["linkedin.com/in/patelpoojak", "patelpoojak"],
      ["https://www.linkedin.com/in/vinayak-kapoor-635a5b235?utm_source=share_via&utm_medium=member_ios", "vinayak-kapoor-635a5b235"],
      ["https://www.linkedin.com/in/paul-trusov-21a483322/", "paul-trusov-21a483322"],
      ["here's mine: linkedin.com/in/ada.", "ada"],
    ]
    for (const [input, slug] of cases) {
      const got = extractLinkedinProfileUrl(input)
      assert.ok(got, `expected a URL from: ${input}`)
      assert.ok(got.includes(slug), `expected slug ${slug} in ${got}`)
    }
  })

  it("reads the two forms that used to be missed", () => {
    // +16133258788, 16:12 — domain typed without `.com`.
    assert.match(String(extractLinkedinProfileUrl("Sure it's LinkedIn/in/jasonmilad")), /\/in\/jasonmilad/)
    // +447587460771, 17:36 — iOS ate the link, only the path survived.
    assert.match(
      String(extractLinkedinProfileUrl("I'm unable to share a link directly, but my linkedin is at /in/adiprabs")),
      /\/in\/adiprabs/,
    )
  })

  it("never resolves our own oauth placeholder", () => {
    assert.equal(extractLinkedinProfileUrl("https://www.linkedin.com/oauth-linked/CxYoZkel70"), null)
  })

  it("does not read a bare /in/ path when the message never says linkedin", () => {
    // A false positive here resolves a STRANGER, so the bare form stays gated.
    assert.equal(extractLinkedinProfileUrl("we ran the pilot /in/house last quarter"), null)
  })
})

describe("looksLikeLinkedinShareAttempt — ask again instead of going silent", () => {
  it("catches a share we cannot read", () => {
    const tryingToShare = [
      "Check out Rucha Agashe's profile on LinkedIn", // iOS share sheet, URL stripped
      "Consultez le profil de Adi Prabs sur LinkedIn", // same, French
      "https://www.linkedin.com/me?trk=p_mwlite_feed-secondary_nav", // /me self-link, no slug
      "Check my LinkedIn",
    ]
    for (const t of tryingToShare) {
      assert.equal(looksLikeLinkedinShareAttempt(t), true, `should ask again for: ${t}`)
    }
  })

  it("stays out of the way when they are just talking about LinkedIn", () => {
    const justTalking = [
      "i connected my linkedin",
      "linkedin login doesn't work",
      "I forgot my LinkedIn password",
      "I don't have a LinkedIn",
      "give me the LinkedIn of VPs of Engineering",
      "So I just connect w all of them on LinkedIn?",
      "Wait i have not updated my linkedin",
      "I think the linkedin u fetched is outdated",
    ]
    for (const t of justTalking) {
      assert.equal(looksLikeLinkedinShareAttempt(t), false, `should NOT ask again for: ${t}`)
    }
  })

  it("is false when we could already read the url", () => {
    assert.equal(looksLikeLinkedinShareAttempt("here it is https://www.linkedin.com/in/ada-l"), false)
  })
})
