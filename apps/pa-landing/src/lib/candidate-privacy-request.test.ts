import assert from "node:assert/strict"
import test from "node:test"
import {
  CANDIDATE_PRIVACY_REQUEST_CALLABLE,
  submitCandidatePrivacyRequest,
} from "./candidate-privacy-request.js"

test("submitCandidatePrivacyRequest targets the S9 callable with trimmed detail text", async () => {
  const calls: Array<{ name: string; data: unknown }> = []
  const result = await submitCandidatePrivacyRequest(
    async (name, data) => {
      calls.push({ name, data })
      return {
        ok: true,
        candidateId: "cand-1",
        requestId: "privacy_request_delete__abc",
        kind: data.kind,
        status: "submitted",
        created: true,
        existingOpen: false,
      }
    },
    {
      kind: "delete",
      detailText: "  please delete my account  ",
    }
  )

  assert.equal(result.ok, true)
  assert.equal(calls[0]!.name, CANDIDATE_PRIVACY_REQUEST_CALLABLE)
  assert.deepEqual(calls[0]!.data, {
    kind: "delete",
    detailText: "please delete my account",
    sourceSurface: "me_profile",
  })
})

test("submitCandidatePrivacyRequest allows request-only stop outreach without detail text", async () => {
  const calls: Array<{ name: string; data: unknown }> = []
  await submitCandidatePrivacyRequest(
    async (name, data) => {
      calls.push({ name, data })
      return {
        ok: true,
        candidateId: "cand-1",
        requestId: "privacy_request_stop_outreach__abc",
        kind: data.kind,
        status: "submitted",
        created: true,
        existingOpen: false,
      }
    },
    { kind: "stop_outreach", detailText: "   " }
  )

  assert.deepEqual(calls[0]!.data, {
    kind: "stop_outreach",
    sourceSurface: "me_profile",
  })
})
