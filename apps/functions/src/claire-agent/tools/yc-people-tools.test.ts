import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { buildPeopleIntro, buildYcPeopleTools } from "./yc-people-tools.js"
import type { ClaireToolContext } from "../types.js"

/**
 * NEVER-SILENT CONTRACT for match_yc_people (live incident 2026-07-25).
 *
 * The tool description turns `delivered:true` into "reply with an EMPTY message list". Both
 * short-circuit guards (the 60s double-fire guard and the 5-people/5-min rolling budget) used to
 * return `delivered:true, count:0` — i.e. they claimed a delivery that never happened, so a real
 * question ("what about founders?") was answered with literal silence. These tests pin the fix:
 * a guard that sends NOTHING must report `delivered:false` and must demand a spoken reply.
 */

/** Minimal ctx — the guards only read pa-users/{userId} and log. Nothing else is reached. */
function makeCtx(userDoc: Record<string, unknown>): ClaireToolContext {
  const db = {
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists: true, data: () => userDoc }),
      }),
    }),
  }
  return {
    db,
    userId: "u1",
    sessionId: "s1",
    lang: "en",
    transport: {
      markRead: async () => {},
      typing: async () => {},
      sendText: async () => {
        throw new Error("guard must not send")
      },
      sendStatus: async () => {},
    },
    judgeModel: "test",
    log: () => {},
    nowIso: () => new Date().toISOString(),
  } as unknown as ClaireToolContext
}

/**
 * Every non-`query` param is `.nullable()`, which in zod still REQUIRES the key — the SDK validates
 * before execute and swallows a mismatch into an opaque error string, so send the full shape.
 */
const NULL_ARGS = {
  skills: null,
  industrySector: null,
  roleFunction: null,
  personType: null,
  companies: null,
  schools: null,
  major: null,
  location: null,
  sameSchool: null,
  sameCompany: null,
  sameMajor: null,
  limit: null,
}

/** Call the built tool the way the SDK does: invoke(runContext, jsonArgs). */
async function callMatch(
  userDoc: Record<string, unknown>,
  args: Record<string, unknown>,
): Promise<{ delivered?: boolean; count?: number; nextAction?: string }> {
  const [matchYcPeople] = buildYcPeopleTools(makeCtx(userDoc))
  const tool = matchYcPeople as unknown as {
    invoke: (ctx: unknown, input: string) => Promise<unknown>
  }
  const raw = await tool.invoke({}, JSON.stringify({ query: "", ...NULL_ARGS, ...args }))
  const out = typeof raw === "string" ? JSON.parse(raw) : (raw as Record<string, unknown>)
  return out as { delivered?: boolean; count?: number; nextAction?: string }
}

describe("match_yc_people — guards must never produce silence", () => {
  it("rolling 5-people/5-min budget spent → delivered:false + must speak", async () => {
    const now = new Date().toISOString()
    const out = await callMatch(
      // 5 people delivered inside the window → budget 0.
      { ycPeopleMatchRecent: [1, 2, 3, 4, 5].map((i) => `${now}#rec${i}`) },
      // A REAL follow-up ask — exactly the case that used to go silent.
      { query: "what about founders?" },
    )
    assert.equal(out.count, 0, "nothing was sent")
    assert.equal(out.delivered, false, "must NOT claim a delivery that did not happen")
    assert.ok(out.nextAction, "must tell the model what to say")
    // Assert the CONTRACT (it must instruct a reply), not one phrasing of it — the previous
    // literal /MUST still reply/ broke the moment the wording was reworded for a different fix.
    assert.match(out.nextAction!, /\breply with (one|at least one)\b/i)
    // The ONLY mention of an empty reply must be a prohibition of it.
    assert.match(out.nextAction!, /NEVER reply with an empty message list/i)
    // The user must never be told about our plumbing.
    assert.doesNotMatch(out.nextAction!, /\b(budget|limit|blocked)\b.*\bsay\b/i)
    // LEAK REGRESSION (live 2026-07-25, +16172568414): an earlier nextAction EXPLAINED itself
    // ("those bubbles are still on their screen"), and the model paraphrased that explanation
    // straight into the thread — "looks like your previous batch is still on their screen so
    // nothing new came through right this second." Rationale written here is text the model can
    // echo, so the field must forbid the phrasings rather than contain them.
    assert.match(out.nextAction!, /NEVER explain why/i, "must forbid explaining the suppression")
    for (const leak of ["nothing new came through", "still on your screen", "previous batch"]) {
      assert.ok(
        out.nextAction!.toLowerCase().includes(`'${leak}'`),
        `must name "${leak}" as a banned phrase, not use it as narration`,
      )
    }
  })

  it("60s double-fire guard → delivered:false + must speak", async () => {
    const out = await callMatch(
      // Budget untouched, but a batch went out 10s ago and this call carries no new ask.
      { ycPeopleMatchLastAt: new Date(Date.now() - 10_000).toISOString() },
      { query: "" },
    )
    assert.equal(out.count, 0, "nothing was sent")
    assert.equal(out.delivered, false, "must NOT claim a delivery that did not happen")
    assert.ok(out.nextAction, "must tell the model what to say")
    // Assert the CONTRACT (it must instruct a reply), not one phrasing of it — the previous
    // literal /MUST still reply/ broke the moment the wording was reworded for a different fix.
    assert.match(out.nextAction!, /\breply with (one|at least one)\b/i)
    // The ONLY mention of an empty reply must be a prohibition of it.
    assert.match(out.nextAction!, /NEVER reply with an empty message list/i)
  })

  it("the empty-list rule in the tool description is scoped to a REAL delivery", async () => {
    const [matchYcPeople] = buildYcPeopleTools(makeCtx({}))
    const description = (matchYcPeople as unknown as { description: string }).description
    // An unqualified "delivered:true → empty message list" is what made count:0 mean silence.
    assert.match(description, /delivered:true AND count > 0/)
    assert.match(description, /delivered:false you MUST speak/)
  })
})

describe("buildPeopleIntro — never present a domain substitute as the answer to the ask", () => {
  const five = Array.from({ length: 5 }, (_, i) => ({
    recordId: `r${i}`, name: `P${i}`, linkedinUrl: null, title: "T", company: "C", location: null,
    score: 0.47, reason: "r", summary: "s", relaxed: false, matchStatus: null,
  }))

  it("says so when the ask itself missed the pool, even with a full list of five", () => {
    // The failure this guards: post-`building`-fold, "professional opera singers" returned five
    // robotics engineers at normal-looking scores, and the old copy called them "a few Startup
    // School people worth meeting".
    const intro = buildPeopleIntro({ results: five, poolSize: 1033, facetMatched: 1033, didRelax: false, askMissed: true })
    assert.match(intro, /nobody here matches that exactly/)
  })

  it("still speaks normally when the ask actually bound", () => {
    const intro = buildPeopleIntro({ results: five, poolSize: 1033, facetMatched: 1033, didRelax: false, askMissed: false })
    assert.match(intro, /worth meeting/)
    assert.doesNotMatch(intro, /nobody here matches/)
  })

  it("an empty list is not overridden — the caller handles nothing-to-send", () => {
    const intro = buildPeopleIntro({ results: [], poolSize: 1033, facetMatched: 0, didRelax: false, askMissed: true })
    assert.doesNotMatch(intro, /nobody here matches that exactly/)
  })
})
