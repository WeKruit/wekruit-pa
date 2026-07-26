import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { buildPeopleIntro, buildYcPeopleTools } from "./yc-people-tools.js"
import type { ClaireToolContext } from "../types.js"

/**
 * NEVER-SILENT CONTRACT for match_yc_people (live incident 2026-07-25).
 *
 * The tool description turns `delivered:true` into "reply with an EMPTY message list". Two
 * short-circuit guards used to return `delivered:true, count:0` — claiming a delivery that never
 * happened — so a real question ("what about founders?") was answered with literal silence.
 *
 * BOTH GUARDS ARE NOW DELETED (Adam 2026-07-26: "no rolling budget / next action"), so the tests
 * that pinned their individual shapes are gone with them. What survives is the rule that outlived
 * them: the empty-list instruction is scoped to a REAL delivery, never to a zero-count return.
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

  // The 60s double-fire guard this used to pin is DELETED (Adam 2026-07-26: "no rolling budget /
  // next action"). It was dead code — `hasNewAsk` was always true once `query` became required —
  // and its `nextAction` rationale leaked to attendees. Volume is a hard clamp of 5 per response
  // in `runYcPeopleMatch` now, so there is no short-circuit left here to go silent.

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
