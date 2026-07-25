import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { explainMatch, runYcPeopleMatch, synthesizePeopleMatchText, toPoolMember } from "../yc-people-match.js"

describe("yc-people-match businessDescriptor folding", () => {
  it("leads with the weighted business model, then the current role", () => {
    const text = synthesizePeopleMatchText({
      currentTitle: "Software Engineer",
      currentCompany: "Faire",
      businessDescriptor: {
        businessModel: ["two_sided_marketplace", "ecommerce"],
        domain: ["wholesale retail"],
        whatTheyBuild: "wholesale marketplace connecting local retailers with independent brands",
      },
    })
    const lines = text.split("\n")
    // model tokens lead, repeated, so the abstraction carries weight in a mean-pooled vector
    assert.equal(lines[0], "two sided marketplace, ecommerce. ".repeat(3).trim())
    assert.equal(lines[1], "Software Engineer @ Faire")
    assert.match(lines[2]!, /wholesale marketplace connecting/)
  })

  it("is a no-op when absent (unchanged projection for un-described records)", () => {
    const base = { currentTitle: "SWE", currentCompany: "Acme", skills: ["python"] }
    assert.equal(synthesizePeopleMatchText(base), synthesizePeopleMatchText({ ...base, businessDescriptor: null }))
  })

  it("toPoolMember reads the cached descriptor off the record", () => {
    const m = toPoolMember("r1", {
      currentTitle: "PM",
      currentCompany: "Ramp",
      businessDescriptor: { businessModel: ["fintech"], domain: ["corporate spend"], whatTheyBuild: "corporate cards" },
    })
    assert.match(m.matchText, /fintech/)
  })

  // Live 2026-07-25: the intake-complete auto-fire sets ONLY `query`, so explainMatch fell through
  // to "title @ company" — byte-identical to the header buildPersonBubble already prints, which
  // suppressed it. Every person arrived with NO why-line on the default path.
  it("explains a no-facet (query-only) hit with what they build, not the title it already printed", () => {
    const m = toPoolMember("r2", {
      currentTitle: "Associate Product Manager",
      currentCompany: "Tesla",
      businessDescriptor: {
        businessModel: ["ai_application"],
        domain: ["ai agents for supply chain"],
        whatTheyBuild: "Builds AI agent products for supply-chain operations at Tesla. Also does LLM eval tooling.",
      },
    })
    const asker = { schools: [], companies: [], majors: [] }
    const why = explainMatch(m, {}, asker)
    assert.equal(why, "Builds AI agent products for supply-chain operations at Tesla")
    assert.notEqual(why, "Associate Product Manager @ Tesla", "must not echo the bubble header")
  })

  it("falls back to title @ company when the record has no descriptor", () => {
    const m = toPoolMember("r3", { currentTitle: "SWE", currentCompany: "Acme" })
    assert.equal(explainMatch(m, {}, { schools: [], companies: [], majors: [] }), "SWE @ Acme")
  })
})

// ---------------------------------------------------------------------------
// Ranking: the second vector, the embed target, and exposure spreading.
// One fake db + one fake embedder — the deps are injected precisely so this needs no network.
// ---------------------------------------------------------------------------

/** Records keyed by id; every "vector" is a 3-d unit-ish axis so cosine is readable by eye. */
function fakeDeps(records: Record<string, Record<string, unknown>>, user: Record<string, unknown>) {
  const embedded: string[] = []
  const db = {
    collection(name: string) {
      return {
        doc: (id: string) => ({
          get: async () => ({
            data: () => (name === "pa-users" ? user : records[id]),
          }),
        }),
        where: () => ({
          get: async () => ({
            docs: Object.entries(records).map(([id, d]) => ({ id, data: () => d })),
          }),
        }),
      }
    },
  }
  return {
    embedded,
    deps: {
      db: db as never,
      embed: async (text: string) => {
        embedded.push(text)
        // "robotics" asks point at axis 1, everything else at axis 0.
        return /robot/i.test(text) ? [0, 1, 0] : [1, 0, 0]
      },
      cosine: (a: readonly number[], b: readonly number[]) => {
        const d = a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0)
        const n = Math.sqrt(a.reduce((s, x) => s + x * x, 0)) * Math.sqrt(b.reduce((s, x) => s + x * x, 0))
        return n ? d / n : 0
      },
    },
  }
}

const LONG = "Senior Software Engineer with a long profile line to clear the 20-char floor"

describe("yc-people-match ranking", () => {
  it("a record whose DESCRIPTOR matches wins even when its profile vector does not", async () => {
    const { deps } = fakeDeps(
      {
        profileHit: { coresignalMatch: "ok", name: "Profile Hit", currentTitle: LONG, matchEmbedding: [0.4, 0.9, 0] },
        descHit: {
          coresignalMatch: "ok", name: "Descriptor Hit", currentTitle: LONG,
          matchEmbedding: [1, 0, 0], descriptorEmbedding: [0, 1, 0],
        },
      },
      { ycIntake: { building: "warehouse robots", wantsToMeet: "robotics founders" } },
    )
    const out = await runYcPeopleMatch({ userId: "u1", limit: 2 }, deps)
    // query → axis 1; descHit only reaches it through its second vector.
    assert.equal(out.results[0]?.name, "Descriptor Hit")
  })

  it("a record with no descriptor vector still ranks (fail-soft, ~10 of 992)", async () => {
    const { deps } = fakeDeps(
      { bare: { coresignalMatch: "ok", name: "No Descriptor", currentTitle: LONG, matchEmbedding: [0, 1, 0] } },
      { ycIntake: { building: "warehouse robots", wantsToMeet: "" } },
    )
    const out = await runYcPeopleMatch({ userId: "u1" }, deps)
    assert.equal(out.results[0]?.name, "No Descriptor")
    assert.equal(out.results[0]?.score, 1)
  })

  it("an explicit ask carries their `building` line but NOT the profile prose", async () => {
    // Live 2026-07-25: the ask REPLACED the intake context, so "builders" from someone building a
    // robotics gantry matched a construction manager, and "investors/operators" from an ML/drug-
    // development PhD matched Goldman Sachs analysts. The ask names a kind of person; the domain
    // only ever lives in `building`, so it travels with every ask.
    // The 1500-token profile projection stays out — that dilution is separately measured and is
    // what the "embed the ask alone" note in the source is about.
    const { deps, embedded } = fakeDeps(
      { a: { coresignalMatch: "ok", name: "A", currentTitle: LONG, matchEmbedding: [1, 0, 0] } },
      {
        recentRoleTitle: "Founder", recentCompany: "Acme",
        experienceHighlights: [{ title: "CTO", company: "Prior", description: "a lot of unrelated profile prose" }],
        ycIntake: { building: "an AI headhunter", wantsToMeet: "anyone" },
      },
    )
    await runYcPeopleMatch({ userId: "u1", filters: { query: "investors" } }, deps)
    assert.equal(embedded[0], "investors. an AI headhunter", "ask + what they're building")
    assert.doesNotMatch(embedded[0]!, /unrelated profile prose/, "profile stays out")
    assert.doesNotMatch(embedded[0]!, /anyone/, "wantsToMeet is superseded by the ask")
  })

  it("a NULL query is the self-referential path — it matches on who the asker is", async () => {
    // Self-reference used to be sniffed out of the ask with a regex. It is now the agent's call:
    // "someone like me" → call with query null, which is already documented as "match from what
    // they told me". The matcher's only job is that a null query means the profile projection.
    const { deps, embedded } = fakeDeps(
      { a: { coresignalMatch: "ok", name: "A", currentTitle: LONG, matchEmbedding: [1, 0, 0] } },
      {
        recentRoleTitle: "Founder", recentCompany: "Acme",
        ycIntake: { building: "an AI headhunter", wantsToMeet: "founders in fintech" },
      },
    )
    await runYcPeopleMatch({ userId: "u1", filters: {} }, deps)
    assert.match(embedded[0]!, /an AI headhunter/, "their own stated direction drives a null ask")
  })

  it("a SHORT explicit ask is still embedded alone — length must not discard a real query", async () => {
    // The tool description tells the model to put shorthand ('SWE', 'ML', 'YC', 'fintech') straight
    // into `query`, so every one of those is under the intake floor. Length-gating them returned the
    // asker's profile matches no matter what was asked (live: "fintech" and "robotics" both gave
    // Daniel Kim / Michael Kim / Alec Wang).
    for (const ask of ["fintech", "robotics", "ML", "SWE"]) {
      const { deps, embedded } = fakeDeps(
        { a: { coresignalMatch: "ok", name: "A", currentTitle: LONG, matchEmbedding: [1, 0, 0] } },
        {
          recentRoleTitle: "Founder", recentCompany: "Acme",
          ycIntake: { building: "an AI headhunter", wantsToMeet: "anyone" },
        },
      )
      await runYcPeopleMatch({ userId: "u1", filters: { query: ask } }, deps)
      assert.equal(embedded[0], `${ask}. an AI headhunter`, `"${ask}" must survive as the query text`)
    }
  })

  it("an ask that binds to NOBODY falls back to the asker's profile", async () => {
    // The gate is semantic, so the test has to be too: the pool sits on the robotics axis and the
    // ask on the other one, so nothing in the pool clears MIN_ASK_SIGNAL — the same shape as a real
    // contentless ask ("anyone"), which lands near nobody and ranks as noise.
    const { deps, embedded } = fakeDeps(
      { a: { coresignalMatch: "ok", name: "A", currentTitle: LONG, matchEmbedding: [0, 1, 0] } },
      {
        recentRoleTitle: "Founder", recentCompany: "Acme",
        ycIntake: { building: "an AI headhunter", wantsToMeet: "anyone" },
      },
    )
    await runYcPeopleMatch({ userId: "u1", filters: { query: "no preference at all" } }, deps)
    assert.equal(embedded[0], "no preference at all. an AI headhunter", "the ask is tried first")
    assert.match(embedded[1]!, /Founder @ Acme/, "…then recovered onto the profile")
  })

  it("an ask that DOES bind is never second-guessed", async () => {
    const { deps, embedded } = fakeDeps(
      { a: { coresignalMatch: "ok", name: "A", currentTitle: LONG, matchEmbedding: [1, 0, 0] } },
      {
        recentRoleTitle: "Founder", recentCompany: "Acme",
        ycIntake: { building: "an AI headhunter", wantsToMeet: "anyone" },
      },
    )
    await runYcPeopleMatch({ userId: "u1", filters: { query: "fintech" } }, deps)
    assert.equal(embedded[0], "fintech. an AI headhunter", "ranked on the ask + their domain")
    // The ask is also embedded ALONE — that is the honesty probe (`askMissed`), not a re-rank.
    // What must never appear is the asker's PROFILE projection: that is the fallback lane, and
    // running it here would throw away an ask that landed on someone.
    assert.ok(
      embedded.every((t) => !/Founder @ Acme/.test(t)),
      "no profile re-embed when the ask landed on someone",
    )
  })

  // THE 2026-07-25 INCIDENT, in miniature. Idan said he was building a robotics gantry and wanted to
  // meet "builders"; the agent put "builders" in `query`, the matcher dropped his robotics context,
  // and the top card was an Assistant Manager doing construction at Larsen & Toubro. The fake
  // embedder here reproduces exactly that shape: a bare kind-of-person ask points at the wrong axis,
  // and only the `building` line pulls the query onto the robotics one.
  it("a kind-of-person ask keeps the asker's domain — 'builders' must not return construction", async () => {
    const { deps, embedded } = fakeDeps(
      {
        construction: { coresignalMatch: "ok", name: "Construction Manager", currentTitle: LONG, matchEmbedding: [1, 0, 0] },
        robotics: { coresignalMatch: "ok", name: "Robotics Builder", currentTitle: LONG, matchEmbedding: [0, 1, 0] },
      },
      { ycIntake: { building: "custom corexy gantry, robotics + autonomous systems", wantsToMeet: "builders" } },
    )
    const out = await runYcPeopleMatch({ userId: "u1", limit: 2, filters: { query: "builders" } }, deps)
    assert.match(embedded[0]!, /corexy/, "the domain has to reach the embedder at all")
    assert.equal(out.results[0]?.name, "Robotics Builder")
  })

  // Folding `building` into every ask lifts the scores of an UNANSWERABLE ask into the normal band
  // too, so the absolute floor stops trimming it — live, "professional opera singers" came back as
  // five confident robotics engineers. The list is still the closest we have; it just must not be
  // presented as an answer to the ask.
  it("flags askMissed when the ask itself lands on nobody, without dropping anyone", async () => {
    const { deps } = fakeDeps(
      { a: { coresignalMatch: "ok", name: "Robot Person", currentTitle: LONG, matchEmbedding: [0, 1, 0] } },
      { ycIntake: { building: "warehouse robots", wantsToMeet: "anyone" } },
    )
    // "opera singers" alone → axis 0, orthogonal to the whole pool → binds to nobody.
    // "opera singers. warehouse robots" → axis 1, so the RANKING still finds the robot person.
    const out = await runYcPeopleMatch({ userId: "u1", filters: { query: "opera singers" } }, deps)
    assert.equal(out.results[0]?.name, "Robot Person", "still returns the closest — this is not a filter")
    assert.equal(out.askMissed, true)
  })

  it("does NOT flag askMissed when the ask genuinely binds", async () => {
    const { deps } = fakeDeps(
      { a: { coresignalMatch: "ok", name: "Robot Person", currentTitle: LONG, matchEmbedding: [0, 1, 0] } },
      { ycIntake: { building: "warehouse robots", wantsToMeet: "anyone" } },
    )
    const out = await runYcPeopleMatch({ userId: "u1", filters: { query: "robotics founders" } }, deps)
    assert.equal(out.askMissed, false)
  })

  it("demotes an over-exposed person so recommendations spread across the pool", async () => {
    const { deps } = fakeDeps(
      {
        popular: { coresignalMatch: "ok", name: "Popular", currentTitle: LONG, matchEmbedding: [1, 0, 0], ycExposureCount: 1 },
        unseen: { coresignalMatch: "ok", name: "Unseen", currentTitle: LONG, matchEmbedding: [0.99, 0.14, 0] },
      },
      { ycIntake: { building: "anything", wantsToMeet: "anyone" } },
    )
    const out = await runYcPeopleMatch({ userId: "u1", limit: 2 }, deps)
    // Popular has the higher raw cosine (1.0 vs ~0.999) but has been shown to a user already, so
    // the exposure demotion flips the order. Kept intentionally CLOSE: the relevance floor drops
    // anyone meaningfully worse than the best hit, so a wide synthetic gap would test the floor
    // rather than the demotion this case is about.
    assert.equal(out.results[0]?.name, "Unseen")
    assert.equal(out.results[1]?.name, "Popular")
  })
})
