/**
 * Unit tests for recruiter-board CFs (new `recruiter-board` codebase).
 *
 * Covers:
 *   - `computeSubmissionScore` (group counting)
 *   - `isHiringBoardAdmin` (`@wekruit.com` domain gating)
 *   - `fetchCollabJobs` admin vs anonymous shape (publicId, anonymized company)
 *   - Pagination (limit/offset, nextOffset)
 *   - `?since` ISO date filter
 *   - `?status=open|filled` filter
 *   - `Idempotency-Key` header dedupe (live POST coverage is in the smoke deploy;
 *     here we only assert the validator + key allowlist behavior)
 *
 * The onRequest wrappers are exercised by the live smoke deploy.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  buildRecruiterRoleIntelligence,
  computeSubmissionScore,
  composeRecruiterRoleNotificationEmail,
  defaultRecruiterInviteCodeExpiresAt,
  fetchCollabJobs,
  generateRecruiterInviteCode,
  hashRecruiterCandidateLink,
  hashRecruiterInviteCode,
  isHiringBoardAdmin,
  normalizeRecruiterCandidateLink,
  inviteCodeUsable,
  normalizeRecruiterInviteCode,
  recruiterInviteCodeMatchesBoundUser,
  recruiterIdentityFromFirebaseBearer,
  shouldNotifyRecruitersForRoleRelease,
  sanitizeSubmissionStatusHistory,
  validateInviteCodeCreate,
  validateRecruiterRoleFeedbackInput,
  validateRecruiterRoleQuestionInput,
  validateRecruiterSourcedCandidateInput,
  validateRecruiterWorkspacePreferences,
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

describe("sanitizeSubmissionStatusHistory", () => {
  it("keeps recruiter-safe status history and drops malformed entries", () => {
    assert.deepEqual(sanitizeSubmissionStatusHistory([
      { status: " submitted ", by: "recruiter", atIso: "2026-05-30T12:00:00Z" },
      { status: "reviewing", by: "admin", atIso: "bad-date", note: "Internal note".repeat(200) },
      { by: "admin" },
      null,
    ]), [
      { status: "submitted", by: "recruiter", atIso: "2026-05-30T12:00:00.000Z" },
      { status: "reviewing", by: "admin", note: "Internal note".repeat(200).slice(0, 1000) },
    ])
  })
})

describe("recruiter access helpers", () => {
  it("normalizes invite codes without changing the visible code contract", () => {
    assert.equal(normalizeRecruiterInviteCode(" wk-7k2p "), "WK-7K2P")
    assert.equal(normalizeRecruiterInviteCode("wk 7k2p"), "WK7K2P")
  })

  it("hashes invite codes", () => {
    assert.equal(hashRecruiterInviteCode("WK-7K2P").length, 64)
  })

  it("generates visible invite codes in the WeKruit format", () => {
    assert.match(generateRecruiterInviteCode(), /^WK-[A-Z0-9]{4}-[A-Z0-9]{4}$/)
  })

  it("defaults recruiter invite codes to expire one year from creation", () => {
    assert.equal(
      defaultRecruiterInviteCodeExpiresAt(Date.parse("2026-05-31T12:00:00.000Z")),
      "2027-05-31T12:00:00.000Z",
    )
    const before = Date.now()
    const defaultCode = validateInviteCodeCreate({})
    const after = Date.now()
    assert.equal(defaultCode.ok, true)
    if (!defaultCode.ok) return
    const expiresAt = defaultCode.value.expiresAt
    assert.ok(expiresAt)
    const expiresAtMs = Date.parse(expiresAt)
    const min = new Date(before)
    min.setFullYear(min.getFullYear() + 1)
    const max = new Date(after)
    max.setFullYear(max.getFullYear() + 1)
    assert.ok(expiresAtMs >= min.getTime())
    assert.ok(expiresAtMs <= max.getTime())
  })

  it("forces recruiter invite codes to be single-use", () => {
    const defaultCode = validateInviteCodeCreate({})
    assert.equal(defaultCode.ok, true)
    if (defaultCode.ok) assert.equal(defaultCode.value.maxUses, 1)
    const explicitSingleUse = validateInviteCodeCreate({ maxUses: 1 })
    assert.equal(explicitSingleUse.ok, true)
    if (explicitSingleUse.ok) assert.equal(explicitSingleUse.value.maxUses, 1)
    assert.deepEqual(validateInviteCodeCreate({ maxUses: 2 }), {
      ok: false,
      reason: "invalid_max_uses",
    })
    assert.equal(inviteCodeUsable({ active: true, maxUses: 5, usedCount: 0 }, Date.now()), true)
    assert.equal(inviteCodeUsable({ active: true, maxUses: 5, usedCount: 1 }, Date.now()), false)
  })

  it("lets a bound recruiter reuse only their own access code with the same Google account", () => {
    const normalizedCode = normalizeRecruiterInviteCode("WK-CDKE-AUC5")
    const inviteCodeId = hashRecruiterInviteCode(normalizedCode)

    assert.equal(recruiterInviteCodeMatchesBoundUser({ inviteCodeId }, normalizedCode), true)
    assert.equal(recruiterInviteCodeMatchesBoundUser({ inviteCodeId }, "WK-OTHER-CODE"), false)
    assert.equal(recruiterInviteCodeMatchesBoundUser({}, normalizedCode), false)
  })

  it("validates primary role slots for recruiter workspaces", () => {
    assert.deepEqual(validateRecruiterWorkspacePreferences({
      primaryRoleIds: [" role-1 ", "role-2", "role-1"],
    }), {
      ok: true,
      value: { primaryRoleIds: ["role-1", "role-2"] },
    })
    assert.deepEqual(validateRecruiterWorkspacePreferences({
      primaryRoleIds: ["a", "b", "c", "d", "e", "f"],
    }), {
      ok: false,
      reason: "too_many_primary_roles",
    })
    assert.deepEqual(validateRecruiterWorkspacePreferences({
      primaryRoleIds: ["role-1", 123],
    }), {
      ok: false,
      reason: "invalid_primary_role_ids",
    })
  })

  it("binds recruiter API identity to Firebase Auth uid and normalized email", async () => {
    const identity = await recruiterIdentityFromFirebaseBearer(
      { headers: { authorization: "Bearer firebase-id-token" } },
      async (token) => {
        assert.equal(token, "firebase-id-token")
        return { uid: "firebase-uid-123", email: "Sloane@Agency.com" }
      },
    )

    assert.deepEqual(identity, {
      uid: "firebase-uid-123",
      email: "sloane@agency.com",
    })
  })

  it("rejects malformed recruiter Firebase bearer tokens", async () => {
    assert.equal(
      await recruiterIdentityFromFirebaseBearer(
        { headers: { authorization: "Bearer old-recruiter-id:local-token" } },
        async () => ({ uid: "firebase-uid-123", email: "sloane@agency.com" }),
      ),
      null,
    )
  })
})

describe("recruiter role intelligence", () => {
  it("aggregates role-level signal without exposing candidate rows", () => {
    const [role] = buildRecruiterRoleIntelligence(
      [{ jobId: "public-role-1", aliases: ["real-role-1", "public-role-1"] }],
      "recruiter-a",
      {
        sourcedCandidates: [
          { jobId: "real-role-1", recruiterId: "recruiter-a", stage: "ready", updatedAt: "2026-06-01T10:00:00.000Z" },
          { inboundJobId: "public-role-1", recruiterId: "recruiter-b", stage: "sourced", updatedAt: "2026-06-01T11:00:00.000Z" },
          { jobId: "other-role", recruiterId: "recruiter-c", stage: "ready" },
        ],
        submissions: [
          { jobId: "real-role-1", recruiterId: "recruiter-a", status: "submitted", createdAt: "2026-06-01T12:00:00.000Z" },
          { inboundJobId: "public-role-1", recruiterId: "recruiter-b", status: "advanced", createdAt: "2026-06-01T13:00:00.000Z" },
          { jobId: "real-role-1", recruiterId: "recruiter-c", status: "duplicate", createdAt: "2026-06-01T14:00:00.000Z" },
        ],
        feedback: [
          { jobId: "real-role-1", recruiterId: "recruiter-a", difficulty: "hard", reasons: ["low_comp", "small_candidate_pool"] },
          { inboundJobId: "public-role-1", recruiterId: "recruiter-b", difficulty: "blocked", reasons: ["low_comp"] },
        ],
        questions: [
          { jobId: "real-role-1", recruiterId: "recruiter-a", status: "open" },
          { inboundJobId: "public-role-1", recruiterId: "recruiter-b", status: "answered" },
        ],
      },
    )

    assert.equal(role?.jobId, "public-role-1")
    assert.equal(role?.sourcedCount, 2)
    assert.equal(role?.readyCount, 1)
    assert.equal(role?.submissionCount, 3)
    assert.equal(role?.pendingCount, 1)
    assert.equal(role?.advancedCount, 1)
    assert.equal(role?.duplicateCount, 1)
    assert.equal(role?.recruiterCount, 3)
    assert.equal(role?.openQuestionCount, 1)
    assert.equal(role?.answeredQuestionCount, 1)
    assert.deepEqual(role?.feedback.topReasons[0], { reason: "low_comp", count: 2 })
    assert.deepEqual(role?.my, {
      sourcedCount: 1,
      readyCount: 1,
      submissionCount: 1,
      pendingCount: 1,
    })
  })
})

describe("recruiter role notifications", () => {
  it("fires only when a collab role becomes active on the recruiter board", () => {
    assert.equal(shouldNotifyRecruitersForRoleRelease(null, {
      wekruitCollaborationStatus: "collaborated",
      recruiterBoard: { active: true },
    }), true)
    assert.equal(shouldNotifyRecruitersForRoleRelease({
      wekruitCollaborationStatus: "collaborated",
      recruiterBoard: { active: true },
    }, {
      wekruitCollaborationStatus: "collaborated",
      recruiterBoard: { active: true },
    }), false)
    assert.equal(shouldNotifyRecruitersForRoleRelease(null, {
      wekruitCollaborationStatus: "not_collaborated",
      recruiterBoard: { active: true },
    }), false)
  })

  it("composes a role email with the role link and opt-out language", () => {
    const email = composeRecruiterRoleNotificationEmail({
      recruiterName: "Sloane",
      roleTitle: "Founding Engineer",
      companyLabel: "Co. B",
      location: "San Francisco",
      roleUrl: "https://candidate.wekruit.com/recruiters/job/role-1",
    })
    assert.match(email.subject, /Founding Engineer/)
    assert.match(email.text, /candidate\.wekruit\.com/)
    assert.match(email.text, /turn off new-role emails/i)
  })
})

describe("recruiter sourced candidates", () => {
  it("normalizes candidate profile links before duplicate checks", () => {
    assert.equal(
      normalizeRecruiterCandidateLink(" HTTPS://www.LinkedIn.com/in/Ada-Lovelace/?trk=public_profile "),
      "linkedin.com/in/ada-lovelace",
    )
    assert.equal(
      hashRecruiterCandidateLink("https://linkedin.com/in/ada-lovelace").length,
      64,
    )
  })

  it("accepts a recruiter-sourced candidate and trims optional fields", () => {
    const result = validateRecruiterSourcedCandidateInput({
      jobId: " public-job-1 ",
      stage: "ready",
      candidate: {
        name: " Ada Lovelace ",
        link: " https://linkedin.com/in/ada ",
        currentRole: " Staff Engineer ",
        yoe: " 9 ",
        notes: " strong backend match ",
      },
    })

    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.value.jobId, "public-job-1")
    assert.equal(result.value.stage, "ready")
    assert.deepEqual(result.value.candidate, {
      name: "Ada Lovelace",
      link: "https://linkedin.com/in/ada",
      currentRole: "Staff Engineer",
      yoe: "9",
      notes: "strong backend match",
    })
  })

  it("rejects malformed sourced candidate payloads", () => {
    assert.deepEqual(validateRecruiterSourcedCandidateInput({}), {
      ok: false,
      reason: "missing_jobId",
    })
    assert.deepEqual(validateRecruiterSourcedCandidateInput({
      jobId: "job-1",
      candidate: { name: "Ada" },
    }), {
      ok: false,
      reason: "missing_candidate_link",
    })
    assert.deepEqual(validateRecruiterSourcedCandidateInput({
      candidateId: "../bad",
      jobId: "job-1",
      candidate: { name: "Ada", link: "https://linkedin.com/in/ada" },
    }), {
      ok: false,
      reason: "invalid_candidate_id",
    })
  })
})

describe("recruiter role feedback", () => {
  it("accepts role feedback with difficulty, reasons, and note", () => {
    const result = validateRecruiterRoleFeedbackInput({
      jobId: " public-job-1 ",
      difficulty: "blocked",
      reasons: ["small_candidate_pool", "low_comp", "small_candidate_pool"],
      note: " Candidate pool is thin below the current compensation range. ",
    })

    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(result.value, {
      jobId: "public-job-1",
      difficulty: "blocked",
      reasons: ["small_candidate_pool", "low_comp"],
      note: "Candidate pool is thin below the current compensation range.",
    })
  })

  it("rejects malformed role feedback payloads", () => {
    assert.deepEqual(validateRecruiterRoleFeedbackInput({}), {
      ok: false,
      reason: "missing_jobId",
    })
    assert.deepEqual(validateRecruiterRoleFeedbackInput({
      jobId: "job-1",
      difficulty: "impossible",
    }), {
      ok: false,
      reason: "invalid_difficulty",
    })
    assert.deepEqual(validateRecruiterRoleFeedbackInput({
      jobId: "job-1",
      difficulty: "hard",
      reasons: ["not_a_reason"],
    }), {
      ok: false,
      reason: "invalid_reasons",
    })
  })
})

describe("recruiter role questions", () => {
  it("accepts a role question for WeKruit calibration", () => {
    assert.deepEqual(validateRecruiterRoleQuestionInput({
      jobId: " role-123 ",
      question: "Can the hiring team consider candidates from Canada if they can work US hours?",
    }), {
      ok: true,
      value: {
        jobId: "role-123",
        question: "Can the hiring team consider candidates from Canada if they can work US hours?",
      },
    })
  })

  it("rejects malformed role question payloads", () => {
    assert.deepEqual(validateRecruiterRoleQuestionInput({ question: "Too short" }), {
      ok: false,
      reason: "missing_jobId",
    })
    assert.deepEqual(validateRecruiterRoleQuestionInput({ jobId: "role-123", question: "short" }), {
      ok: false,
      reason: "question_too_short",
    })
    assert.deepEqual(validateRecruiterRoleQuestionInput({ jobId: "role-123", question: "x".repeat(2001) }), {
      ok: false,
      reason: "question_too_long",
    })
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
// fetchCollabJobs — admin vs anonymous payload shape + pagination + filters
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
    const { jobs, total, nextOffset } = await fetchCollabJobs(db as never, { isAdmin: true })
    assert.equal(jobs.length, 1)
    assert.equal(jobs[0]!.jobId, "helium-product-engineer-fullstack")
    assert.equal(jobs[0]!.recruiterBoard.label.company, "Helium Robotics, Inc.")
    assert.equal(total, 1)
    assert.equal(nextOffset, null)
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
    const { jobs } = await fetchCollabJobs(db as never, { isAdmin: false })
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
    const { jobs } = await fetchCollabJobs(db as never, { isAdmin: false })
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
    const { jobs } = await fetchCollabJobs(db as never, { isAdmin: false })
    assert.equal(jobs.length, 1)
    // Without publicId we can't anonymize the URL, but the company label is
    // still scrubbed.
    assert.equal(jobs[0]!.jobId, "legacy-job-no-publicid")
    assert.notEqual(jobs[0]!.recruiterBoard.label.company, "Helium Robotics, Inc.")
  })

  it("skips inactive recruiter-board entries when status defaults to open", async () => {
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
    assert.equal((await fetchCollabJobs(db as never, { isAdmin: false })).jobs.length, 0)
    assert.equal((await fetchCollabJobs(db as never, { isAdmin: true })).jobs.length, 0)
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
    const { jobs } = await fetchCollabJobs(db as never)
    assert.equal(jobs[0]!.jobId, "11111111-2222-3333-4444-555555555555")
    assert.notEqual(jobs[0]!.recruiterBoard.label.company, "Helium Robotics, Inc.")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Pagination (limit / offset / nextOffset / total)
// ─────────────────────────────────────────────────────────────────────────────

function makeJobDoc(id: string, sortOrder: number, extra: Record<string, unknown> = {}): FakeDoc {
  return {
    id,
    data: () => ({
      title: id,
      publicId: `pub-${id}`,
      recruiterBoard: { ...sampleRecruiterBoard, sortOrder },
      ...extra,
    }),
  }
}

describe("fetchCollabJobs pagination", () => {
  it("returns full set with total when no limit is given", async () => {
    const db = fakeDb([
      makeJobDoc("c", 3),
      makeJobDoc("a", 1),
      makeJobDoc("b", 2),
    ])
    const { jobs, total, nextOffset } = await fetchCollabJobs(db as never)
    assert.equal(jobs.length, 3)
    assert.equal(total, 3)
    assert.equal(nextOffset, null)
    // Sorted by sortOrder.
    assert.equal(jobs[0]!.jobId, "pub-a")
    assert.equal(jobs[1]!.jobId, "pub-b")
    assert.equal(jobs[2]!.jobId, "pub-c")
  })

  it("respects limit and emits nextOffset when more pages remain", async () => {
    const db = fakeDb([
      makeJobDoc("a", 1),
      makeJobDoc("b", 2),
      makeJobDoc("c", 3),
      makeJobDoc("d", 4),
      makeJobDoc("e", 5),
    ])
    const result = await fetchCollabJobs(db as never, { isAdmin: false, limit: 2 })
    assert.equal(result.jobs.length, 2)
    assert.equal(result.total, 5)
    assert.equal(result.nextOffset, 2)
    assert.equal(result.jobs[0]!.jobId, "pub-a")
    assert.equal(result.jobs[1]!.jobId, "pub-b")
  })

  it("respects offset and returns null nextOffset on the last page", async () => {
    const db = fakeDb([
      makeJobDoc("a", 1),
      makeJobDoc("b", 2),
      makeJobDoc("c", 3),
    ])
    const result = await fetchCollabJobs(db as never, { isAdmin: false, limit: 2, offset: 2 })
    assert.equal(result.jobs.length, 1)
    assert.equal(result.total, 3)
    assert.equal(result.nextOffset, null)
    assert.equal(result.jobs[0]!.jobId, "pub-c")
  })

  it("clamps explicit limit above MAX_LIMIT (200) and never returns more than the cap", async () => {
    // Build 250 docs so we can prove the cap. Sort orders are unique so the
    // slice is deterministic.
    const docs: FakeDoc[] = []
    for (let i = 0; i < 250; i++) docs.push(makeJobDoc(`j${i}`, i))
    const db = fakeDb(docs)
    const result = await fetchCollabJobs(db as never, { isAdmin: false, limit: 1000 })
    assert.equal(result.jobs.length, 200)
    assert.equal(result.total, 250)
    assert.equal(result.nextOffset, 200)
  })

  it("handles offset >= total by returning an empty page", async () => {
    const db = fakeDb([makeJobDoc("a", 1)])
    const result = await fetchCollabJobs(db as never, { isAdmin: false, limit: 10, offset: 50 })
    assert.equal(result.jobs.length, 0)
    assert.equal(result.total, 1)
    assert.equal(result.nextOffset, null)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ?since filter
// ─────────────────────────────────────────────────────────────────────────────

describe("fetchCollabJobs since filter", () => {
  it("returns only jobs with recruiterBoard.updatedAt strictly greater than since", async () => {
    const db = fakeDb([
      makeJobDoc("old", 1, {
        recruiterBoard: { ...sampleRecruiterBoard, sortOrder: 1, updatedAt: "2026-01-01T00:00:00Z" },
      }),
      makeJobDoc("equal", 2, {
        recruiterBoard: { ...sampleRecruiterBoard, sortOrder: 2, updatedAt: "2026-05-01T00:00:00Z" },
      }),
      makeJobDoc("newer", 3, {
        recruiterBoard: { ...sampleRecruiterBoard, sortOrder: 3, updatedAt: "2026-05-15T00:00:00Z" },
      }),
    ])
    const { jobs, total } = await fetchCollabJobs(db as never, {
      isAdmin: false,
      since: "2026-05-01T00:00:00Z",
    })
    assert.equal(jobs.length, 1)
    assert.equal(total, 1)
    assert.equal(jobs[0]!.jobId, "pub-newer")
    assert.equal(jobs[0]!.updatedAt, "2026-05-15T00:00:00.000Z")
  })

  it("drops jobs without any updatedAt when since is set", async () => {
    const db = fakeDb([
      makeJobDoc("no-updated", 1),
      makeJobDoc("has-updated", 2, {
        recruiterBoard: { ...sampleRecruiterBoard, sortOrder: 2, updatedAt: "2099-01-01T00:00:00Z" },
      }),
    ])
    const { jobs } = await fetchCollabJobs(db as never, {
      isAdmin: false,
      since: "2026-01-01T00:00:00Z",
    })
    assert.equal(jobs.length, 1)
    assert.equal(jobs[0]!.jobId, "pub-has-updated")
  })

  it("throws invalid_since for an unparseable date", async () => {
    const db = fakeDb([makeJobDoc("a", 1)])
    await assert.rejects(
      fetchCollabJobs(db as never, { isAdmin: false, since: "not-a-date" }),
      /invalid_since/,
    )
  })

  it("uses doc-level updatedAt when recruiterBoard.updatedAt is missing", async () => {
    const db = fakeDb([
      makeJobDoc("doc-level", 1, { updatedAt: "2026-06-01T00:00:00Z" }),
    ])
    const { jobs } = await fetchCollabJobs(db as never, {
      isAdmin: false,
      since: "2026-01-01T00:00:00Z",
    })
    assert.equal(jobs.length, 1)
    assert.equal(jobs[0]!.updatedAt, "2026-06-01T00:00:00.000Z")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ?status=open|filled filter
// ─────────────────────────────────────────────────────────────────────────────

describe("fetchCollabJobs status filter", () => {
  it("status=open (default) returns only active jobs", async () => {
    const db = fakeDb([
      makeJobDoc("active1", 1, {
        recruiterBoard: { ...sampleRecruiterBoard, sortOrder: 1, active: true },
      }),
      makeJobDoc("inactive1", 2, {
        recruiterBoard: { ...sampleRecruiterBoard, sortOrder: 2, active: false },
      }),
    ])
    const { jobs } = await fetchCollabJobs(db as never, { isAdmin: false })
    assert.equal(jobs.length, 1)
    assert.equal(jobs[0]!.jobId, "pub-active1")
  })

  it("status=filled returns only inactive jobs", async () => {
    const db = fakeDb([
      makeJobDoc("active1", 1, {
        recruiterBoard: { ...sampleRecruiterBoard, sortOrder: 1, active: true },
      }),
      makeJobDoc("inactive1", 2, {
        recruiterBoard: { ...sampleRecruiterBoard, sortOrder: 2, active: false },
      }),
      makeJobDoc("inactive2", 3, {
        recruiterBoard: { ...sampleRecruiterBoard, sortOrder: 3, active: false },
      }),
    ])
    const { jobs, total } = await fetchCollabJobs(db as never, {
      isAdmin: false,
      status: "filled",
    })
    assert.equal(jobs.length, 2)
    assert.equal(total, 2)
    assert.equal(jobs[0]!.jobId, "pub-inactive1")
    assert.equal(jobs[1]!.jobId, "pub-inactive2")
  })
})
