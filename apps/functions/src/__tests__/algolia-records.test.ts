import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  toSubmissionRecord,
  toCandidateRecord,
  SUBMISSIONS_INDEX,
  CANDIDATES_INDEX,
} from "../algolia/algolia-records.js"
import { buildBatchRequests } from "../algolia/algolia-rest.js"

describe("toSubmissionRecord", () => {
  it("flattens the searchable + filterable fields and coerces createdAt", () => {
    const r = toSubmissionRecord("sub-1", {
      submitter: { name: "Rec One", email: "rec@x.com" },
      candidate: { name: "Joe Lee", email: "joe@x.com", link: "https://linkedin.com/in/joelee" },
      jobTitleSnapshot: "AI Builder (NYC)",
      companyLabelSnapshot: "Co. H",
      jobId: "job-9",
      status: "rejected",
      score: { hardChecked: 3, hardTotal: 4 },
      createdAt: { seconds: 1_700_000_000 },
      sheetSyncError: true,
    })
    assert.equal(r.objectID, "sub-1")
    assert.equal(r.candidateName, "Joe Lee")
    assert.equal(r.candidateEmail, "joe@x.com")
    assert.equal(r.submitterName, "Rec One")
    assert.equal(r.jobTitle, "AI Builder (NYC)")
    assert.equal(r.status, "rejected")
    assert.equal(r.hardChecked, 3)
    assert.equal(r.hardTotal, 4)
    assert.equal(r.sheetSyncError, true)
    assert.equal(r.createdAtMs, 1_700_000_000_000)
  })

  it("defaults status to 'new' and tolerates missing maps", () => {
    const r = toSubmissionRecord("sub-2", {})
    assert.equal(r.status, "new")
    assert.equal(r.candidateName, undefined)
    assert.equal(r.hardTotal, 0)
    assert.equal(r.createdAtMs, 0)
  })
})

describe("toCandidateRecord", () => {
  it("derives source/class/lifecycle and extracts skills via shared classifiers", () => {
    const r = toCandidateRecord("u1", {
      displayName: "Joe Lee",
      email: "joe@gmail.com",
      phoneE164: "+14155550123",
      candidateLifecycleState: "claimed",
      globalTags: { skills: ["React", { value: "TypeScript" }, ""] },
      experience: [{ company: "Cursor" }, { company: "Amazon" }],
      createdAt: 1_700_000_000_000,
    })
    assert.equal(r.objectID, "u1")
    assert.equal(r.displayName, "Joe Lee")
    assert.equal(r.lifecycle, "claimed")
    assert.equal(r.source, "imessage") // phone present
    assert.equal(r.candidateClass, "candidate_account")
    assert.deepEqual(r.skills, ["React", "TypeScript"])
    assert.deepEqual(r.companies, ["Cursor", "Amazon"])
  })

  it("flags an internal operator account", () => {
    const r = toCandidateRecord("u2", { email: "ops@wekruit.com", phoneE164: "+14155550124", candidateLifecycleState: "claimed" })
    assert.equal(r.candidateClass, "internal_operator_profile")
  })
})

describe("buildBatchRequests", () => {
  it("wraps objects in {action, body}", () => {
    const out = buildBatchRequests([{ objectID: "a" }, { objectID: "b" }], "updateObject")
    assert.equal(out.requests.length, 2)
    assert.equal(out.requests[0]!.action, "updateObject")
    assert.deepEqual(out.requests[0]!.body, { objectID: "a" })
  })
})

describe("index names", () => {
  it("are the agreed indexes", () => {
    assert.equal(SUBMISSIONS_INDEX, "pa_recruiter_submissions")
    assert.equal(CANDIDATES_INDEX, "pa_candidates")
  })
})
