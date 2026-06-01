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
  composeCandidateSubmissionConfirmationEmail,
  composeRecruiterRoleNotificationEmail,
  defaultRecruiterInviteCodeExpiresAt,
  fetchCollabJobs,
  generateRecruiterInviteCode,
  hashRecruiterCandidateEmail,
  hashRecruiterCandidateLink,
  hashRecruiterInviteCode,
  isHiringBoardAdmin,
  normalizeRecruiterCandidateEmail,
  normalizeRecruiterCandidateLink,
  inviteCodeUsable,
  normalizeRecruiterInviteCode,
  recruiterCandidateIdentityConflictForRole,
  recruiterInviteCodeMatchesBoundUser,
  recruiterIdentityFromFirebaseBearer,
  shouldNotifyRecruitersForRoleRelease,
  sanitizeSubmissionStatusHistory,
  validateCandidateConfirmationResendInput,
  validateInviteCodeCreate,
  validateInviteCodeReplace,
  validateInviteCodeRestore,
  validateRecruiterNotificationsReadInput,
  validateRecruiterRoleApplicationInput,
  validateRecruiterRoleFeedbackInput,
  validateRecruiterRoleQuestionInput,
  validateRecruiterSourcedCandidateInput,
  validateRecruiterWorkspacePreferences,
  validateSubmission,
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

  it("validates legacy invite-code replacement requests by hashed id", () => {
    const inviteCodeId = hashRecruiterInviteCode("WK-CDKE-AUC5")
    assert.deepEqual(validateInviteCodeReplace({ inviteCodeId }), {
      ok: true,
      value: { inviteCodeId },
    })
    assert.deepEqual(validateInviteCodeReplace({ inviteCodeId: "WK-CDKE-AUC5" }), {
      ok: false,
      reason: "invalid_invite_code_id",
    })
  })

  it("validates restoring a known raw code onto the matching hashed row", () => {
    const inviteCodeId = hashRecruiterInviteCode("WK-CDKE-AUC5")
    assert.deepEqual(validateInviteCodeRestore({ inviteCodeId, inviteCode: " wk-cdke-auc5 " }), {
      ok: true,
      value: { inviteCodeId, inviteCode: "WK-CDKE-AUC5" },
    })
    assert.deepEqual(validateInviteCodeRestore({ inviteCodeId, inviteCode: "not-a-wk-code" }), {
      ok: false,
      reason: "invalid_code",
    })
  })

  it("lets a bound recruiter reuse only their own access code with the same Google account", () => {
    const normalizedCode = normalizeRecruiterInviteCode("WK-CDKE-AUC5")
    const inviteCodeId = hashRecruiterInviteCode(normalizedCode)

    assert.equal(recruiterInviteCodeMatchesBoundUser({ inviteCodeId }, normalizedCode), true)
    assert.equal(recruiterInviteCodeMatchesBoundUser({ inviteCodeId }, "WK-OTHER-CODE"), false)
    assert.equal(recruiterInviteCodeMatchesBoundUser({}, normalizedCode), false)
  })

  it("sanitizes recruiter-visible submission rating history", () => {
    assert.deepEqual(sanitizeSubmissionStatusHistory([
      {
        status: "reviewing",
        by: "admin",
        atIso: "2026-06-01T12:00:00.000Z",
        note: "Strong candidate, keep sourcing this lane.",
        rating: 4,
        reasons: ["strong_match", "clear_evidence", "../bad"],
      },
      { status: "", rating: 9, reasons: ["ignored"] },
    ]), [
      {
        status: "reviewing",
        by: "admin",
        atIso: "2026-06-01T12:00:00.000Z",
        note: "Strong candidate, keep sourcing this lane.",
        rating: 4,
        reasons: ["strong_match", "clear_evidence"],
      },
    ])
  })

  it("validates approved role access limits for recruiter workspaces", () => {
    assert.deepEqual(validateRecruiterWorkspacePreferences({
      primaryRoleIds: [" role-1 ", "role-2", "role-1"],
    }), {
      ok: true,
      value: { primaryRoleIds: ["role-1", "role-2"] },
    })
    assert.equal(validateRecruiterWorkspacePreferences({
      primaryRoleIds: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
    }).ok, true)
    assert.deepEqual(validateRecruiterWorkspacePreferences({
      primaryRoleIds: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"],
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

describe("candidate confirmation resend", () => {
  it("validates recruiter-owned submission ids for confirmation resend", () => {
    assert.deepEqual(validateCandidateConfirmationResendInput({ submissionId: "sub_123" }), {
      ok: true,
      value: { submissionId: "sub_123" },
    })
    assert.deepEqual(validateCandidateConfirmationResendInput({ submissionId: "../bad" }), {
      ok: false,
      reason: "invalid_submission_id",
    })
    assert.deepEqual(validateCandidateConfirmationResendInput({}), {
      ok: false,
      reason: "missing_submission_id",
    })
  })
})

describe("recruiter role intelligence", () => {
  it("aggregates role-level signal and sanitizes candidate pipeline preview", () => {
    const [role] = buildRecruiterRoleIntelligence(
      [{ jobId: "public-role-1", aliases: ["real-role-1", "public-role-1"] }],
      "recruiter-a",
      {
        sourcedCandidates: [
          {
            jobId: "real-role-1",
            recruiterId: "recruiter-a",
            candidateId: "own-candidate-1",
            candidateLinkKey: "own-link",
            stage: "ready",
            candidate: { name: "Ada Lovelace", currentRole: "Backend Lead", yoe: "8 years", notes: "Knows graph infra." },
            updatedAt: "2026-06-01T10:00:00.000Z",
          },
          {
            inboundJobId: "public-role-1",
            recruiterId: "recruiter-b",
            candidateId: "market-candidate-1",
            candidateLinkKey: "market-link",
            stage: "sourced",
            candidate: { name: "Private Person", currentRole: "Staff AI Engineer", yoe: "6 years", notes: "email private@example.com" },
            updatedAt: "2026-06-01T11:00:00.000Z",
          },
          { jobId: "other-role", recruiterId: "recruiter-c", stage: "ready" },
        ],
        submissions: [
          {
            jobId: "real-role-1",
            recruiterId: "recruiter-a",
            sourcedCandidateId: "own-candidate-1",
            candidateLinkKey: "own-link",
            status: "submitted",
            candidate: { name: "Ada Lovelace", currentRole: "Backend Lead", yoe: "8 years", notes: "Candidate opted in." },
            createdAt: "2026-06-01T12:00:00.000Z",
          },
          {
            inboundJobId: "public-role-1",
            recruiterId: "recruiter-b",
            candidateLinkKey: "market-link",
            status: "advanced",
            candidate: { name: "Private Person", currentRole: "Staff AI Engineer", yoe: "6 years" },
            createdAt: "2026-06-01T13:00:00.000Z",
          },
          {
            jobId: "real-role-1",
            recruiterId: "recruiter-c",
            submissionId: "market-submission-2",
            status: "duplicate",
            candidate: { name: "Named Market Candidate", currentRole: "Founding Designer", yoe: "5 years" },
            createdAt: "2026-06-01T14:00:00.000Z",
          },
        ],
        feedback: [
          { jobId: "real-role-1", recruiterId: "recruiter-a", difficulty: "hard", reasons: ["low_comp", "small_candidate_pool"] },
          { inboundJobId: "public-role-1", recruiterId: "recruiter-b", difficulty: "blocked", reasons: ["low_comp"] },
        ],
        questions: [
          { jobId: "real-role-1", recruiterId: "recruiter-a", status: "open" },
          { inboundJobId: "public-role-1", recruiterId: "recruiter-b", status: "answered" },
        ],
        applications: [
          { jobId: "real-role-1", recruiterId: "recruiter-a", status: "approved", anonymizeCandidates: false },
          { inboundJobId: "public-role-1", recruiterId: "recruiter-b", status: "approved", anonymizeCandidates: true },
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
    assert.equal(role?.pipelinePreview.length, 3)
    assert.equal(role?.pipelinePreview[0]?.recruiterScope, "market")
    assert.equal(role?.pipelinePreview[0]?.candidateLabel, "Founding Designer")
    assert.equal(role?.pipelinePreview[0]?.candidateHeadline, "Founding Designer · 5 years exp")
    assert.equal(role?.pipelinePreview[1]?.candidateLabel, "Anonymized candidate")
    assert.equal(role?.pipelinePreview[1]?.anonymized, true)
    assert.equal(role?.pipelinePreview[1]?.candidateHeadline, "Background hidden by recruiter privacy setting.")
    assert.equal(role?.pipelinePreview[2]?.recruiterScope, "mine")
    assert.equal(role?.pipelinePreview[2]?.candidateLabel, "Ada Lovelace")
    assert.equal(role?.pipelinePreview.some((row) => row.candidateLabel === "Private Person"), false)
    assert.equal(role?.pipelinePreview.some((row) => `${row.candidateHeadline ?? ""} ${row.candidateSignal ?? ""}`.includes("private@example.com")), false)
  })

  it("caps pipeline preview to the latest six candidate identities", () => {
    const sourcedCandidates = Array.from({ length: 8 }, (_, index) => ({
      jobId: "real-role-1",
      recruiterId: `recruiter-${index}`,
      candidateId: `candidate-${index}`,
      stage: "sourced",
      candidate: { currentRole: `Role ${index}` },
      updatedAt: `2026-06-01T10:0${index}:00.000Z`,
    }))

    const [role] = buildRecruiterRoleIntelligence(
      [{ jobId: "public-role-1", aliases: ["real-role-1"] }],
      "recruiter-a",
      {
        sourcedCandidates,
        submissions: [],
        feedback: [],
        questions: [],
        applications: [],
      },
    )

    assert.equal(role?.pipelinePreview.length, 6)
    assert.equal(role?.pipelinePreview[0]?.candidateLabel, "Role 7")
    assert.equal(role?.pipelinePreview[5]?.candidateLabel, "Role 2")
  })

  it("counts backburner as pending and offer as advanced in role intelligence", () => {
    const [role] = buildRecruiterRoleIntelligence(
      [{ jobId: "public-role-1", aliases: ["real-role-1", "public-role-1"] }],
      "recruiter-a",
      {
        sourcedCandidates: [],
        submissions: [
          { jobId: "real-role-1", recruiterId: "recruiter-a", status: "backburner" },
          { inboundJobId: "public-role-1", recruiterId: "recruiter-a", status: "offer" },
          { inboundJobId: "public-role-1", recruiterId: "recruiter-b", status: "hired" },
        ],
        feedback: [],
        questions: [],
        applications: [],
      },
    )

    assert.equal(role?.pendingCount, 1)
    assert.equal(role?.advancedCount, 2)
    assert.deepEqual(role?.my, {
      sourcedCount: 0,
      readyCount: 0,
      submissionCount: 2,
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
  it("normalizes candidate emails for duplicate ownership checks", () => {
    assert.equal(normalizeRecruiterCandidateEmail(" Ada@Example.COM "), "ada@example.com")
    assert.equal(hashRecruiterCandidateEmail("ada@example.com").length, 64)
  })

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

  it("blocks recruiter submissions when candidate identity is already submitted for the role", () => {
    const linkKey = hashRecruiterCandidateLink("https://linkedin.com/in/ada")
    const emailKey = hashRecruiterCandidateEmail("ada@example.com")

    assert.deepEqual(recruiterCandidateIdentityConflictForRole({
      realJobId: "role-1",
      recruiterId: "recruiter-a",
      candidateLinkKey: linkKey,
      candidateEmailKey: emailKey,
    }, [
      {
        id: "sub-1",
        collection: "submissions",
        data: {
          jobId: "role-1",
          recruiterId: "recruiter-b",
          candidateEmailKey: emailKey,
        },
      },
    ]), {
      reason: "candidate_already_submitted_for_role",
      docId: "sub-1",
    })
  })

  it("blocks direct submissions when another recruiter has already sourced the candidate for the role", () => {
    const linkKey = hashRecruiterCandidateLink("https://linkedin.com/in/ada")

    assert.deepEqual(recruiterCandidateIdentityConflictForRole({
      realJobId: "role-1",
      recruiterId: "recruiter-a",
      candidateLinkKey: linkKey,
    }, [
      {
        id: "source-1",
        collection: "sourced",
        data: {
          jobId: "role-1",
          recruiterId: "recruiter-b",
          candidateLinkKey: linkKey,
        },
      },
    ]), {
      reason: "candidate_already_sourced_for_role",
      docId: "source-1",
    })
  })

  it("allows a recruiter to submit their own unsubmitted sourced candidate", () => {
    const linkKey = hashRecruiterCandidateLink("https://linkedin.com/in/ada")

    assert.equal(recruiterCandidateIdentityConflictForRole({
      realJobId: "role-1",
      recruiterId: "recruiter-a",
      candidateLinkKey: linkKey,
    }, [
      {
        id: "source-1",
        collection: "sourced",
        data: {
          jobId: "role-1",
          recruiterId: "recruiter-a",
          candidateLinkKey: linkKey,
        },
      },
    ]), null)
  })

  it("accepts a recruiter-sourced candidate and trims optional fields", () => {
    const result = validateRecruiterSourcedCandidateInput({
      jobId: " public-job-1 ",
      stage: "ready",
      calibrationRequest: {
        note: " Is this senior enough for the hiring bar? ",
      },
      outreach: {
        status: "contacted",
        nextFollowUpAt: "2026-06-02T16:00:00.000Z",
      },
      candidate: {
        name: " Ada Lovelace ",
        email: " ADA@Example.com ",
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
      email: "ada@example.com",
      link: "https://linkedin.com/in/ada",
      currentRole: "Staff Engineer",
      yoe: "9",
      notes: "strong backend match",
    })
    assert.deepEqual(result.value.calibrationRequest, {
      note: "Is this senior enough for the hiring bar?",
    })
    assert.deepEqual(result.value.outreach, {
      status: "contacted",
      nextFollowUpAt: "2026-06-02T16:00:00.000Z",
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
    assert.deepEqual(validateRecruiterSourcedCandidateInput({
      jobId: "job-1",
      candidate: { name: "Ada", email: "not-email", link: "https://linkedin.com/in/ada" },
    }), {
      ok: false,
      reason: "invalid_candidate_email",
    })
    assert.deepEqual(validateRecruiterSourcedCandidateInput({
      jobId: "job-1",
      calibrationRequest: { note: 123 },
      candidate: { name: "Ada", link: "https://linkedin.com/in/ada" },
    }), {
      ok: false,
      reason: "invalid_calibration_note",
    })
    assert.deepEqual(validateRecruiterSourcedCandidateInput({
      jobId: "job-1",
      outreach: { status: "cold" },
      candidate: { name: "Ada", link: "https://linkedin.com/in/ada" },
    }), {
      ok: false,
      reason: "invalid_outreach_status",
    })
    assert.deepEqual(validateRecruiterSourcedCandidateInput({
      jobId: "job-1",
      outreach: { nextFollowUpAt: "later" },
      candidate: { name: "Ada", link: "https://linkedin.com/in/ada" },
    }), {
      ok: false,
      reason: "invalid_next_follow_up_at",
    })
  })

  it("omits absent optional candidate fields before Firestore writes", () => {
    const result = validateRecruiterSourcedCandidateInput({
      jobId: "job-1",
      candidate: {
        name: "Ada Lovelace",
        link: "https://linkedin.com/in/ada",
        currentRole: "",
        yoe: " ",
      },
    })

    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(result.value.candidate, {
      name: "Ada Lovelace",
      link: "https://linkedin.com/in/ada",
    })
  })
})

describe("recruiter submissions", () => {
  const validSubmission = {
    jobId: "public-job-1",
    source: "hiring-board",
    submitter: { name: "Sloane", email: "sloane@agency.com" },
    candidate: {
      name: "Ada Lovelace",
      email: "ADA@Example.com",
      link: "https://linkedin.com/in/ada",
      currentRole: "Staff Engineer",
    },
    checklist: { hard_1: true },
    candidateConsent: true,
  }

  it("requires candidate email for recruiter submissions and normalizes it", () => {
    const result = validateSubmission({ ...validSubmission, sourcedCandidateId: "candidate_123" })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.value.candidate.email, "ada@example.com")
    assert.equal(result.value.source, "hiring-board")
    assert.equal(result.value.sourcedCandidateId, "candidate_123")
  })

  it("rejects malformed sourced candidate ids on recruiter submissions", () => {
    assert.deepEqual(validateSubmission({
      ...validSubmission,
      sourcedCandidateId: "../bad",
    }), {
      ok: false,
      reason: "invalid_sourced_candidate_id",
    })
  })

  it("rejects missing or malformed candidate email on recruiter submissions", () => {
    assert.deepEqual(validateSubmission({
      ...validSubmission,
      candidate: { name: "Ada", link: "https://linkedin.com/in/ada" },
    }), {
      ok: false,
      reason: "missing_candidate_email",
    })
    assert.deepEqual(validateSubmission({
      ...validSubmission,
      candidate: { name: "Ada", email: "bad", link: "https://linkedin.com/in/ada" },
    }), {
      ok: false,
      reason: "invalid_candidate_email",
    })
  })

  it("composes a candidate confirmation email with the role and confirmation link", () => {
    const email = composeCandidateSubmissionConfirmationEmail({
      candidateName: "Ada",
      recruiterName: "Sloane",
      roleTitle: "Founding Engineer",
      companyLabel: "Co. B",
      confirmationUrl: "https://us-central1-wekruit-5f89b.cloudfunctions.net/paRecruiterCandidateConsentConfirm?submissionId=sub_1&token=tok",
    })
    assert.match(email.subject, /Founding Engineer/)
    assert.match(email.text, /Confirm here:/)
    assert.match(email.text, /submitted you to WeKruit/)
    assert.match(email.html, /Confirm this submission/)
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

describe("recruiter role applications", () => {
  it("accepts an apply request with pitch, anonymization, and prepared candidates", () => {
    const result = validateRecruiterRoleApplicationInput({
      jobId: " public-job-1 ",
      action: "apply",
      pitch: "I have recently placed post-training research profiles and can source from speech labs this week.",
      anonymizeCandidates: true,
      preparedCandidateIds: [" candidate-1 ", "candidate-1", "candidate_2"],
    })

    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(result.value, {
      jobId: "public-job-1",
      action: "apply",
      pitch: "I have recently placed post-training research profiles and can source from speech labs this week.",
      anonymizeCandidates: true,
      preparedCandidateIds: ["candidate-1", "candidate_2"],
    })
  })

  it("accepts a withdraw request without requiring a pitch", () => {
    assert.deepEqual(validateRecruiterRoleApplicationInput({
      jobId: "role-1",
      action: "withdraw",
    }), {
      ok: true,
      value: {
        jobId: "role-1",
        action: "withdraw",
        anonymizeCandidates: false,
        preparedCandidateIds: [],
      },
    })
  })

  it("rejects malformed role application payloads", () => {
    assert.deepEqual(validateRecruiterRoleApplicationInput({}), {
      ok: false,
      reason: "missing_jobId",
    })
    assert.deepEqual(validateRecruiterRoleApplicationInput({
      jobId: "role-1",
      action: "apply",
      pitch: "too short",
    }), {
      ok: false,
      reason: "pitch_too_short",
    })
    assert.deepEqual(validateRecruiterRoleApplicationInput({
      jobId: "role-1",
      action: "apply",
      pitch: "I can source strong candidates from my network for this role.",
      preparedCandidateIds: ["../bad"],
    }), {
      ok: false,
      reason: "invalid_prepared_candidate_ids",
    })
  })
})

describe("recruiter notifications", () => {
  it("accepts marking all notifications read", () => {
    assert.deepEqual(validateRecruiterNotificationsReadInput({ all: true }), {
      ok: true,
      value: {
        all: true,
        notificationIds: [],
      },
    })
  })

  it("accepts and de-dupes specific notification ids", () => {
    assert.deepEqual(validateRecruiterNotificationsReadInput({
      notificationIds: [" abc_123 ", "abc_123", "new-role-1"],
    }), {
      ok: true,
      value: {
        all: false,
        notificationIds: ["abc_123", "new-role-1"],
      },
    })
  })

  it("rejects malformed notification read payloads", () => {
    assert.deepEqual(validateRecruiterNotificationsReadInput({}), {
      ok: false,
      reason: "missing_notification_ids",
    })
    assert.deepEqual(validateRecruiterNotificationsReadInput({ notificationIds: ["../bad"] }), {
      ok: false,
      reason: "invalid_notification_ids",
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
