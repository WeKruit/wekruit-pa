import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { interleaveByPersonType, toPoolMember, type PeoplePoolMember } from "../yc-people-match.js"

function row(name: string, primary: string, relaxed = false) {
  const m: PeoplePoolMember = {
    ...toPoolMember(name, { currentTitle: "t", currentCompany: "c" }),
    personType: [primary],
  }
  return { m, relaxed }
}
const names = (rs: Array<{ m: PeoplePoolMember }>) => rs.map((r) => r.m.recordId)

/**
 * REGRESSION PIN. Live 2026-07-25: "Majorly founders and investors" (personType
 * [founder,investor]) returned five founders and zero investors, because the pool holds 214
 * primary-founders against 21 primary-investors and cosine ranks them in one list.
 */
describe("multi-kind personType asks show every kind they named", () => {
  it("alternates founders and investors instead of letting the majority sweep", () => {
    const rows = [
      row("f1", "founder"),
      row("f2", "founder"),
      row("f3", "founder"),
      row("f4", "founder"),
      row("f5", "founder"),
      row("i1", "investor"),
      row("i2", "investor"),
    ]
    const out = interleaveByPersonType(rows, ["founder", "investor"]).slice(0, 5)
    assert.deepEqual(names(out), ["f1", "i1", "f2", "i2", "f3"])
  })

  it("keeps cosine order inside each kind — nobody jumps a better match of their own kind", () => {
    const rows = [row("f1", "founder"), row("f2", "founder"), row("i1", "investor")]
    const out = interleaveByPersonType(rows, ["founder", "investor"])
    assert.deepEqual(names(out), ["f1", "i1", "f2"])
  })

  it("a kind the pool cannot fill contributes nothing — it never pads", () => {
    const rows = [row("f1", "founder"), row("f2", "founder")]
    const out = interleaveByPersonType(rows, ["founder", "recruiter"])
    assert.deepEqual(names(out), ["f1", "f2"])
  })

  it("single-kind and unfaceted asks are untouched", () => {
    const rows = [row("i1", "investor"), row("f1", "founder")]
    assert.deepEqual(names(interleaveByPersonType(rows, ["investor"])), ["i1", "f1"])
    assert.deepEqual(names(interleaveByPersonType(rows, [])), ["i1", "f1"])
  })

  it("relaxed filler stays behind every facet hit", () => {
    const rows = [row("f1", "founder"), row("x1", "engineer", true), row("i1", "investor")]
    assert.deepEqual(names(interleaveByPersonType(rows, ["founder", "investor"])), ["f1", "i1", "x1"])
  })

  it("counts a person once even when two named kinds could claim them", () => {
    // `personType[0]` is single-valued, so this is really a guard against a bucket duplicating a row.
    const rows = [row("i1", "investor"), row("i2", "investor")]
    assert.deepEqual(names(interleaveByPersonType(rows, ["investor", "investor"])), ["i1", "i2"])
  })
})
