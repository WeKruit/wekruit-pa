import assert from "node:assert/strict"
import test from "node:test"
import {
  PA_COLLECTIONS,
  createCandidateJobStateId,
  createEmployerVisibleProfileId,
} from "../../../packages/core-types/src/index.js"
import { runAdminPassedCandidatesSnapshot } from "../../../apps/functions/src/admin-passed-candidates.js"
import {
  defaultJobId,
  directCandidateId,
  makeFakeFirestore,
  now,
  seedPrescreenSession,
} from "./fixtures.js"

function seedStateAndMaybeSnapshot(
  store: Map<string, Map<string, Record<string, unknown>>>,
  candidateId: string,
  state: string,
  snapshot = false
) {
  const stateId = createCandidateJobStateId(candidateId, defaultJobId)
  store.get(PA_COLLECTIONS.candidateJobStates)!.set(stateId, {
    id: stateId,
    candidateId,
    jobId: defaultJobId,
    state,
    stateUpdatedAt: now,
    prescreenSessionId: `ps-${candidateId}`,
    ...(snapshot ? { employerVisibleProfileId: createEmployerVisibleProfileId(defaultJobId, candidateId) } : {}),
  })
  seedPrescreenSession(store, { sessionId: `ps-${candidateId}`, candidateId, terminal: state === "paused" ? "PAUSE" : "PASS" })
  if (snapshot) {
    store.get(PA_COLLECTIONS.employerVisibleProfiles)!.set(createEmployerVisibleProfileId(defaultJobId, candidateId), {
      snapshotId: createEmployerVisibleProfileId(defaultJobId, candidateId),
      candidateId,
      jobId: defaultJobId,
      candidateJobStateId: stateId,
      createdFromState: "passed",
      sourcePrescreenSessionId: `ps-${candidateId}`,
      passReason: "Passed first interview",
      createdAt: now,
      createdBy: "system",
    })
  }
}

test("S7 admin passed-candidates query returns only employer-visible snapshots", async () => {
  const { db, store } = makeFakeFirestore()
  seedStateAndMaybeSnapshot(store, directCandidateId, "employer_visible", true)
  seedStateAndMaybeSnapshot(store, "cand-s7-not-pass", "not_passed", false)
  seedStateAndMaybeSnapshot(store, "cand-s7-paused", "paused", false)
  seedStateAndMaybeSnapshot(store, "cand-s7-started", "prescreen_started", false)
  seedStateAndMaybeSnapshot(store, "cand-s7-passed-without-snapshot", "passed", false)

  const result = await runAdminPassedCandidatesSnapshot(
    { jobId: defaultJobId, limit: 25 },
    { db, now: () => now }
  )

  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0]!.candidateId, directCandidateId)
  assert.equal(result.summary.totalPassedSnapshots, 1)
  assert.doesNotMatch(JSON.stringify(result), /cand-s7-not-pass|cand-s7-paused|cand-s7-started|cand-s7-passed-without-snapshot/)
})

test("S7 consent-missing PASS is visible without raw contact PII", async () => {
  const { db, store } = makeFakeFirestore()
  seedStateAndMaybeSnapshot(store, "cand-s7-missing-consent", "employer_visible", true)
  store.get(PA_COLLECTIONS.users)!.set("cand-s7-missing-consent", {
    email: "missing@example.com",
    phoneE164: "+15555550100",
    linkedinUrl: "https://linkedin.com/in/private",
  })

  const result = await runAdminPassedCandidatesSnapshot(
    { jobId: defaultJobId },
    { db, now: () => now }
  )

  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0]!.profile.consentStatus, "missing")
  assert.doesNotMatch(JSON.stringify(result), /missing@example\.com|\+15555550100|linkedin\.com/)
})
