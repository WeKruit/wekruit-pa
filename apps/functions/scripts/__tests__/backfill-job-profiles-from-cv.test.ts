/**
 * Stream H1 — backfill-job-profiles-from-cv unit tests.
 *
 * No live Firestore. We inject a hand-rolled FsPort (the same shape the
 * live runner uses) and assert: derived shape, write call counts, skip
 * behaviour. Pattern matches scripts/__tests__/enrich-matching-jobs.test.ts.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  parseArgs,
  deriveJobProfileFromCv,
  runBackfill,
  type FsPort,
  type ParsedResumeRow,
} from "../backfill-job-profiles-from-cv.js"

// ---- helpers ---------------------------------------------------------------

function makeFakeFs(opts: {
  resumes?: Record<string, ParsedResumeRow>
  profiles?: Record<string, Record<string, unknown>>
  allowlist?: string[]
  allWithCv?: string[]
}) {
  const writes: Array<{ userId: string; doc: Record<string, unknown> }> = []
  const profiles = { ...(opts.profiles ?? {}) }
  const fs: FsPort = {
    async loadLatestResume(userId) {
      return opts.resumes?.[userId] ?? null
    },
    async loadJobProfile(userId) {
      return profiles[userId] ?? null
    },
    async writeJobProfile(userId, doc) {
      writes.push({ userId, doc })
      profiles[userId] = doc
    },
    async loadAllowlist() {
      return opts.allowlist ?? []
    },
    async loadAllUsersWithCv() {
      return opts.allWithCv ?? []
    },
  }
  return { fs, writes, profiles }
}

function makeRow(over: Partial<ParsedResumeRow> & { userId: string }): ParsedResumeRow {
  return {
    resumeId: "rsm_default",
    parsedAt: "2026-04-30T00:00:00.000Z",
    location: "San Francisco, CA",
    industryTags: ["tech_software"],
    ...over,
  }
}

// ---- parseArgs -------------------------------------------------------------

describe("backfill-job-profiles-from-cv :: parseArgs", () => {
  it("no args → defaults to --from-allowlist", () => {
    const a = parseArgs([])
    assert.equal(a.fromAllowlist, true)
    assert.equal(a.allWithCv, false)
    assert.equal(a.dryRun, false)
    assert.equal(a.force, false)
    assert.deepEqual(a.users, [])
  })
  it("--user=X --user=Y --dry-run --force parses cleanly", () => {
    const a = parseArgs(["--user=u1", "--user=u2", "--dry-run", "--force"])
    assert.deepEqual(a.users, ["u1", "u2"])
    assert.equal(a.fromAllowlist, false)
    assert.equal(a.dryRun, true)
    assert.equal(a.force, true)
  })
  it("--all-with-cv overrides default", () => {
    const a = parseArgs(["--all-with-cv"])
    assert.equal(a.allWithCv, true)
    assert.equal(a.fromAllowlist, false)
  })
})

// ---- deriveJobProfileFromCv ------------------------------------------------

describe("backfill-job-profiles-from-cv :: deriveJobProfileFromCv", () => {
  it("preserves canonical industry tags 1..3 in resume order", () => {
    const out = deriveJobProfileFromCv(
      makeRow({
        userId: "u1",
        industryTags: ["fintech_finance", "ai_ml", "tech_software", "consumer_retail"],
      })
    )
    // 4 input → 3 cap.
    assert.deepEqual(out.industryTags, ["fintech_finance", "ai_ml", "tech_software"])
  })
  it("falls back to ['other'] when no canonical tags present", () => {
    const out = deriveJobProfileFromCv(
      makeRow({ userId: "u1", industryTags: ["weird_made_up", "junk"] })
    )
    assert.deepEqual(out.industryTags, ["other"])
  })
  it("uses 'anywhere' when CV location empty", () => {
    const out = deriveJobProfileFromCv(makeRow({ userId: "u1", location: "  " }))
    assert.equal(out.locationPreference, "anywhere")
  })
  it("defaults sponsorshipNeeded='H1B', sizePreference='any', salaryMin=null", () => {
    const out = deriveJobProfileFromCv(makeRow({ userId: "u1" }))
    assert.equal(out.sponsorshipNeeded, "H1B")
    assert.equal(out.sizePreference, "any")
    assert.equal(out.salaryMin, null)
  })
  it("dedupes industryTags preserving first-seen order", () => {
    const out = deriveJobProfileFromCv(
      makeRow({
        userId: "u1",
        industryTags: ["tech_software", "tech_software", "ai_ml", "ai_ml"],
      })
    )
    assert.deepEqual(out.industryTags, ["tech_software", "ai_ml"])
  })
})

// ---- runBackfill (3 required tests) ---------------------------------------

describe("backfill-job-profiles-from-cv :: runBackfill scenarios (H1 brief)", () => {
  // ---- Test 1: 1 userId with parsedCandidateResumes row → produces correct
  // shape, calls write -----------------------------------------------------
  it("test 1 — userId WITH parsedCandidateResumes → 1 write with NEW shape", async () => {
    const { fs, writes } = makeFakeFs({
      resumes: {
        u1: makeRow({
          userId: "u1",
          resumeId: "rsm_u1",
          industryTags: ["tech_software"],
          location: "湾区",
        }),
      },
    })
    const result = await runBackfill(
      { users: ["u1"], fromAllowlist: false, allWithCv: false, dryRun: false, force: false },
      fs,
      () => {},
      () => "2026-05-01T22:00:00.000Z"
    )

    assert.equal(result.scanned, 1)
    assert.equal(result.written, 1)
    assert.equal(result.skippedNoResume, 0)
    assert.equal(result.skippedAlreadyExists, 0)
    assert.equal(result.errors, 0)
    assert.equal(writes.length, 1, "exactly one Firestore write")

    const w = writes[0]!
    assert.equal(w.userId, "u1")
    // Status active so daily-batch loads it.
    assert.equal(w.doc.status, "active")
    // NEW-shape profile fields.
    const profile = w.doc.profile as Record<string, unknown>
    assert.deepEqual(profile.industryTags, ["tech_software"])
    assert.equal(profile.sponsorshipNeeded, "H1B")
    assert.equal(profile.locationPreference, "湾区")
    assert.equal(profile.sizePreference, "any")
    assert.equal(profile.salaryMin, null)
    // Audit fields landed.
    assert.equal(w.doc.backfillSource, "backfill-job-profiles-from-cv")
    assert.equal(w.doc.backfillResumeId, "rsm_u1")
    // createdAt = updatedAt on first write.
    assert.equal(w.doc.createdAt, "2026-05-01T22:00:00.000Z")
    assert.equal(w.doc.updatedAt, "2026-05-01T22:00:00.000Z")
    assert.equal(w.doc.lastJobBatchSentAt, null)
  })

  // ---- Test 2: 1 userId with NO parsedCandidateResumes → skipped, no write -
  it("test 2 — userId WITHOUT parsedCandidateResumes → skipped, 0 writes", async () => {
    const { fs, writes } = makeFakeFs({
      // no resumes registered
    })
    const result = await runBackfill(
      { users: ["uMissing"], fromAllowlist: false, allWithCv: false, dryRun: false, force: false },
      fs
    )

    assert.equal(result.scanned, 1)
    assert.equal(result.written, 0)
    assert.equal(result.skippedNoResume, 1)
    assert.equal(writes.length, 0, "no writes when resume missing")
    assert.equal(result.perUser[0]!.status, "skip_no_resume")
  })

  // ---- Test 3: 3 userIds, 2 with resume + 1 without → 2 writes, 1 skip ----
  it("test 3 — 3 userIds, 2 with resume + 1 without → 2 writes, 1 skip", async () => {
    const { fs, writes } = makeFakeFs({
      resumes: {
        adam: makeRow({
          userId: "adam",
          resumeId: "rsm_adam",
          industryTags: ["tech_software", "ai_ml"],
          location: "San Francisco, CA",
        }),
        bob: makeRow({
          userId: "bob",
          resumeId: "rsm_bob",
          industryTags: ["fintech_finance"],
          location: "NYC",
        }),
        // 'carol' deliberately omitted
      },
    })
    const result = await runBackfill(
      {
        users: ["adam", "bob", "carol"],
        fromAllowlist: false,
        allWithCv: false,
        dryRun: false,
        force: false,
      },
      fs
    )

    assert.equal(result.scanned, 3)
    assert.equal(result.written, 2)
    assert.equal(result.skippedNoResume, 1)
    assert.equal(result.skippedAlreadyExists, 0)
    assert.equal(writes.length, 2)
    const ids = writes.map((w) => w.userId).sort()
    assert.deepEqual(ids, ["adam", "bob"])
    // carol got skip_no_resume
    const carol = result.perUser.find((r) => r.userId === "carol")!
    assert.equal(carol.status, "skip_no_resume")
  })

  // ---- Bonus: existing profile guard (idempotency) — H1 hard constraint ----
  it("idempotency — existing profile + no --force → skipped, no write", async () => {
    const { fs, writes } = makeFakeFs({
      resumes: { u1: makeRow({ userId: "u1" }) },
      profiles: {
        u1: { userId: "u1", profile: { industryTags: ["ai_ml"] }, status: "active" },
      },
    })
    const result = await runBackfill(
      { users: ["u1"], fromAllowlist: false, allWithCv: false, dryRun: false, force: false },
      fs
    )
    assert.equal(result.skippedAlreadyExists, 1)
    assert.equal(writes.length, 0)
  })

  it("--from-allowlist sources users from FsPort.loadAllowlist", async () => {
    const { fs, writes } = makeFakeFs({
      resumes: { fromList: makeRow({ userId: "fromList" }) },
      allowlist: ["fromList"],
    })
    const result = await runBackfill(
      { users: [], fromAllowlist: true, allWithCv: false, dryRun: false, force: false },
      fs
    )
    assert.equal(result.scanned, 1)
    assert.equal(result.written, 1)
    assert.equal(writes.length, 1)
    assert.equal(writes[0]!.userId, "fromList")
  })

  it("--dry-run derives + reports but writes nothing", async () => {
    const { fs, writes } = makeFakeFs({
      resumes: { u1: makeRow({ userId: "u1" }) },
    })
    const result = await runBackfill(
      { users: ["u1"], fromAllowlist: false, allWithCv: false, dryRun: true, force: false },
      fs
    )
    assert.equal(writes.length, 0)
    assert.equal(result.written, 0)
    assert.equal(result.perUser[0]!.status, "would_write")
  })
})
