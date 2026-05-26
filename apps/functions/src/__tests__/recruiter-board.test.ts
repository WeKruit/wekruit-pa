/**
 * Unit tests for recruiter-board CFs.
 *
 * Covers:
 *   - `computeSubmissionScore` (group counting)
 *   - `isHiringBoardAdmin` (`@wekruit.com` domain gating)
 *   - `fetchCollabJobs` admin vs anonymous shape (publicId, anonymized company)
 *
 * The onRequest wrappers are exercised by the live smoke deploy.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  computeSubmissionScore,
  fetchCollabJobs,
  isHiringBoardAdmin,
  type RecruiterBoardChecklistGroup,
  type RecruiterBoardPayload,
} from "../recruiter-board.js"

// ─────────────────────────────────────────────────────────────────────────────
// computeSubmissionScore (existing coverage, kept in the canonical path)
// ─────────────────────────────────────────────────────────────────────────────

const sampleGroups: RecruiterBoardChecklistGroup[] = [
  { kind: "hard", heading: "Hard", items: [
    { id: "h1", text: "" },
    { id: "h2", text: "" },
    { id: "h3", text: "" },
  ] },
  { kind: "fit", heading: "Fit", items: [
    { id: "f1", text: "" },
    { id: "f2", text: "" },
  ] },
  { kind: "bonus", heading: "Bonus", items: [
    { id: "b1", text: "" },
  ] },
  { kind: "anti", heading: "Anti", items: [
    { id: "a1", text: "" },
    { id: "a2", text: "" },
  ] },
]

describe("computeSubmissionScore", () => {
  it("counts checked items per group", () => {
    const score = computeSubmissionScore(sampleGroups, {
      h1: true, h2: false, h3: true,
      f1: true, f2: true,
      b1: false,
      a1: true, a2: false,
    })
    assert.equal(score.hardChecked, 2)
    assert.equal(score.hardTotal, 3)
    assert.equal(score.fitChecked, 2)
    assert.equal(score.fitTotal, 2)
    assert.equal(score.bonusChecked, 0)
    assert.equal(score.bonusTotal, 1)
    assert.equal(score.antiChecked, 1)
    assert.equal(score.antiTotal, 2)
  })

  it("treats missing item ids as unchecked", () => {
    const score = computeSubmissionScore(sampleGroups, {})
    assert.equal(score.hardChecked, 0)
    assert.equal(score.hardTotal, 3)
    assert.equal(score.fitChecked, 0)
    assert.equal(score.bonusChecked, 0)
    assert.equal(score.antiChecked, 0)
  })

  it("ignores unknown checklist keys", () => {
    const score = computeSubmissionScore(sampleGroups, {
      h1: true,
      unknown_key: true,
    })
    assert.equal(score.hardChecked, 1)
    assert.equal(score.hardTotal, 3)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// isHiringBoardAdmin (Bearer-token + @wekruit.com gating)
// ─────────────────────────────────────────────────────────────────────────────

describe("isHiringBoardAdmin", () => {
  it("returns false when Authorization header is missing", async () => {
    assert.equal(
      await isHiringBoardAdmin({ headers: {} }, async () => ({ email: "x@wekruit.com" })),
      false,
    )
  })

  it("returns false when Authorization header is malformed (no Bearer prefix)", async () => {
    assert.equal(
      await isHiringBoardAdmin(
        { headers: { authorization: "Basic abc" } },
        async () => ({ email: "x@wekruit.com" }),
      ),
      false,
    )
  })

  it("returns false when Bearer token is empty", async () => {
    assert.equal(
      await isHiringBoardAdmin(
        { headers: { authorization: "Bearer " } },
        async () => ({ email: "x@wekruit.com" }),
      ),
      false,
    )
  })

  it("returns false when verifyIdToken throws (invalid/expired token)", async () => {
    assert.equal(
      await isHiringBoardAdmin(
        { headers: { authorization: "Bearer bad-token" } },
        async () => {
          throw new Error("token expired")
        },
      ),
      false,
    )
  })

  it("returns false for a non-@wekruit.com email", async () => {
    assert.equal(
      await isHiringBoardAdmin(
        { headers: { authorization: "Bearer ok" } },
        async () => ({ email: "stranger@example.com" }),
      ),
      false,
    )
  })

  it("returns false when the decoded token has no email", async () => {
    assert.equal(
      await isHiringBoardAdmin(
        { headers: { authorization: "Bearer ok" } },
        async () => ({}),
      ),
      false,
    )
  })

  it("returns true for admin1@wekruit.com", async () => {
    assert.equal(
      await isHiringBoardAdmin(
        { headers: { authorization: "Bearer ok" } },
        async () => ({ email: "admin1@wekruit.com" }),
      ),
      true,
    )
  })

  it("returns true for any @wekruit.com email", async () => {
    assert.equal(
      await isHiringBoardAdmin(
        { headers: { authorization: "Bearer ok" } },
        async () => ({ email: "someone@wekruit.com" }),
      ),
      true,
    )
  })

  it("is case-insensitive on the email domain", async () => {
    assert.equal(
      await isHiringBoardAdmin(
        { headers: { authorization: "Bearer ok" } },
        async () => ({ email: "Adam@WeKruit.com" }),
      ),
      true,
    )
  })

  it("does not match deceptively-similar domains", async () => {
    assert.equal(
      await isHiringBoardAdmin(
        { headers: { authorization: "Bearer ok" } },
        async () => ({ email: "evil@wekruit.com.attacker.io" }),
      ),
      false,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// fetchCollabJobs — admin vs anonymous payload shape
// ─────────────────────────────────────────────────────────────────────────────

interface FakeDoc {
  id: string
  data: () => Record<string, unknown>
}

function fakeDb(docs: FakeDoc[]): unknown {
  return {
    collection: () => ({
      where: () => ({
        get: async () => ({ docs }),
      }),
    }),
  }
}

const sampleRecruiterBoard: RecruiterBoardPayload = {
  active: true,
  sortOrder: 1,
  label: {
    company: "Helium Robotics, Inc.",
    companyCode: "A",
    location: "Remote / SF",
    pills: [{ text: "Series A" }],
  },
  culture: { bet: "Robots eat the world", bullets: ["fast"] },
  checklist: { groups: [] },
  interviewProcess: "1) phone 2) onsite",
}

const sampleAnonymizedBoard: RecruiterBoardPayload = {
  ...sampleRecruiterBoard,
  label: {
    ...sampleRecruiterBoard.label,
    company: "Co. A · early-stage AI infra startup",
  },
}

describe("fetchCollabJobs admin payload", () => {
  it("returns real doc id + full company name when isAdmin === true", async () => {
    const db = fakeDb([
      {
        id: "helium-product-engineer-fullstack",
        data: () => ({
          title: "Product Engineer (Fullstack)",
          publicId: "11111111-2222-3333-4444-555555555555",
          recruiterBoard: sampleRecruiterBoard,
        }),
      },
    ])
    const jobs = await fetchCollabJobs(db as never, { isAdmin: true })
    assert.equal(jobs.length, 1)
    assert.equal(jobs[0]!.jobId, "helium-product-engineer-fullstack")
    assert.equal(jobs[0]!.recruiterBoard.label.company, "Helium Robotics, Inc.")
  })
})

describe("fetchCollabJobs anonymous payload", () => {
  it("returns publicId as jobId and never the real company name when isAdmin === false", async () => {
    const db = fakeDb([
      {
        id: "helium-product-engineer-fullstack",
        data: () => ({
          title: "Product Engineer (Fullstack)",
          publicId: "11111111-2222-3333-4444-555555555555",
          recruiterBoard: sampleRecruiterBoard,
        }),
      },
    ])
    const jobs = await fetchCollabJobs(db as never, { isAdmin: false })
    assert.equal(jobs.length, 1)
    assert.equal(jobs[0]!.jobId, "11111111-2222-3333-4444-555555555555")
    // Real company string must NOT leak.
    assert.notEqual(jobs[0]!.recruiterBoard.label.company, "Helium Robotics, Inc.")
    assert.ok(
      !jobs[0]!.recruiterBoard.label.company.toLowerCase().includes("helium"),
      `company label must not contain "helium" but was ${jobs[0]!.recruiterBoard.label.company}`,
    )
    // Anonymized fallback uses "Co. <companyCode>" shape.
    assert.match(jobs[0]!.recruiterBoard.label.company, /^Co\.\s/)
  })

  it("preserves an already-anonymized company label as-is", async () => {
    const db = fakeDb([
      {
        id: "anon-job",
        data: () => ({
          title: "Senior Engineer",
          publicId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          recruiterBoard: sampleAnonymizedBoard,
        }),
      },
    ])
    const jobs = await fetchCollabJobs(db as never, { isAdmin: false })
    assert.equal(jobs.length, 1)
    assert.equal(jobs[0]!.jobId, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
    assert.equal(
      jobs[0]!.recruiterBoard.label.company,
      "Co. A · early-stage AI infra startup",
    )
  })

  it("falls back to the Firestore doc id when publicId hasn't been backfilled yet", async () => {
    const db = fakeDb([
      {
        id: "legacy-job-no-publicid",
        data: () => ({
          title: "Legacy",
          // publicId intentionally absent
          recruiterBoard: sampleRecruiterBoard,
        }),
      },
    ])
    const jobs = await fetchCollabJobs(db as never, { isAdmin: false })
    assert.equal(jobs.length, 1)
    // Without publicId we can't anonymize the URL, but the company label is
    // still scrubbed.
    assert.equal(jobs[0]!.jobId, "legacy-job-no-publicid")
    assert.notEqual(jobs[0]!.recruiterBoard.label.company, "Helium Robotics, Inc.")
  })

  it("skips inactive recruiter-board entries regardless of isAdmin", async () => {
    const db = fakeDb([
      {
        id: "inactive",
        data: () => ({
          title: "x",
          publicId: "pub-1",
          recruiterBoard: { ...sampleRecruiterBoard, active: false },
        }),
      },
      {
        id: "missing-rb",
        data: () => ({ title: "y" }),
      },
    ])
    assert.equal((await fetchCollabJobs(db as never, { isAdmin: false })).length, 0)
    assert.equal((await fetchCollabJobs(db as never, { isAdmin: true })).length, 0)
  })

  it("defaults isAdmin to false when no options arg is given", async () => {
    const db = fakeDb([
      {
        id: "helium-product-engineer-fullstack",
        data: () => ({
          title: "x",
          publicId: "11111111-2222-3333-4444-555555555555",
          recruiterBoard: sampleRecruiterBoard,
        }),
      },
    ])
    const jobs = await fetchCollabJobs(db as never)
    assert.equal(jobs[0]!.jobId, "11111111-2222-3333-4444-555555555555")
    assert.notEqual(jobs[0]!.recruiterBoard.label.company, "Helium Robotics, Inc.")
  })
})
