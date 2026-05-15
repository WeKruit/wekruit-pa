/**
 * v2.1 S1B — `loadJobBriefForVoice` unit tests.
 *
 * Covers the 3-case contract: happy, missing, partial.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { MockFirestore, asFirestore } from "../../../job-rec/__tests__/mock-firestore.js"
import { loadJobBriefForVoice } from "../load-job-brief.js"
import { NotFoundError } from "../types.js"

describe("loadJobBriefForVoice — happy path", () => {
  it("returns full projection with empty missingFields", async () => {
    const mfs = new MockFirestore()
    await mfs
      .collection("matching-jobs")
      .doc("j_full_001")
      .set({
        jobTitle: "Staff Software Engineer",
        companyName: "Stripe",
        roleFunction: ["software_engineering"],
        industrySector: ["financial_technology"],
        seniorityLevel: "staff",
        salaryMin: 220000,
        salaryMax: 320000,
        locationRaw: "South San Francisco, CA",
        locationBuckets: ["san_francisco_bay_area"],
        jobType: "full_time",
        sponsorship: true,
        requiredSkills: ["typescript", "react", "graphql"],
        atsApplyUrl: "https://stripe.com/jobs/listing/swe-staff/12345",
        firstSeenAt: "2026-05-10T08:00:00Z",
        dead: false,
      })

    const out = await loadJobBriefForVoice(asFirestore(mfs), "j_full_001")

    assert.equal(out.jobId, "j_full_001")
    assert.equal(out.jobTitle, "Staff Software Engineer")
    assert.equal(out.companyName, "Stripe")
    assert.deepEqual(out.roleFunction, ["software_engineering"])
    assert.deepEqual(out.industrySector, ["financial_technology"])
    assert.equal(out.seniorityLevel, "staff")
    assert.equal(out.salaryMin, 220000)
    assert.equal(out.salaryMax, 320000)
    assert.equal(out.locationRaw, "South San Francisco, CA")
    assert.deepEqual(out.locationBuckets, ["san_francisco_bay_area"])
    assert.equal(out.jobType, "full_time")
    assert.equal(out.sponsorship, true)
    assert.deepEqual(out.requiredSkills, ["typescript", "react", "graphql"])
    assert.equal(out.atsApplyUrl, "https://stripe.com/jobs/listing/swe-staff/12345")
    assert.equal(out.firstSeenAt, "2026-05-10T08:00:00Z")
    assert.equal(out.dead, false)
    assert.deepEqual(out.missingFields, [])
  })

  it("falls back through title and company aliases like projectMatchingJob does", async () => {
    const mfs = new MockFirestore()
    await mfs
      .collection("matching-jobs")
      .doc("j_alias_001")
      .set({
        // no jobTitle / title — only roleTitle
        roleTitle: "Senior Designer",
        // no companyName — only companyDisplayName
        companyDisplayName: "Acme Co.",
        // globalTags fallback for industrySector and requiredSkills
        globalTags: {
          industrySector: ["consumer_internet"],
          skills: ["figma", "design_systems"],
        },
      })

    const out = await loadJobBriefForVoice(asFirestore(mfs), "j_alias_001")
    assert.equal(out.jobTitle, "Senior Designer")
    assert.equal(out.companyName, "Acme Co.")
    assert.deepEqual(out.industrySector, ["consumer_internet"])
    assert.deepEqual(out.requiredSkills, ["figma", "design_systems"])
  })
})

describe("loadJobBriefForVoice — missing doc", () => {
  it("throws NotFoundError with kind='job' when matching-jobs/{jobId} does not exist", async () => {
    const mfs = new MockFirestore()
    await assert.rejects(
      () => loadJobBriefForVoice(asFirestore(mfs), "j_missing"),
      (err: unknown) => {
        assert.ok(err instanceof NotFoundError, "expected NotFoundError")
        assert.equal(err.kind, "job")
        assert.equal(err.id, "j_missing")
        return true
      }
    )
  })
})

describe("loadJobBriefForVoice — partial doc", () => {
  it("returns title+company resolved and lists every absent canonical field", async () => {
    const mfs = new MockFirestore()
    // Only jobTitle + companyName present. All other canonical fields absent.
    await mfs
      .collection("matching-jobs")
      .doc("j_partial_001")
      .set({
        jobTitle: "Open Role",
        companyName: "Unknown Co",
      })

    const out = await loadJobBriefForVoice(asFirestore(mfs), "j_partial_001")

    assert.equal(out.jobTitle, "Open Role")
    assert.equal(out.companyName, "Unknown Co")
    // present → not missing
    assert.equal(out.missingFields.includes("jobTitle"), false)
    assert.equal(out.missingFields.includes("companyName"), false)

    for (const expected of [
      "roleFunction",
      "industrySector",
      "seniorityLevel",
      "salaryMin",
      "salaryMax",
      "locationRaw",
      "locationBuckets",
      "jobType",
      "sponsorship",
      "requiredSkills",
      "atsApplyUrl",
      "firstSeenAt",
    ]) {
      assert.ok(
        out.missingFields.includes(expected),
        `expected missingFields to include ${expected}; got ${JSON.stringify(out.missingFields)}`
      )
    }
  })
})
