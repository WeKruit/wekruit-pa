import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { passesFacets, toPoolMember, type PeoplePoolMember } from "../yc-people-match.js"

const NO_ASKER = { schools: [], companies: [], majors: [] }

function member(over: Partial<PeoplePoolMember>): PeoplePoolMember {
  const m = toPoolMember("r1", { currentTitle: "Engineer", currentCompany: "Acme" })
  return { ...m, ...over }
}

/**
 * REGRESSION PINS for the three documented substring failures. Each one is a real bug that shipped:
 * they are pinned here so no future "just make the facet a bit more forgiving" can bring them back.
 */
describe("yc facet stage — the substring bugs cannot come back", () => {
  it('"rl" does not match "world" or "early"', () => {
    // Measured 2026-07-25: a bare "rl" returned 63 irrelevant people through substring containment.
    const victim = member({ skills: ["world"], majors: ["early childhood education"] })
    assert.equal(passesFacets(victim, { skills: ["rl"] }, NO_ASKER), false)
    assert.equal(passesFacets(member({ skills: ["early"] }), { skills: ["rl"] }, NO_ASKER), false)
  })

  it('a member carrying the skill "c" is not a wildcard', () => {
    // The reverse direction let a 1-char stored token match every query containing that letter —
    // 235 of 988 people came back for skills:["c"].
    const cMember = member({ skills: ["c"] })
    for (const ask of ["machine learning", "cloud computing", "c++", "react"]) {
      assert.equal(passesFacets(cMember, { skills: [ask] }, NO_ASKER), false, `"c" must not match "${ask}"`)
    }
  })

  it('"chi" does not match "machine learning"', () => {
    assert.equal(passesFacets(member({ skills: ["machine learning"] }), { skills: ["chi"] }, NO_ASKER), false)
    assert.equal(passesFacets(member({ skills: ["art"] }), { skills: ["smart contracts"] }, NO_ASKER), false)
  })

  it("still matches what the facet exists for — identity, not fragment", () => {
    const cal = member({ schools: ["University of California, Berkeley"] })
    assert.equal(passesFacets(cal, { schools: ["Berkeley"] }, NO_ASKER), true)
    assert.equal(passesFacets(cal, { schools: ["UC Berkeley"] }, NO_ASKER), true)
    assert.equal(passesFacets(member({ schools: ["Stanford University"] }), { schools: ["Stanford"] }, NO_ASKER), true)
    const stripe = member({ companies: ["Stripe, Inc."] })
    assert.equal(passesFacets(stripe, { companies: ["Stripe"] }, NO_ASKER), true)
    assert.equal(passesFacets(stripe, { companies: ["ex-Stripe"] }, NO_ASKER), true)
    assert.equal(passesFacets(member({ skills: ["machine learning"] }), { skills: ["ml"] }, NO_ASKER), true)
  })

  it("an unresolvable facet value matches nobody instead of falling back to substring", () => {
    // Adam 2026-07-25 "查不到就不要硬匹配" — fewer results and an honest relax path.
    const anyone = member({ schools: ["Stanford University"], companies: ["Stripe"] })
    assert.equal(passesFacets(anyone, { major: ["High School Diploma"] }, NO_ASKER), false)
    assert.equal(passesFacets(anyone, { location: ["United States"] }, NO_ASKER), false)
  })

  it("relational flags are a join on identifiers, not a text match", () => {
    const cal = member({ schools: ["UC Berkeley College of Engineering"] })
    const asker = { schools: ["University of California, Berkeley"], companies: [], majors: [] }
    assert.equal(passesFacets(cal, { sameSchool: true }, asker), true)
    const other = member({ schools: ["Berkeley Math Circle"] })
    assert.equal(passesFacets(other, { sameSchool: true }, asker), false)
  })

  it("industrySector / roleFunction no longer gate membership", () => {
    // They steer the semantic query instead; as facets they were a substring probe over
    // title + company + skills, which is the same bug wearing a different hat.
    const anyone = member({ currentTitle: "Chef", currentCompany: "Diner", skills: [] })
    assert.equal(passesFacets(anyone, { industrySector: ["financial_technology"] }, NO_ASKER), true)
    assert.equal(passesFacets(anyone, { roleFunction: ["software_engineering"] }, NO_ASKER), true)
  })
})
