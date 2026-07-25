import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { synthesizePeopleMatchText, toPoolMember } from "../yc-people-match.js"

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
})
