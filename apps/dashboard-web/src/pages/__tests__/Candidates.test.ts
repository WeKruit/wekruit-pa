import assert from "node:assert/strict"
import test from "node:test"

import {
  classifyCandidateProfile,
  deriveCandidateSource,
  isSyntheticTestProfile,
} from "../Candidates.helpers.js"

test("Candidates classifies explicit testMode users as synthetic", () => {
  assert.equal(
    isSyntheticTestProfile({
      id: "00860fb7-e245-42f6-852a-3ca48b96169a",
      phoneE164: "+19999990739",
      testMode: true,
    }),
    true
  )
})

test("Candidates classifies production verification docs as synthetic", () => {
  assert.equal(
    isSyntheticTestProfile({
      id: "verify-nl-judge-laid-off",
    }),
    true
  )
})

test("Candidates does not classify a normal candidate phone as synthetic", () => {
  assert.equal(
    isSyntheticTestProfile({
      id: "U7AwKT8nLDRa35DkuBxq",
      phoneE164: "+14243201960",
      email: "indolencorlol@gmail.com",
    }),
    false
  )
})

test("Candidates treats the logged-in Adam profile as a candidate account", () => {
  const doc = {
    id: "U7AwKT8nLDRa35DkuBxq",
    phoneE164: "+14243201960",
    email: "indolencorlol@gmail.com",
    signupSource: "identity:candidate",
    candidateLifecycleState: "claimed",
    latestResumeArtifactId: "candidate_upload_U7AwKT8nLDRa35DkuBxq_e0f213",
  }
  const source = deriveCandidateSource(doc)
  assert.equal(source, "imessage")
  assert.equal(classifyCandidateProfile(source, doc), "candidate_account")
})

test("Candidates excludes old phone-only SMS rows from candidate accounts", () => {
  const doc = {
    id: "1cf453d9-de4d-4ea6-a33c-4c59ea229ad2",
    phoneE164: "+14245552001",
    onboardingStatus: "active",
  }
  const source = deriveCandidateSource(doc)
  assert.equal(source, "imessage")
  assert.equal(classifyCandidateProfile(source, doc), "legacy_sms_profile")
})

test("Candidates keeps mem0-only SMS rows as legacy profiles", () => {
  const doc = {
    id: "0afac25f-5a96-4527-8349-790b3adf82c4",
    phoneE164: "+19209739917",
    onboardingStatus: "active",
    mem0UserId: "0afac25f-5a96-4527-8349-790b3adf82c4",
  }
  const source = deriveCandidateSource(doc)
  assert.equal(source, "imessage")
  assert.equal(classifyCandidateProfile(source, doc), "legacy_sms_profile")
})

test("Candidates keeps Wekruit operator docs out of candidate account counts", () => {
  const doc = {
    id: "itYEwzaJjVPjWbN01fzk",
    email: "admin1@wekruit.com",
    candidateLifecycleState: "claimed",
    latestResumeArtifactId: "operator-upload",
  }
  const source = deriveCandidateSource(doc)
  assert.equal(source, "bulk_resume")
  assert.equal(classifyCandidateProfile(source, doc), "incomplete_identity_artifact")
})

test("Candidates keeps external supply prospects out of account counts", () => {
  const doc = {
    id: "d448e164-7d83-4191-812b-b1ec1cbd1f6f",
    signupSource: "external_sourcing:manual_csv",
    candidateLifecycleState: "prospect",
  }
  const source = deriveCandidateSource(doc)
  assert.equal(source, "manual_csv")
  assert.equal(classifyCandidateProfile(source, doc), "external_supply_prospect")
})

test("Candidates treats empty identity-created shells as incomplete artifacts", () => {
  const doc = {
    id: "REmvNNz52scHkfGZqxfp",
    signupSource: "identity:candidate",
    candidateLifecycleState: "claimed",
  }
  const source = deriveCandidateSource(doc)
  assert.equal(source, "unknown")
  assert.equal(classifyCandidateProfile(source, doc), "incomplete_identity_artifact")
})
