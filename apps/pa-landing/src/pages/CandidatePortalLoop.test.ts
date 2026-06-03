import assert from "node:assert/strict"
import test from "node:test"
import { deriveCandidateOperatingLoop } from "./CandidatePortalLoop.helpers.js"

test("candidate operating loop prioritizes interview action over recommendations", () => {
  const loop = deriveCandidateOperatingLoop([
    { status: "recommended" },
    { status: "invited" },
    { status: "interview_started" },
  ])

  assert.equal(loop.state, "action_needed")
  assert.equal(loop.primaryLabel, "Interview action")
  assert.match(loop.nextAction, /start or continue/i)
  assert.deepEqual(
    loop.stats.map((stat) => [stat.label, stat.value]),
    [
      ["New roles", "1"],
      ["Interview", "2"],
      ["Review", "0"],
      ["Retained", "0"],
    ],
  )
})

test("candidate operating loop keeps closed role outcomes as retained profile history", () => {
  const loop = deriveCandidateOperatingLoop([
    { status: "not_passed" },
    { status: "paused" },
  ])

  assert.equal(loop.state, "profile_active")
  assert.equal(loop.primaryLabel, "Profile active")
  assert.match(loop.body, /profile stays active/i)
  assert.equal(loop.stats.find((stat) => stat.label === "Retained")?.value, "2")
})
