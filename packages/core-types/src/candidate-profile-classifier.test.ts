import assert from "node:assert/strict"
import test from "node:test"

import {
  classifyCandidateProfile,
  deriveCandidateSource,
  isRealCandidateAccount,
} from "./candidate-profile-classifier.js"

test("candidate profile classifier keeps real claimed iMessage candidates in scope", () => {
  const doc = {
    id: "U7AwKT8nLDRa35DkuBxq",
    phoneE164: "+14243201960",
    email: "candidate@gmail.com",
    signupSource: "identity:candidate",
    candidateLifecycleState: "claimed",
    latestResumeArtifactId: "candidate_upload_U7AwKT8nLDRa35DkuBxq_e0f213",
  }
  const source = deriveCandidateSource(doc)
  assert.equal(source, "imessage")
  assert.equal(classifyCandidateProfile(source, doc), "candidate_account")
  assert.equal(isRealCandidateAccount(doc), true)
})

test("candidate profile classifier preserves public job as the initial signup source", () => {
  const doc = {
    id: "candidate-from-job",
    email: "candidate@gmail.com",
    phoneE164: "+14243201960",
    candidateLifecycleState: "claimed",
    firstSignupEntry: {
      kind: "job_prescreen",
      path: "/j/wekruit-37429d02-photon-macos-devops",
      jobId: "wekruit-37429d02-photon-macos-devops",
      source: "candidate",
      capturedAt: "2026-05-30T00:00:00.000Z",
    },
  }
  const source = deriveCandidateSource(doc)
  assert.equal(source, "public_job")
  assert.equal(classifyCandidateProfile(source, doc), "candidate_account")
})

test("candidate profile classifier preserves layoffhedge partner source", () => {
  const doc = {
    id: "candidate-from-layoffhedge",
    email: "candidate@gmail.com",
    phoneE164: "+14243201960",
    candidateLifecycleState: "claimed",
    source: "layoffhedge",
  }
  const source = deriveCandidateSource(doc)
  assert.equal(source, "layoffhedge")
  assert.equal(classifyCandidateProfile(source, doc), "candidate_account")
})

test("candidate profile classifier excludes demo, synthetic, internal, external, and incomplete rows", () => {
  const cases = [
    {
      id: "demo_layoff_025",
      phoneE164: "+1555000025",
      source: "WeKruit_Laid_Off",
      isDemo: true,
    },
    { id: "verify-nl-judge-laid-off", testMode: true },
    {
      id: "operator",
      email: "admin@wekruit.com",
      candidateLifecycleState: "claimed",
      latestResumeArtifactId: "operator-upload",
    },
    {
      id: "external-1",
      signupSource: "external_sourcing:manual_csv",
      candidateLifecycleState: "prospect",
    },
    {
      id: "empty-shell",
      signupSource: "identity:candidate",
      candidateLifecycleState: "claimed",
    },
  ]

  for (const doc of cases) {
    assert.equal(isRealCandidateAccount(doc), false, `expected ${doc.id} to be excluded`)
  }
})
