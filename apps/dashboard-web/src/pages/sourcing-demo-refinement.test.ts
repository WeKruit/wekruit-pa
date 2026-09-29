import assert from "node:assert/strict"
import { test } from "node:test"
import { CANDIDATES } from "./sourcing-demo-data.js"
import { matchingCompanies, refinedCandidates } from "./sourcing-demo-refinement.js"

test("similar-company refinement changes the sample result set and preserves evidence", () => {
  const property = refinedCandidates(CANDIDATES, { companyGroup: "property", selectedCompanies: ["Buildium", "AppFolio", "Yardi", "RealPage"], industry: "required", minYears: 4 })
  assert.deepEqual(property.map((candidate) => candidate.id), ["avery", "morgan", "jordan"])
  assert.deepEqual(matchingCompanies(property[0], ["Buildium", "RealPage"]), ["Buildium", "RealPage"])

  const commercial = refinedCandidates(CANDIDATES, { companyGroup: "commercial", selectedCompanies: ["VTS"], industry: "preferred", minYears: 2 })
  assert.deepEqual(commercial.map((candidate) => candidate.id), ["morgan", "sam"])
  assert.deepEqual(refinedCandidates(CANDIDATES, { companyGroup: "commercial", selectedCompanies: [], industry: "open", minYears: 1 }), [])
  assert.equal(CANDIDATES.length, 5)
})
