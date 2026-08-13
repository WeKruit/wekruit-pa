import { test } from "node:test"
import assert from "node:assert/strict"
import { selectClaireMode } from "./mode-selector.js"

/**
 * A self-typed linkedinUrl must NOT suppress the YC LinkedIn unlock.
 *
 * Live 2026-07-24: two YC users typed a LinkedIn URL on the web form and were treated as
 * "background already ingested", so they got no one-tap unlock — which meant no enrichment ever
 * ran and they never got the "here's what stands out" pitch. Their real data was empty
 * (`experienceHighlights: 0`, `latestResumeArtifactId: null`, `linkedinOauthLinked: false`).
 * A typed URL is a CLAIM, not fetched background, and not proof of identity.
 */

const YC_OPENER = "Hey! I'm at YC Startup School — my code is 3f9c2a10-8b4e-4d6f-9a12-77cc01ab34de"

function dbWith(user: Record<string, unknown>) {
  const doc = { exists: true, data: () => user }
  const col = () => ({
    doc: () => ({ get: async () => doc, set: async () => undefined }),
    where: () => ({ limit: () => ({ get: async () => ({ docs: [], size: 0, empty: true }) }) }),
    orderBy: () => ({ limit: () => ({ get: async () => ({ docs: [], size: 0, empty: true }) }) }),
    limit: () => ({ get: async () => ({ docs: [], size: 0, empty: true }) }),
  })
  return { collection: col } as never
}

test("YC: a self-typed linkedinUrl still gets the LinkedIn unlock (live 3d1TYXwutJuP / b6ag31sPyxKR)", async () => {
  for (const typed of [
    "https://www.linkedin.com/in/xuanzuo-liu/", // 3d1TYXwutJuP…
    "Linkedin.com/in/avnithv", // b6ag31sPyxKR… — not even a valid URL
  ]) {
    const decision = await selectClaireMode({
      db: dbWith({
        source: "yc_startup_school",
        linkedinUrl: typed,
        linkedinOauthLinked: false,
        experienceHighlights: [],
      }),
      userId: "yc-typed-url",
      inboundText: YC_OPENER,
    } as never)
    assert.equal(decision.entryPosture, "yc_startup_school")
    assert.equal(
      decision.ycEventIntake?.offerLinkedin,
      true,
      `a typed URL (${typed}) is a claim, not background — still offer the unlock`,
    )
  }
})

test("YC: REAL background does suppress the offer (oauth-verified, or fetched highlights)", async () => {
  const oauth = await selectClaireMode({
    db: dbWith({ source: "yc_startup_school", linkedinOauthLinked: true }),
    userId: "yc-oauth",
    inboundText: YC_OPENER,
  } as never)
  assert.equal(oauth.ycEventIntake?.offerLinkedin, false, "OAuth connect = verified + mirrored")

  const enriched = await selectClaireMode({
    db: dbWith({
      source: "yc_startup_school",
      linkedinUrl: "https://www.linkedin.com/in/someone/",
      experienceHighlights: ["Founder at X"],
    }),
    userId: "yc-enriched",
    inboundText: YC_OPENER,
  } as never)
  assert.equal(enriched.ycEventIntake?.offerLinkedin, false, "we actually fetched their background")
})
