import assert from "node:assert/strict"
import test from "node:test"
import { rankCandidates, scoreCandidate, type DemoCandidate } from "./sourcing-demo-score.js"

test("demo ranking is stable and switches criteria without mutating candidates", () => {
  const rows: DemoCandidate[] = [
    { id: "a", name: "A", role: "", company: "", location: "", experience: 90, skills: 90, locationFit: 20, compensationFit: 20 },
    { id: "b", name: "B", role: "", company: "", location: "", experience: 55, skills: 55, locationFit: 100, compensationFit: 100 },
  ]
  assert.equal(scoreCandidate(rows[0]), 73)
  assert.deepEqual(rankCandidates(rows, "overall").map((row) => row.id), ["a", "b"])
  assert.deepEqual(rankCandidates(rows, "location").map((row) => row.id), ["b", "a"])
  assert.deepEqual(rows.map((row) => row.id), ["a", "b"])
})
