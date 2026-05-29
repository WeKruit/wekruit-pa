/**
 * SOFT-vs-HARD preference model — BOTH-DIRECTION deterministic eval.
 *
 * v2.0 non-negotiable: "every matching change is evaluated in both directions."
 * This eval drives the REAL production seams:
 *   - candidate → jobs:  queryMatchingJobsV16  (apps/job-rec/src/tools/query-matching-jobs-v16.ts)
 *   - job → candidates:  rankCandidatesForJob  (apps/job-rec/src/two-way-match.ts)
 *
 * It proves three things and prints a readable report (run with the suite):
 *   1. FLAG-OFF byte-identical: with the flag off, soft-marked axes still hard-
 *      gate exactly as today — the result set is identical to a user with NO
 *      preferenceHardness data (the production default).
 *   2. FLAG-ON soft WIDENS recall: a soft axis surfaces soft-miss jobs/candidates
 *      that a hard policy would have dropped, ranked BELOW clean matches.
 *   3. FLAG-ON hard STILL GATES: a hard axis drops the violating job/candidate.
 *
 * No API key required (deterministic — caches absent, llmMatch=0).
 */

import test from "node:test"
import assert from "node:assert/strict"
import { MockFirestore, asFirestore } from "./mock-firestore.js"
import {
  queryMatchingJobsV16,
  PREFERENCE_HARDNESS_FLAG_KEY,
} from "../tools/query-matching-jobs-v16.js"
import { rankCandidatesForJob, type MatchingCandidateRow } from "../two-way-match.js"
import type { MatchingJob } from "../types.js"

const NOW = Date.parse("2026-05-28T12:00:00Z")
const FRESH = new Date(NOW - 3 * 24 * 3600 * 1000).toISOString()

const flagOn = async (key: string) => key === PREFERENCE_HARDNESS_FLAG_KEY

const lines: string[] = []
const report = (s = "") => lines.push(s)

// ---------------------------------------------------------------------------
// Shared seed helpers
// ---------------------------------------------------------------------------

async function seedUser(mfs: MockFirestore, uid: string, extra: Record<string, unknown>) {
  await mfs.collection("pa-users").doc(uid).set({
    tags: {
      skills: ["python", "typescript"],
      industryEnum: ["tech_software"],
      schemaVersion: 2,
      targetRoleFunction: ["software_engineering"],
      careerStage: "mid_level",
      ...extra,
    },
  })
}

async function seedJob(mfs: MockFirestore, id: string, over: Record<string, unknown>) {
  await mfs.collection("matching-jobs").doc(id).set({
    id,
    status: "active",
    companyName: `${id}-co`,
    roleTitle: `SWE ${id}`,
    jobTitle: `SWE ${id}`,
    atsApplyUrl: `https://greenhouse.io/co/${id}`,
    primaryUrl: `https://example.com/${id}`,
    industry: "tech",
    sponsorship: null,
    locationRaw: "Remote",
    firstSeenAt: FRESH,
    requiredSkills: ["python"],
    roleFunction: ["software_engineering"],
    ...over,
  })
}

// ===========================================================================
// DIRECTION 1 — candidate → jobs (queryMatchingJobsV16)
// ===========================================================================

test("EVAL D1 candidate→jobs: flag OFF == no-hardness-data (byte-identical recall)", async () => {
  // Same world; one user has SOFT location data, one has none. Flag OFF for both.
  const build = async (uid: string, withHardness: boolean) => {
    const mfs = new MockFirestore()
    await seedUser(mfs, uid, {
      targetLocations: ["san_francisco_bay_area"],
      ...(withHardness ? { preferenceHardness: { location: { hardness: "soft" } } } : {}),
    })
    await seedJob(mfs, "sf", { companyName: "SfCo", jobTitle: "SWE", locationBuckets: ["san_francisco_bay_area"] })
    await seedJob(mfs, "ny", { companyName: "NyCo", jobTitle: "SWE", locationBuckets: ["new_york_metro"] })
    // No getFlag dep → flag resolves OFF (production default).
    return queryMatchingJobsV16({ userId: uid, nowMs: NOW }, { db: asFirestore(mfs) })
  }
  const withData = await build("u_soft_off", true)
  const noData = await build("u_none_off", false)
  const idsWith = withData.jobs.map((j) => j.id)
  const idsNone = noData.jobs.map((j) => j.id)
  assert.deepEqual(idsWith, idsNone)
  assert.deepEqual(idsWith, ["sf"]) // ny hard-dropped under default location=hard
  report("D1 flag-OFF: soft-location user recall == no-data user recall == " + JSON.stringify(idsWith) + "  (byte-identical) ✔")
})

test("EVAL D1 candidate→jobs: flag ON soft location WIDENS recall + ranks miss lower", async () => {
  const mfs = new MockFirestore()
  await seedUser(mfs, "u_on", {
    targetLocations: ["san_francisco_bay_area"],
    preferenceHardness: { location: { hardness: "soft" } },
  })
  await seedJob(mfs, "sf", { companyName: "SfCo", jobTitle: "SWE", locationBuckets: ["san_francisco_bay_area"] })
  await seedJob(mfs, "ny", { companyName: "NyCo", jobTitle: "SWE", locationBuckets: ["new_york_metro"] })
  const off = await queryMatchingJobsV16({ userId: "u_on", nowMs: NOW }, { db: asFirestore(mfs) })
  const on = await queryMatchingJobsV16({ userId: "u_on", nowMs: NOW }, { db: asFirestore(mfs), getFlag: flagOn })
  assert.deepEqual(off.jobs.map((j) => j.id), ["sf"]) // OFF: ny dropped
  assert.deepEqual(on.jobs.map((j) => j.id), ["sf", "ny"]) // ON: ny surfaces, ranked below sf
  assert.ok(on.jobs[0]!.v16Score.total > on.jobs[1]!.v16Score.total)
  report(
    `D1 flag-ON soft location: OFF recall=${off.jobs.length} (${off.jobs.map((j) => j.id)}), ` +
    `ON recall=${on.jobs.length} (${on.jobs.map((j) => `${j.id}@${j.v16Score.total.toFixed(3)}`)})  → WIDENED, miss ranked lower ✔`,
  )
})

test("EVAL D1 candidate→jobs: flag ON hard industry STILL GATES", async () => {
  const mfs = new MockFirestore()
  await seedUser(mfs, "u_hard", {
    industrySector: ["financial_technology"],
    preferenceHardness: { industrySector: { hardness: "hard" } },
  })
  await seedJob(mfs, "fin", { companyName: "FinCo", jobTitle: "SWE", industrySector: ["financial_technology"] })
  await seedJob(mfs, "health", { companyName: "HealthCo", jobTitle: "SWE", industrySector: ["healthcare_and_medical"] })
  const on = await queryMatchingJobsV16({ userId: "u_hard", nowMs: NOW }, { db: asFirestore(mfs), getFlag: flagOn })
  assert.deepEqual(on.jobs.map((j) => j.id), ["fin"])
  assert.equal(on.hardFilter.industrySector, 1)
  report(`D1 flag-ON hard industry: kept=${on.jobs.map((j) => j.id)}, dropped(industry)=${on.hardFilter.industrySector}  → DEALBREAKER honored ✔`)
})

test("EVAL D1 candidate→jobs: flag OFF FULL breakdown byte-identical to explicit flagOff", async () => {
  // Richer world; a user with hardness data marked on multiple axes. Prove the
  // ENTIRE scored output (ids, order, every breakdown number) is identical
  // whether the flag resolves OFF via "no reader" or via an explicit
  // always-false reader — i.e. the hardness data is fully inert when OFF.
  const flagOff = async () => false
  const build = async (getFlagImpl?: (k: string) => Promise<boolean>) => {
    const mfs = new MockFirestore()
    await seedUser(mfs, "u_full", {
      targetLocations: ["san_francisco_bay_area"],
      industrySector: ["financial_technology"],
      minSalary: 140_000,
      companySize: "early_startup",
      preferenceHardness: {
        location: { hardness: "soft" },
        industrySector: { hardness: "hard" },
        salary: { hardness: "soft", bufferPct: 0.2 },
        companyStage: { hardness: "soft" },
      },
    })
    await seedJob(mfs, "a", { companyName: "Aco", jobTitle: "SWE A", locationBuckets: ["san_francisco_bay_area"], industrySector: ["financial_technology"], salaryMin: 160_000 })
    await seedJob(mfs, "b", { companyName: "Bco", jobTitle: "SWE B", locationBuckets: ["san_francisco_bay_area"], industrySector: ["healthcare_and_medical"], salaryMin: 120_000 })
    await seedJob(mfs, "c", { companyName: "Cco", jobTitle: "SWE C", locationBuckets: ["new_york_metro"], industrySector: ["financial_technology"], salaryMin: 200_000 })
    return queryMatchingJobsV16(
      { userId: "u_full", nowMs: NOW },
      { db: asFirestore(mfs), ...(getFlagImpl ? { getFlag: getFlagImpl } : {}) },
    )
  }
  const noReader = await build()
  const explicitOff = await build(flagOff)
  const proj = (r: Awaited<ReturnType<typeof queryMatchingJobsV16>>) =>
    r.jobs.map((j) => ({ id: j.id, score: j.v16Score }))
  assert.deepEqual(proj(noReader), proj(explicitOff))
  // And none of the soft/hard breakdown keys leak when OFF.
  for (const j of noReader.jobs) {
    assert.equal(j.v16Score.companyStageBoost, undefined)
    assert.equal(j.v16Score.softMissDemerit, undefined)
  }
  assert.equal(noReader.hardFilter.salary, 0)
  assert.equal(noReader.hardFilter.industrySector, 0)
  assert.equal(noReader.hardFilter.companyStage, 0)
  report(`D1 flag-OFF FULL: no-reader output === explicit-flagOff output (ids+breakdown), no soft/hard keys leak, new counters all 0  → byte-identical ✔`)
})

// ===========================================================================
// DIRECTION 2 — job → candidates (rankCandidatesForJob)
// ===========================================================================

function mkJob(over: Partial<MatchingJob>): MatchingJob {
  return {
    id: "job1",
    companyName: "Acme",
    jobTitle: "Senior SWE",
    salaryMin: 150_000,
    salaryMax: 200_000,
    locationRaw: "New York, NY",
    primaryUrl: "https://example.com/p",
    atsApplyUrl: "https://greenhouse.io/acme/1",
    industry: "tech",
    sponsorship: true,
    firstSeenAt: FRESH,
    requiredSkills: ["python"],
    roleFunction: ["software_engineering"],
    locationBuckets: ["new_york_metro"],
    seniorityLevel: "senior",
    industrySector: ["financial_technology"],
    ...over,
  }
}

function mkCandidate(userId: string, tags: Record<string, unknown>): MatchingCandidateRow {
  return {
    userId,
    tags: {
      skills: ["python"],
      targetRoleFunction: ["software_engineering"],
      careerStage: "senior",
      ...tags,
    },
    llmMatch: 0.6,
  }
}

test("EVAL D2 job→candidates: flag OFF == no-hardness-data (byte-identical activatable pool)", async () => {
  const job = mkJob({})
  // candidate wants SF only; job is NY → location miss.
  const withData = mkCandidate("c_with", {
    targetLocations: ["san_francisco_bay_area"],
    preferenceHardness: { location: { hardness: "soft" } },
  })
  const noData = mkCandidate("c_none", { targetLocations: ["san_francisco_bay_area"] })
  const offWith = rankCandidatesForJob(job, [withData], { nowMs: NOW })[0]!
  const offNone = rankCandidatesForJob(job, [noData], { nowMs: NOW })[0]!
  assert.equal(offWith.hardFilterResult, offNone.hardFilterResult)
  assert.ok(offWith.blockedSignals.includes("location_mismatch"))
  assert.ok(offNone.blockedSignals.includes("location_mismatch"))
  assert.equal(offWith.finalScore, offNone.finalScore) // both hard-blocked → 0
  report(`D2 flag-OFF: soft-location candidate == no-data candidate (both ${offWith.hardFilterResult}, blocked=${offWith.blockedSignals.includes("location_mismatch")})  byte-identical ✔`)
})

test("EVAL D2 job→candidates: flag ON soft location keeps candidate in pool, ranked lower", async () => {
  const job = mkJob({})
  const onLoc = mkCandidate("c_match", { targetLocations: ["new_york_metro"] })
  const offLoc = mkCandidate("c_miss", {
    targetLocations: ["san_francisco_bay_area"],
    preferenceHardness: { location: { hardness: "soft" } },
  })
  // Flag OFF: off-location candidate is hard-blocked.
  const off = rankCandidatesForJob(job, [onLoc, offLoc], { nowMs: NOW })
  const offMiss = off.find((c) => c.candidateId === "c_miss")!
  assert.equal(offMiss.hardFilterResult, "hard_block")
  // Flag ON: off-location candidate is NOT blocked, surfaces with a demerit.
  const on = rankCandidatesForJob(job, [onLoc, offLoc], { nowMs: NOW, preferenceHardnessEnabled: true })
  const onMiss = on.find((c) => c.candidateId === "c_miss")!
  const onMatch = on.find((c) => c.candidateId === "c_match")!
  assert.notEqual(onMiss.hardFilterResult, "hard_block")
  assert.ok(onMiss.risks.includes("location_soft_miss"))
  assert.ok(onMatch.finalScore > onMiss.finalScore) // matched ranks above soft-miss
  report(
    `D2 flag-ON soft location: OFF c_miss=${offMiss.hardFilterResult} (excluded); ` +
    `ON c_miss=${onMiss.hardFilterResult} score=${onMiss.finalScore.toFixed(3)} < c_match=${onMatch.finalScore.toFixed(3)}  → retained in pool, ranked lower ✔`,
  )
})

test("EVAL D2 job→candidates: flag ON hard location STILL GATES", async () => {
  const job = mkJob({})
  const hardMiss = mkCandidate("c_hardmiss", {
    targetLocations: ["san_francisco_bay_area"],
    preferenceHardness: { location: { hardness: "hard" } },
  })
  const on = rankCandidatesForJob(job, [hardMiss], { nowMs: NOW, preferenceHardnessEnabled: true })[0]!
  assert.equal(on.hardFilterResult, "hard_block")
  assert.ok(on.blockedSignals.includes("location_mismatch"))
  report(`D2 flag-ON hard location: c_hardmiss=${on.hardFilterResult} blocked=${on.blockedSignals.includes("location_mismatch")}  → DEALBREAKER honored ✔`)
})

// ---------------------------------------------------------------------------
// Print the report once at the end.
// ---------------------------------------------------------------------------

test("EVAL summary report", () => {
  report("")
  report("================ SOFT-vs-HARD BOTH-DIRECTION EVAL ================")
  // Re-emit the collected lines in order at the end so they group together in
  // the test output regardless of interleaving.
  // eslint-disable-next-line no-console
  console.log("\n" + lines.join("\n") + "\n")
  assert.ok(true)
})
