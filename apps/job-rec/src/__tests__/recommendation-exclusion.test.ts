/**
 * recommendation-exclusion.test.ts — 2026-06-10 trust audit (fix 12, daily repeat guard).
 *
 * Live evidence: the SAME jobId was recommended to one user 3 days running —
 * V16's soft previousRecommendationPenalty never hard-stops a strong job.
 * excludeRecentlyRecommendedJobs turns the ledger into a 14d HARD exclusion.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  excludeRecentlyRecommendedJobs,
  RECENT_RECOMMENDATION_EXCLUSION_MS,
  type UserJobRecommendationState,
} from "../recommendation-state.js"

const NOW = Date.parse("2026-06-10T12:00:00Z")
const DAY = 24 * 60 * 60 * 1000

function state(jobId: string, lastRecommendedMsAgo: number): [string, UserJobRecommendationState] {
  return [
    jobId,
    {
      userId: "u1",
      jobId,
      recommendationCount: 1,
      lastRecommendedAt: new Date(NOW - lastRecommendedMsAgo).toISOString(),
    },
  ]
}

describe("excludeRecentlyRecommendedJobs", () => {
  it("excludes a job recommended yesterday (the 3-days-running bug)", () => {
    const jobs = [{ id: "j1" }, { id: "j2" }]
    const states = new Map([state("j1", 1 * DAY)])
    const { kept, excluded } = excludeRecentlyRecommendedJobs(jobs, states, NOW)
    assert.deepEqual(kept.map((j) => j.id), ["j2"])
    assert.deepEqual(excluded.map((j) => j.id), ["j1"])
  })

  it("keeps a job last recommended OUTSIDE the 14d window", () => {
    const jobs = [{ id: "j1" }]
    const states = new Map([state("j1", RECENT_RECOMMENDATION_EXCLUSION_MS + DAY)])
    const { kept, excluded } = excludeRecentlyRecommendedJobs(jobs, states, NOW)
    assert.deepEqual(kept.map((j) => j.id), ["j1"])
    assert.equal(excluded.length, 0)
  })

  it("keeps never-recommended jobs and jobs with missing/invalid timestamps", () => {
    const jobs = [{ id: "fresh" }, { id: "no-stamp" }]
    const states = new Map<string, UserJobRecommendationState>([
      ["no-stamp", { userId: "u1", jobId: "no-stamp", recommendationCount: 2 }],
    ])
    const { kept, excluded } = excludeRecentlyRecommendedJobs(jobs, states, NOW)
    assert.deepEqual(kept.map((j) => j.id), ["fresh", "no-stamp"])
    assert.equal(excluded.length, 0)
  })

  it("excludes a future-stamped row (clock skew vs end-of-day batch clock = just recommended)", () => {
    const jobs = [{ id: "j1" }]
    const states = new Map([state("j1", -6 * 60 * 60 * 1000)]) // 6h in the future
    const { excluded } = excludeRecentlyRecommendedJobs(jobs, states, NOW)
    assert.deepEqual(excluded.map((j) => j.id), ["j1"])
  })

  it("honors a custom window", () => {
    const jobs = [{ id: "j1" }]
    const states = new Map([state("j1", 2 * DAY)])
    const tight = excludeRecentlyRecommendedJobs(jobs, states, NOW, 1 * DAY)
    assert.equal(tight.excluded.length, 0, "outside a 1d window → kept")
    const wide = excludeRecentlyRecommendedJobs(jobs, states, NOW, 3 * DAY)
    assert.equal(wide.excluded.length, 1, "inside a 3d window → excluded")
  })
})
