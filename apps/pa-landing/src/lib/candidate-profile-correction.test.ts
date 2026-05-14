// @ts-nocheck - landing app tests run with node --test via tsx.
import assert from "node:assert/strict"
import test from "node:test"

import {
  CANDIDATE_PROFILE_CORRECTION_CALLABLE,
  submitCandidateProfileCorrection,
} from "./candidate-profile-correction.js"

test("submitCandidateProfileCorrection trims open-ended correction text and uses the S8 callable", async () => {
  const calls: Array<{ name: string; data: unknown }> = []
  const result = await submitCandidateProfileCorrection(
    async (name, data) => {
      calls.push({ name, data })
      return {
        ok: true,
        candidateId: "pa-user-1",
        appliedKeys: ["targetLocations"],
        selfProfile: {
          candidateId: "pa-user-1",
          lifecycleState: "active",
          globalTags: { targetLocations: ["New York"] },
        },
      }
    },
    {
      correctionText: "  I am now only looking in New York or remote fintech roles.  ",
      structuredFields: { targetLocations: ["New York"], preferenceNote: "remote fintech" },
    }
  )

  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, CANDIDATE_PROFILE_CORRECTION_CALLABLE)
  assert.deepEqual(calls[0].data, {
    correctionText: "I am now only looking in New York or remote fintech roles.",
    sourceSurface: "me_profile",
    structuredFields: { targetLocations: ["New York"], preferenceNote: "remote fintech" },
  })
  assert.deepEqual(result.appliedKeys, ["targetLocations"])
})

test("submitCandidateProfileCorrection rejects blank correction text before calling Firebase", async () => {
  let called = false

  await assert.rejects(
    () =>
      submitCandidateProfileCorrection(
        async () => {
          called = true
          throw new Error("should not call")
        },
        { correctionText: " \n\t " }
      ),
    /Add a correction before submitting/
  )
  assert.equal(called, false)
})
