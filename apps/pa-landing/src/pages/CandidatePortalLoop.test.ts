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
      ["Feedback", "0"],
      ["Profile signal", "0"],
      ["Retained", "0"],
    ],
  )
})

test("candidate operating loop turns evidence-backed closed role outcomes into profile signals", () => {
  const loop = deriveCandidateOperatingLoop([
    { status: "not_passed", reviewDecision: { decisionReason: "Needs deeper infra ownership" } },
    { status: "paused" },
  ])

  assert.equal(loop.state, "profile_signal")
  assert.equal(loop.primaryLabel, "Profile signal")
  assert.match(loop.body, /closed role outcome/i)
  assert.match(loop.nextAction, /Update profile signal/i)
  assert.equal(loop.stats.find((stat) => stat.label === "Profile signal")?.value, "1")
  assert.equal(loop.stats.find((stat) => stat.label === "Retained")?.value, "1")
})

test("candidate operating loop keeps paused roles out of profile-signal evidence", () => {
  const loop = deriveCandidateOperatingLoop([
    { status: "not_passed" },
    { status: "paused" },
  ])

  assert.equal(loop.state, "profile_active")
  assert.equal(loop.primaryLabel, "Profile active")
  assert.match(loop.body, /profile stays active/i)
  assert.equal(loop.stats.find((stat) => stat.label === "Profile signal")?.value, "0")
  assert.equal(loop.stats.find((stat) => stat.label === "Retained")?.value, "2")
})

test("candidate operating loop surfaces accepted and closed intro feedback as durable signal", () => {
  const loop = deriveCandidateOperatingLoop([
    { status: "intro_accepted" },
    { status: "intro_rejected" },
    { status: "not_passed" },
  ])

  assert.equal(loop.state, "intro_signal")
  assert.equal(loop.primaryLabel, "Intro feedback")
  assert.match(loop.body, /2 intro outcomes/)
  assert.match(loop.nextAction, /future matching/i)
  assert.equal(loop.stats.find((stat) => stat.label === "Feedback")?.value, "2")
  assert.equal(loop.stats.find((stat) => stat.label === "Profile signal")?.value, "1")
  assert.equal(loop.stats.find((stat) => stat.label === "Retained")?.value, "1")
})
