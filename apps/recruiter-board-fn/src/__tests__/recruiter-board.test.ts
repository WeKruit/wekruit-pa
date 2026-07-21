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
import { logger } from "firebase-functions/v2"
import * as recruiterBoardEntrypoint from "../index.js"
import {
  addRecruiterSubmissionComment,
  applyRecruiterSubmissionUpdate,
  buildRecruiterRoleIntelligence,
  buildRecruiterRoleApplicationDecisionEvent,
  buildRecruiterRoleFeedbackEvent,
  buildRecruiterSubmissionFeedbackEvent,
  candidateCalibrationNotification,
  candidateConfirmationNotification,
  coerceStoredSubmissionChecklist,
  coerceSubmissionChecklistInput,
  computeSubmissionScore,
  deliverRecruiterSubmissionCommentNotification,
  listRecruiterSubmissionComments,
  composeRecruiterInviteEmail,
  composeRecruiterRoleNotificationEmail,
  composeRecruiterSubmissionUpdateEmail,
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
  mergeRecruiterNotificationPreferences,
  normalizeRecruiterInviteCode,
  payoutUpdateNotification,
  publicRecruiterSubmission,
  recruiterCandidateIdentityConflictForRole,
  recruiterEmailInviteUrl,
  recruiterInviteCodeAllowsEmail,
  recruiterInviteUrl,
  recruiterInviteCodeMatchesBoundUser,
  registerRecruiterAccess,
  resendRecruiterInviteCodeEmail,
  recruiterIdentityFromFirebaseBearer,
  recruiterSubmissionUpdateEmailsEnabled,
  resolveSubmissionExtraFields,
  roleQuestionAnswerNotification,
  sanitizeRecruiterSubmitFields,
  sendRecruiterSubmissionUpdateEmail,
  shouldNotifyRecruitersForRoleRelease,
  submissionCommentNotification,
  submissionFeedbackNotification,
  submissionRequestedInfoNotification,
  sanitizeSubmissionRequestedInfo,
  sanitizeSubmissionStatusHistory,
  validateCandidateConfirmationResendInput,
  validateRecruiterCandidateIdentityCheckInput,
  validateRecruiterSubmissionCommentAddInput,
  validateRecruiterSubmissionUpdateInput,
  validateInviteCodeCreate,
  validateInviteCodeReplace,
  validateInviteCodeResend,
  validateInviteCodeRestore,
  validateRecruiterNotificationsReadInput,
  validateRecruiterRegistration,
  validateRecruiterRoleApplicationInput,
  validateRecruiterRoleFeedbackInput,
  validateRecruiterRoleQuestionInput,
  validateRecruiterSourcedCandidateInput,
  validateRecruiterWorkspacePreferences,
  validateSubmission,
  writeRecruiterRoleApplicationDecisionEvent,
  writeRecruiterRoleFeedbackEvent,
  writeRecruiterSubmissionFeedbackEvent,
  type ChecklistCellLevel,
  type RecruiterBoardChecklistGroup,
  type RecruiterBoardPayload,
  type RecruiterBoardSubmitField,
  type RecruiterProfilePublic,
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

function memoryFirestore() {
  const docs = new Map<string, unknown>()
  const counts = new Map<string, number>()
  return {
    collection: (collectionName: string) => ({
      doc: (docId: string) => {
        const key = `${collectionName}/${docId}`
        return {
          get: async () => ({
            exists: docs.has(key),
            data: () => docs.get(key),
          }),
          set: async (payload: unknown) => {
            docs.set(key, payload)
            counts.set(key, (counts.get(key) ?? 0) + 1)
          },
        }
      },
    }),
    get: (key: string) => docs.get(key),
    has: (key: string) => docs.has(key),
    setCount: (key: string) => counts.get(key) ?? 0,
  }
}

describe("recruiter-board deployed entrypoint", () => {
  it("exports the role feedback flywheel trigger", () => {
    assert.equal("paRecruiterRoleFeedbackSignalWrite" in recruiterBoardEntrypoint, true)
  })
})

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

describe("sanitizeSubmissionRequestedInfo", () => {
  it("keeps {message, at, by} entries and drops malformed ones", () => {
    assert.deepEqual(sanitizeSubmissionRequestedInfo([
      { message: " Please add a portfolio link ", at: "2026-06-01T12:00:00Z", by: "ops@wekruit.com" },
      { message: "No timestamp", at: "bad-date" },
      { message: "" },
      { at: "2026-06-01T12:00:00Z" },
      null,
      "loose string",
    ]), [
      { message: "Please add a portfolio link", at: "2026-06-01T12:00:00.000Z", by: "ops@wekruit.com" },
      { message: "No timestamp" },
    ])
  })
})

describe("publicRecruiterSubmission", () => {
  it("round-trips requestedInfo and extraFields for a reviewing submission", () => {
    const row = publicRecruiterSubmission({
      id: "sub-1",
      data: () => ({
        jobId: "job-1",
        status: "reviewing",
        requestedInfo: [
          { message: "Please add a portfolio link", at: "2026-06-01T12:00:00.000Z", by: "ops@wekruit.com" },
        ],
        extraFields: { portfolio_url: "https://example.com/work", junk: 42 },
      }),
    })
    assert.equal(row.status, "reviewing")
    assert.deepEqual(row.requestedInfo, [
      { message: "Please add a portfolio link", at: "2026-06-01T12:00:00.000Z", by: "ops@wekruit.com" },
    ])
    assert.deepEqual(row.extraFields, { portfolio_url: "https://example.com/work" })
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

  it("requires a recruiter email when an admin sends the invite email", () => {
    assert.deepEqual(validateInviteCodeCreate({ sendEmail: true }), {
      ok: false,
      reason: "missing_recruiter_email",
    })
    assert.deepEqual(validateInviteCodeCreate({ sendEmail: true, recruiterEmail: "not-email" }), {
      ok: false,
      reason: "invalid_recruiter_email",
    })
    const invite = validateInviteCodeCreate({ sendEmail: true, recruiterEmail: " Sloane@Agency.com " })
    assert.equal(invite.ok, true)
    if (invite.ok) {
      assert.equal(invite.value.sendEmail, true)
      assert.equal(invite.value.recruiterEmail, "sloane@agency.com")
    }
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

  it("validates invite resend requests by hashed id", () => {
    const inviteCodeId = hashRecruiterInviteCode("WK-CDKE-AUC5")
    assert.deepEqual(validateInviteCodeResend({ inviteCodeId }), {
      ok: true,
      value: { inviteCodeId },
    })
    assert.deepEqual(validateInviteCodeResend({ inviteCodeId: "WK-CDKE-AUC5" }), {
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

  it("keeps email-bound recruiter invite codes tied to the invited login email", () => {
    assert.equal(recruiterInviteCodeAllowsEmail({ recruiterEmail: "Sloane@Agency.com" }, "sloane@agency.com"), true)
    assert.equal(recruiterInviteCodeAllowsEmail({ recruiterEmail: "sloane@agency.com" }, "other@agency.com"), false)
    assert.equal(recruiterInviteCodeAllowsEmail({}, "other@agency.com"), true)
  })

  it("accepts a claim registration without an invite code", () => {
    const codeless = validateRecruiterRegistration({ name: "Sloane", email: "Sloane@Agency.com" })
    assert.equal(codeless.ok, true)
    if (codeless.ok) {
      assert.deepEqual(codeless.value, { name: "Sloane", email: "sloane@agency.com", inviteCode: "" })
    }
    const withCode = validateRecruiterRegistration({ name: "Sloane", email: "sloane@agency.com", inviteCode: " wk-abcd-2345 " })
    assert.equal(withCode.ok, true)
    if (withCode.ok) assert.equal(withCode.value.inviteCode, "WK-ABCD-2345")
    assert.deepEqual(validateRecruiterRegistration({ email: "sloane@agency.com" }), { ok: false, reason: "missing_name" })
    assert.deepEqual(validateRecruiterRegistration({ name: "Sloane" }), { ok: false, reason: "missing_email" })
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
      roleUrl: "https://wekruit-recruiters.web.app/recruiters/job/role-1",
    })
    assert.match(email.subject, /Founding Engineer/)
    assert.match(email.text, /wekruit-recruiters\.web\.app/)
    assert.match(email.text, /turn off new-role emails/i)
  })

  it("builds a one-click invite URL with the full code and url-encoded email", () => {
    const url = recruiterInviteUrl("WK-ABCD-2345", "sloane@agency.com")
    assert.equal(url, "https://wekruit-recruiters.web.app/recruiters?code=WK-ABCD-2345&email=sloane%40agency.com")
    assert.equal(recruiterInviteUrl("WK-ABCD-2345"), "https://wekruit-recruiters.web.app/recruiters?code=WK-ABCD-2345")
  })

  it("builds a codeless email-bound invite URL", () => {
    assert.equal(
      recruiterEmailInviteUrl("sloane@agency.com"),
      "https://wekruit-recruiters.web.app/recruiters?invite=1&email=sloane%40agency.com",
    )
  })

  it("composes a recruiter invite email with the codeless accept link and a legacy code fallback", () => {
    const email = composeRecruiterInviteEmail({
      recruiterEmail: "sloane@agency.com",
      inviteCode: "WK-ABCD-2345",
      expiresAt: "2027-06-09T12:00:00.000Z",
    })
    assert.match(email.subject, /recruiter invite/i)
    assert.match(email.text, /Accept your invite: https:\/\/wekruit-recruiters\.web\.app\/recruiters\?invite=1&email=sloane%40agency\.com/)
    assert.match(email.text, /If the button doesn't work, go to the recruiter site and sign in with this Google account\./)
    assert.match(email.text, /sloane@agency\.com/)
    assert.match(email.html, /<a href="https:\/\/wekruit-recruiters\.web\.app\/recruiters\?invite=1&amp;email=sloane%40agency\.com"/)
    assert.match(email.html, /Accept your invite<\/a>/)
    assert.match(email.html, /go to the recruiter site and sign in with this Google account\./)
  })

  it("composes a submission update email with the recruiter workspace action", () => {
    const email = composeRecruiterSubmissionUpdateEmail({
      title: "Ada Lovelace is sent to hiring team",
      body: "Founding Engineer · Status: sent to hiring team · Rating 4/4",
      roleTitle: "Founding Engineer",
      companyLabel: "Co. B",
      actionUrl: "https://wekruit-recruiters.web.app/recruiters?tab=submissions",
    })
    assert.match(email.subject, /WeKruit update/)
    assert.match(email.text, /Ada Lovelace/)
    assert.match(email.text, /Founding Engineer/)
    assert.match(email.text, /tab=submissions/)
  })
})

function recruiterAccessFakeDb(seed: Record<string, Record<string, unknown>> = {}) {
  const docs = new Map<string, Record<string, unknown>>()
  for (const [key, value] of Object.entries(seed)) docs.set(key, { ...value })
  const writes: Array<{ key: string; data: Record<string, unknown> }> = []
  const hooks: { beforeTransaction?: () => void } = {}

  const applySet = (key: string, data: Record<string, unknown>, opts?: { merge?: boolean }) => {
    writes.push({ key, data })
    const base = opts?.merge ? { ...(docs.get(key) ?? {}) } : {}
    docs.set(key, { ...base, ...data })
  }
  interface FakeRef {
    id: string
    key: string
    get: () => Promise<FakeSnap>
    set: (data: Record<string, unknown>, opts?: { merge?: boolean }) => Promise<void>
  }
  interface FakeSnap {
    exists: boolean
    id: string
    ref: FakeRef
    data: () => Record<string, unknown> | undefined
  }
  const makeRef = (key: string): FakeRef => ({
    id: key.slice(key.indexOf("/") + 1),
    key,
    get: async () => makeSnap(key),
    set: async (data, opts) => applySet(key, data, opts),
  })
  const makeSnap = (key: string): FakeSnap => ({
    exists: docs.has(key),
    id: key.slice(key.indexOf("/") + 1),
    ref: makeRef(key),
    data: () => docs.get(key),
  })

  const db = {
    collection: (collectionName: string) => ({
      doc: (docId: string) => makeRef(`${collectionName}/${docId}`),
      where: (field: string, _op: string, value: unknown) => ({
        get: async () => ({
          docs: [...docs.keys()]
            .filter((key) => key.startsWith(`${collectionName}/`) && docs.get(key)?.[field] === value)
            .map((key) => makeSnap(key)),
        }),
      }),
    }),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      hooks.beforeTransaction?.()
      return fn({
        get: async (ref: FakeRef) => makeSnap(ref.key),
        set: (ref: FakeRef, data: Record<string, unknown>, opts?: { merge?: boolean }) => applySet(ref.key, data, opts),
      })
    },
  }
  return {
    db: db as unknown as Parameters<typeof registerRecruiterAccess>[0],
    docs,
    writes,
    hooks,
  }
}

describe("registerRecruiterAccess codeless email-bound claims", () => {
  const identity = { uid: "uid-rec-1", email: "sloane@agency.com" }

  const usableInvite = (overrides: Record<string, unknown> = {}) => ({
    inviteCodeId: "hash-1",
    recruiterEmail: "sloane@agency.com",
    active: true,
    maxUses: 1,
    usedCount: 0,
    createdAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  })

  it("claims by invited email without a code and binds the newest usable invite", async () => {
    const { db, docs, writes } = recruiterAccessFakeDb({
      "pa-recruiter-invite-codes/hash-old": usableInvite({ inviteCodeId: "hash-old", createdAt: "2026-05-01T00:00:00.000Z" }),
      "pa-recruiter-invite-codes/hash-new": usableInvite({ inviteCodeId: "hash-new", createdAt: "2026-06-01T00:00:00.000Z" }),
      "pa-recruiter-invite-codes/hash-used": usableInvite({ inviteCodeId: "hash-used", usedCount: 1, createdAt: "2026-06-08T00:00:00.000Z" }),
    })
    const recruiter = await registerRecruiterAccess(db, identity, { name: "Sloane", email: "sloane@agency.com", inviteCode: "" })
    assert.equal(recruiter?.recruiterId, "uid-rec-1")
    const userDoc = docs.get("pa-recruiter-users/uid-rec-1")
    assert.equal(userDoc?.inviteCodeId, "hash-new")
    assert.equal(userDoc?.status, "active")
    const inviteWrite = writes.find((write) => write.key === "pa-recruiter-invite-codes/hash-new")
    assert.ok(inviteWrite, "claimed invite gets the usage write")
    assert.equal(inviteWrite?.data.lastUsedByUid, "uid-rec-1")
    assert.equal(inviteWrite?.data.lastUsedByEmail, "sloane@agency.com")
    assert.ok("usedCount" in (inviteWrite?.data ?? {}), "claim increments usedCount")
  })

  it("rejects a codeless claim when no usable invite exists for the email", async () => {
    const { db, docs } = recruiterAccessFakeDb({
      "pa-recruiter-invite-codes/hash-used": usableInvite({ usedCount: 1 }),
      "pa-recruiter-invite-codes/hash-other": usableInvite({ inviteCodeId: "hash-other", recruiterEmail: "other@agency.com" }),
      "pa-recruiter-invite-codes/hash-inactive": usableInvite({ inviteCodeId: "hash-inactive", active: false }),
    })
    const recruiter = await registerRecruiterAccess(db, identity, { name: "Sloane", email: "sloane@agency.com", inviteCode: "" })
    assert.equal(recruiter, null)
    assert.equal(docs.has("pa-recruiter-users/uid-rec-1"), false)
  })

  it("re-checks invite usability inside the transaction so a raced codeless claim loses", async () => {
    const { db, docs, hooks } = recruiterAccessFakeDb({
      "pa-recruiter-invite-codes/hash-1": usableInvite(),
    })
    hooks.beforeTransaction = () => {
      docs.set("pa-recruiter-invite-codes/hash-1", { ...docs.get("pa-recruiter-invite-codes/hash-1")!, usedCount: 1 })
    }
    const recruiter = await registerRecruiterAccess(db, identity, { name: "Sloane", email: "sloane@agency.com", inviteCode: "" })
    assert.equal(recruiter, null)
    assert.equal(docs.has("pa-recruiter-users/uid-rec-1"), false)
  })

  it("keeps the legacy explicit-code claim path unchanged", async () => {
    const normalizedCode = normalizeRecruiterInviteCode("WK-CDKE-AUC5")
    const codeHash = hashRecruiterInviteCode(normalizedCode)
    const { db, docs, writes } = recruiterAccessFakeDb({
      [`pa-recruiter-invite-codes/${codeHash}`]: usableInvite({ inviteCodeId: codeHash }),
    })
    const recruiter = await registerRecruiterAccess(db, identity, { name: "Sloane", email: "sloane@agency.com", inviteCode: normalizedCode })
    assert.equal(recruiter?.recruiterId, "uid-rec-1")
    assert.equal(docs.get("pa-recruiter-users/uid-rec-1")?.inviteCodeId, codeHash)
    const inviteWrite = writes.find((write) => write.key === `pa-recruiter-invite-codes/${codeHash}`)
    assert.equal(inviteWrite?.data.lastUsedByUid, "uid-rec-1")
  })

  it("lets an already-registered recruiter re-claim without a code", async () => {
    const { db, docs } = recruiterAccessFakeDb({
      "pa-recruiter-users/uid-rec-1": {
        recruiterId: "uid-rec-1",
        email: "sloane@agency.com",
        status: "active",
        inviteCodeId: "hash-historic",
      },
    })
    const recruiter = await registerRecruiterAccess(db, identity, { name: "Sloane", email: "sloane@agency.com", inviteCode: "" })
    assert.equal(recruiter?.recruiterId, "uid-rec-1")
    assert.equal(docs.get("pa-recruiter-users/uid-rec-1")?.inviteCodeId, "hash-historic")
  })

  it("still rejects an already-registered recruiter presenting a mismatched code", async () => {
    const { db } = recruiterAccessFakeDb({
      "pa-recruiter-users/uid-rec-1": {
        recruiterId: "uid-rec-1",
        email: "sloane@agency.com",
        status: "active",
        inviteCodeId: hashRecruiterInviteCode("WK-REAL-CODE"),
      },
    })
    const recruiter = await registerRecruiterAccess(db, identity, { name: "Sloane", email: "sloane@agency.com", inviteCode: "WK-WRONG-CODE" })
    assert.equal(recruiter, null)
  })
})

describe("resendRecruiterInviteCodeEmail", () => {
  const inviteCode = "WK-CDKE-AUC5"
  const inviteCodeId = hashRecruiterInviteCode(inviteCode)

  const resendableInvite = (overrides: Record<string, unknown> = {}) => ({
    inviteCodeId,
    inviteCode,
    recruiterEmail: "sloane@agency.com",
    active: true,
    maxUses: 1,
    usedCount: 0,
    expiresAt: "2027-06-09T12:00:00.000Z",
    inviteEmailStatus: "sent",
    ...overrides,
  })

  it("resends a sent but unclaimed invite using the existing code", async () => {
    const { db, writes } = recruiterAccessFakeDb({
      [`pa-recruiter-invite-codes/${inviteCodeId}`]: resendableInvite(),
    })
    const sent: Array<{ recruiterEmail: string; inviteCode: string; expiresAt?: string | null }> = []

    const result = await resendRecruiterInviteCodeEmail(db, { inviteCodeId, adminEmail: "admin@wekruit.com" }, async (_ref, input) => {
      sent.push(input)
      return { ok: true, messageId: "mailgun-2" }
    })

    assert.deepEqual(result, {
      ok: true,
      inviteCodeId,
      recruiterEmail: "sloane@agency.com",
      emailStatus: "sent",
      emailMessageId: "mailgun-2",
    })
    assert.deepEqual(sent, [{
      recruiterEmail: "sloane@agency.com",
      inviteCode,
      expiresAt: "2027-06-09T12:00:00.000Z",
    }])
    const auditWrite = writes.find((write) => write.key === `pa-recruiter-invite-codes/${inviteCodeId}` && write.data.inviteEmailLastResentByEmail)
    assert.equal(auditWrite?.data.inviteEmailLastResentByEmail, "admin@wekruit.com")
    assert.ok("inviteEmailResendCount" in (auditWrite?.data ?? {}))
  })

  it("does not resend an already activated invite", async () => {
    const { db } = recruiterAccessFakeDb({
      [`pa-recruiter-invite-codes/${inviteCodeId}`]: resendableInvite({ usedCount: 1 }),
    })
    let sendCount = 0

    const result = await resendRecruiterInviteCodeEmail(db, { inviteCodeId, adminEmail: "admin@wekruit.com" }, async () => {
      sendCount += 1
      return { ok: true }
    })

    assert.deepEqual(result, { ok: false, status: 409, reason: "invite_code_not_usable" })
    assert.equal(sendCount, 0)
  })
})

describe("recruiter role question answer notifications", () => {
  it("does not notify when a role question is first created open", () => {
    assert.equal(roleQuestionAnswerNotification(null, {
      status: "open",
      question: "Which profiles should we avoid?",
      answer: null,
    }), null)
  })

  it("notifies when an admin answers a recruiter role question", () => {
    const notification = roleQuestionAnswerNotification({
      status: "open",
      question: "Which profiles should we avoid?",
      answer: null,
    }, {
      status: "answered",
      jobTitleSnapshot: "Founding Engineer",
      question: "Which profiles should we avoid?",
      answer: "Avoid pure frontend portfolios unless they include systems ownership.",
    })
    assert.equal(notification?.title, "WeKruit answered your role question")
    assert.match(notification?.body ?? "", /Founding Engineer/)
    assert.match(notification?.body ?? "", /Which profiles should we avoid/)
    assert.match(notification?.body ?? "", /pure frontend portfolios/)
  })

  it("does not notify again when the answered text is unchanged", () => {
    assert.equal(roleQuestionAnswerNotification({
      status: "answered",
      answer: "Target builders with systems ownership.",
    }, {
      status: "answered",
      answer: "Target builders with systems ownership.",
    }), null)
  })
})

describe("recruiter role application decision flywheel events", () => {
  it("builds a redacted feedback event when admin decides role access", () => {
    const event = buildRecruiterRoleApplicationDecisionEvent({
      triggerEventId: "evt-role-1",
      applicationId: "app-1",
      createdAt: "2026-06-02T12:00:00.000Z",
      before: {
        status: "pending",
        pitch: "I have Ada Lovelace ready for this role.",
        preparedCandidateIds: ["cand-1"],
      },
      after: {
        status: "approved",
        jobId: "job-1",
        recruiterId: "recruiter-1",
        recruiterEmail: "recruiter@example.com",
        pitch: "I have Ada Lovelace ready for this role.",
        adminNote: "Approved because Ada is a strong fit; ada@example.com",
        preparedCandidateIds: ["cand-1", "cand-2"],
        preparedCandidateCount: 2,
        anonymizeCandidates: true,
        adminReviewRecommendation: "approve",
        adminReviewQualityScore: 82,
      },
    })

    assert.equal(event?.eventId, "recruiter_role_application_decision_evt-role-1")
    assert.equal(event?.kind, "recruiter_role_application_decision")
    assert.equal(event?.actor, "operator")
    assert.equal(event?.jobId, "job-1")
    assert.equal(event?.outcome, "approved")
    assert.deepEqual(event?.payloadRedacted, {
      applicationId: "app-1",
      recruiterId: "recruiter-1",
      status: "approved",
      previousStatus: "pending",
      statusChanged: true,
      preparedCandidateCount: 2,
      anonymizeCandidates: true,
      adminReviewRecommendation: "approve",
      adminReviewQualityScore: 82,
      hasAdminNote: true,
      source: "recruiter_board_admin",
    })
    assert.equal(event?.evidence[0]?.source, "admin")
    assert.equal(event?.evidence[0]?.refId, "app-1")
    const serialized = JSON.stringify(event)
    assert.doesNotMatch(serialized, /Ada Lovelace/)
    assert.doesNotMatch(serialized, /ada@example\.com/)
    assert.doesNotMatch(serialized, /cand-1/)
    assert.doesNotMatch(serialized, /strong fit/)
  })

  it("skips event construction for pending/no-op role application changes", () => {
    assert.equal(buildRecruiterRoleApplicationDecisionEvent({
      triggerEventId: "evt-role-2",
      applicationId: "app-2",
      createdAt: "2026-06-02T12:00:00.000Z",
      before: { status: "pending", jobId: "job-1", recruiterId: "recruiter-1" },
      after: { status: "pending", jobId: "job-1", recruiterId: "recruiter-1" },
    }), null)
    assert.equal(buildRecruiterRoleApplicationDecisionEvent({
      triggerEventId: "evt-role-3",
      applicationId: "app-3",
      createdAt: "2026-06-02T12:00:00.000Z",
      before: { status: "approved", jobId: "job-1", recruiterId: "recruiter-1" },
      after: { status: "approved", jobId: "job-1", recruiterId: "recruiter-1", reviewedAt: "2026-06-02T12:00:00.000Z" },
    }), null)
  })

  it("writes role application decision events idempotently with one audit row", async () => {
    const event = buildRecruiterRoleApplicationDecisionEvent({
      triggerEventId: "evt-role-4",
      applicationId: "app-4",
      createdAt: "2026-06-02T12:00:00.000Z",
      before: { status: "pending" },
      after: {
        status: "not_approved",
        jobId: "job-1",
        recruiterId: "recruiter-1",
        preparedCandidateCount: 0,
        adminReviewRecommendation: "decline",
        adminReviewQualityScore: 41,
      },
    })
    assert.ok(event)
    const db = memoryFirestore()

    assert.equal((await writeRecruiterRoleApplicationDecisionEvent(db as never, event)).created, true)
    assert.equal((await writeRecruiterRoleApplicationDecisionEvent(db as never, event)).created, false)
    assert.deepEqual(db.get("pa-feedback-events/recruiter_role_application_decision_evt-role-4"), event)
    assert.equal(db.has("pa-audit-events/marketplace_feedback_recruiter_role_application_decision_evt-role-4"), true)
    assert.equal(db.setCount("pa-audit-events/marketplace_feedback_recruiter_role_application_decision_evt-role-4"), 1)
  })
})

describe("recruiter role feedback flywheel events", () => {
  it("builds a redacted feedback event when recruiter reports role difficulty", () => {
    const event = buildRecruiterRoleFeedbackEvent({
      triggerEventId: "evt-role-feedback-1",
      feedbackId: "feedback-1",
      createdAt: "2026-06-02T12:00:00.000Z",
      before: null,
      after: {
        jobId: "job-1",
        recruiterId: "recruiter-1",
        recruiterEmail: "recruiter@example.com",
        difficulty: "hard",
        reasons: ["small_candidate_pool", "hiring_team_slow"],
        note: "Hard because two named candidates declined; recruiter@example.com",
      },
    })

    assert.equal(event?.eventId, "recruiter_role_feedback_evt-role-feedback-1")
    assert.equal(event?.kind, "recruiter_role_feedback")
    assert.equal(event?.actor, "worker")
    assert.equal(event?.jobId, "job-1")
    assert.equal(event?.outcome, "hard")
    assert.deepEqual(event?.payloadRedacted, {
      feedbackId: "feedback-1",
      recruiterId: "recruiter-1",
      difficulty: "hard",
      reasonIds: ["small_candidate_pool", "hiring_team_slow"],
      hasNote: true,
      source: "recruiter_board",
    })
    assert.equal(event?.evidence[0]?.source, "system")
    assert.equal(event?.evidence[0]?.refId, "feedback-1")
    const serialized = JSON.stringify(event)
    assert.doesNotMatch(serialized, /two named candidates/)
    assert.doesNotMatch(serialized, /recruiter@example\.com/)
  })

  it("skips event construction when redacted role feedback signal did not change", () => {
    assert.equal(buildRecruiterRoleFeedbackEvent({
      triggerEventId: "evt-role-feedback-2",
      feedbackId: "feedback-2",
      createdAt: "2026-06-02T12:00:00.000Z",
      before: {
        jobId: "job-1",
        recruiterId: "recruiter-1",
        difficulty: "medium",
        reasons: ["role_too_broad"],
        note: "Initial note",
      },
      after: {
        jobId: "job-1",
        recruiterId: "recruiter-1",
        difficulty: "medium",
        reasons: ["role_too_broad"],
        note: "Different raw note with the same redacted shape",
        updatedAt: "2026-06-02T12:00:00.000Z",
      },
    }), null)
  })

  it("writes role feedback events idempotently with one audit row", async () => {
    const event = buildRecruiterRoleFeedbackEvent({
      triggerEventId: "evt-role-feedback-3",
      feedbackId: "feedback-3",
      createdAt: "2026-06-02T12:00:00.000Z",
      before: { jobId: "job-1", recruiterId: "recruiter-1", difficulty: "easy", reasons: [] },
      after: {
        jobId: "job-1",
        recruiterId: "recruiter-1",
        difficulty: "blocked",
        reasons: ["candidate_interest_low"],
        note: "Raw note is not copied.",
      },
    })
    assert.ok(event)
    const db = memoryFirestore()

    assert.equal((await writeRecruiterRoleFeedbackEvent(db as never, event)).created, true)
    assert.equal((await writeRecruiterRoleFeedbackEvent(db as never, event)).created, false)
    assert.deepEqual(db.get("pa-feedback-events/recruiter_role_feedback_evt-role-feedback-3"), event)
    assert.equal(db.has("pa-audit-events/marketplace_feedback_recruiter_role_feedback_evt-role-feedback-3"), true)
    assert.equal(db.setCount("pa-audit-events/marketplace_feedback_recruiter_role_feedback_evt-role-feedback-3"), 1)
  })
})

describe("recruiter submission feedback flywheel events", () => {
  it("builds a redacted append-only feedback event when admin feedback changes", () => {
    const event = buildRecruiterSubmissionFeedbackEvent({
      triggerEventId: "evt-1",
      submissionId: "sub-1",
      createdAt: "2026-06-02T12:00:00.000Z",
      before: {
        status: "reviewing",
        recruiterFeedbackRating: 2,
        recruiterFeedbackReasons: ["weak_evidence"],
      },
      after: {
        status: "advanced",
        jobId: "job-1",
        recruiterId: "recruiter-1",
        recruiterEmail: "recruiter@example.com",
        recruiterFeedbackRating: 4,
        recruiterFeedbackReasons: ["strong_match", "clear_evidence"],
        recruiterFeedbackNote: "Ada is excellent; ada@example.com; linkedin.com/in/ada",
        candidate: {
          name: "Ada Lovelace",
          email: "ada@example.com",
          link: "https://linkedin.com/in/ada",
        },
      },
    })

    assert.equal(event?.eventId, "recruiter_submission_feedback_evt-1")
    assert.equal(event?.kind, "recruiter_submission_feedback")
    assert.equal(event?.actor, "operator")
    assert.equal(event?.jobId, "job-1")
    assert.equal(event?.outcome, "advanced")
    assert.deepEqual(event?.payloadRedacted, {
      submissionId: "sub-1",
      recruiterId: "recruiter-1",
      status: "advanced",
      previousStatus: "reviewing",
      statusChanged: true,
      feedbackChanged: true,
      rating: 4,
      reasonIds: ["strong_match", "clear_evidence"],
      hasFeedbackNote: true,
      source: "recruiter_board_admin",
    })
    assert.equal(event?.evidence[0]?.source, "admin")
    assert.equal(event?.evidence[0]?.refId, "sub-1")
    const serialized = JSON.stringify(event)
    assert.doesNotMatch(serialized, /ada@example\.com/)
    assert.doesNotMatch(serialized, /linkedin\.com\/in\/ada/)
    assert.doesNotMatch(serialized, /Ada Lovelace/)
    assert.doesNotMatch(serialized, /Ada is excellent/)
  })

  it("skips event construction when no admin-visible feedback/status changed", () => {
    assert.equal(buildRecruiterSubmissionFeedbackEvent({
      triggerEventId: "evt-2",
      submissionId: "sub-2",
      createdAt: "2026-06-02T12:00:00.000Z",
      before: { status: "reviewing", jobId: "job-1", recruiterId: "recruiter-1" },
      after: { status: "reviewing", jobId: "job-1", recruiterId: "recruiter-1" },
    }), null)
    assert.equal(buildRecruiterSubmissionFeedbackEvent({
      triggerEventId: "evt-2b",
      submissionId: "sub-2",
      createdAt: "2026-06-02T12:00:00.000Z",
      before: {
        status: "reviewing",
        jobId: "job-1",
        recruiterId: "recruiter-1",
        recruiterFeedbackNote: "Same note",
        recruiterFeedbackRating: 3,
        recruiterFeedbackReasons: ["clear_evidence"],
      },
      after: {
        status: "reviewing",
        jobId: "job-1",
        recruiterId: "recruiter-1",
        recruiterFeedbackNote: "Same note",
        recruiterFeedbackRating: 3,
        recruiterFeedbackReasons: ["clear_evidence"],
        recruiterFeedbackUpdatedAt: "2026-06-02T12:00:00.000Z",
      },
    }), null)
  })

  it("writes feedback events idempotently and appends one audit row", async () => {
    const event = buildRecruiterSubmissionFeedbackEvent({
      triggerEventId: "evt-3",
      submissionId: "sub-3",
      createdAt: "2026-06-02T12:00:00.000Z",
      before: { status: "reviewing" },
      after: {
        status: "rejected",
        jobId: "job-1",
        recruiterId: "recruiter-1",
        recruiterFeedbackReasons: ["missing_hard_filter"],
      },
    })
    assert.ok(event)
    const db = memoryFirestore()

    assert.equal((await writeRecruiterSubmissionFeedbackEvent(db as never, event)).created, true)
    assert.equal((await writeRecruiterSubmissionFeedbackEvent(db as never, event)).created, false)
    assert.deepEqual(db.get("pa-feedback-events/recruiter_submission_feedback_evt-3"), event)
    assert.equal(db.has("pa-audit-events/marketplace_feedback_recruiter_submission_feedback_evt-3"), true)
    assert.equal(db.setCount("pa-audit-events/marketplace_feedback_recruiter_submission_feedback_evt-3"), 1)
  })
})

describe("recruiter submission requested info notifications", () => {
  const reviewingDoc = {
    status: "reviewing",
    jobTitleSnapshot: "Founding Engineer",
    candidate: { name: "Ada Lovelace" },
  }

  it("notifies when status moves to reviewing with a newly appended requestedInfo entry", () => {
    const notification = submissionRequestedInfoNotification({
      status: "submitted",
      jobTitleSnapshot: "Founding Engineer",
      candidate: { name: "Ada Lovelace" },
    }, {
      ...reviewingDoc,
      requestedInfo: [{ message: "Please share Ada's notice period and visa status." }],
    })
    assert.equal(notification?.title, "WeKruit needs more info on Ada Lovelace")
    assert.match(notification?.body ?? "", /Founding Engineer/)
    assert.match(notification?.body ?? "", /notice period and visa status/)
  })

  it("notifies again when another requestedInfo entry is appended while already reviewing", () => {
    const notification = submissionRequestedInfoNotification({
      ...reviewingDoc,
      requestedInfo: [{ message: "First ask" }],
    }, {
      ...reviewingDoc,
      requestedInfo: [{ message: "First ask" }, { message: "Second ask" }],
    })
    assert.equal(notification?.title, "WeKruit needs more info on Ada Lovelace")
    assert.match(notification?.body ?? "", /Second ask/)
  })

  it("does not notify when status moves to reviewing without a requestedInfo append", () => {
    assert.equal(submissionRequestedInfoNotification({
      status: "submitted",
      candidate: { name: "Ada Lovelace" },
    }, reviewingDoc), null)
  })

  it("does not notify on requestedInfo appends outside the reviewing status", () => {
    assert.equal(submissionRequestedInfoNotification({
      status: "submitted",
      candidate: { name: "Ada Lovelace" },
    }, {
      status: "submitted",
      candidate: { name: "Ada Lovelace" },
      requestedInfo: [{ message: "First ask" }],
    }), null)
  })

  it("does not email on aiEvaluation-only merges from the orchestrator eval trigger", () => {
    const before = {
      ...reviewingDoc,
      jobId: "job-1",
      recruiterId: "recruiter-1",
      requestedInfo: [{ message: "First ask" }],
    }
    const after = {
      ...before,
      aiEvaluation: { score: 0.82, summary: "Strong systems depth" },
    }
    assert.equal(submissionRequestedInfoNotification(before, after), null)
    assert.equal(submissionFeedbackNotification(before, after), null)
    assert.equal(candidateConfirmationNotification(before, after), null)
    assert.equal(payoutUpdateNotification(before, after), null)
    assert.equal(buildRecruiterSubmissionFeedbackEvent({
      triggerEventId: "evt-ai-1",
      submissionId: "sub-ai-1",
      createdAt: "2026-06-09T12:00:00.000Z",
      before,
      after,
    }), null)
  })

  it("still notifies on status transitions to advanced and rejected", () => {
    const advanced = submissionFeedbackNotification(reviewingDoc, { ...reviewingDoc, status: "advanced" })
    assert.equal(advanced?.title, "Ada Lovelace is sent to hiring team")
    const rejected = submissionFeedbackNotification(reviewingDoc, { ...reviewingDoc, status: "rejected" })
    assert.equal(rejected?.title, "Ada Lovelace is not a fit")
  })

  it("keeps the WeKruit subject verbatim when composing the requested info email", () => {
    const email = composeRecruiterSubmissionUpdateEmail({
      title: "WeKruit needs more info on Ada Lovelace",
      body: "Founding Engineer · Please share Ada's notice period and visa status.",
      roleTitle: "Founding Engineer",
      companyLabel: "Co. B",
    })
    assert.equal(email.subject, "WeKruit needs more info on Ada Lovelace")
    assert.match(email.text, /notice period and visa status/)
  })
})

describe("recruiter candidate calibration notifications", () => {
  it("does not notify when a recruiter first requests calibration", () => {
    assert.equal(candidateCalibrationNotification(null, {
      calibrationStatus: "calibration_requested",
      calibrationNote: "Is this senior enough?",
    }), null)
    assert.equal(candidateCalibrationNotification({
      calibrationStatus: "not_rated",
      calibrationNote: null,
    }, {
      calibrationStatus: "calibration_requested",
      calibrationNote: "Is this senior enough?",
    }), null)
  })

  it("notifies when admin answers a requested candidate calibration", () => {
    const notification = candidateCalibrationNotification({
      calibrationStatus: "calibration_requested",
      calibrationNote: "Is this senior enough?",
    }, {
      calibrationStatus: "good_fit",
      calibrationNote: "Good fit if they can show production ownership.",
      jobTitleSnapshot: "Founding Engineer",
      candidate: { name: "Ada Lovelace" },
    })
    assert.equal(notification?.title, "WeKruit calibrated Ada Lovelace")
    assert.match(notification?.body ?? "", /Founding Engineer/)
    assert.match(notification?.body ?? "", /good fit/)
    assert.match(notification?.body ?? "", /production ownership/)
  })

  it("does not notify again when calibration text is unchanged", () => {
    assert.equal(candidateCalibrationNotification({
      calibrationStatus: "suggested",
      calibrationNote: "Use for backend-heavy roles.",
    }, {
      calibrationStatus: "suggested",
      calibrationNote: "Use for backend-heavy roles.",
    }), null)
  })
})

describe("recruiter candidate confirmation notifications", () => {
  it("does not notify when a submission is first queued for confirmation", () => {
    assert.equal(candidateConfirmationNotification(null, {
      candidateConsentStatus: "pending_candidate_confirmation",
      candidateConfirmation: { status: "email_queued", candidateEmail: "ada@example.com" },
    }), null)
  })

  it("notifies when a candidate confirms recruiter submission consent", () => {
    const notification = candidateConfirmationNotification({
      candidateConsentStatus: "pending_candidate_confirmation",
      candidateConfirmation: { status: "email_sent", candidateEmail: "ada@example.com" },
    }, {
      candidateConsentStatus: "candidate_confirmed",
      candidateConfirmation: { status: "confirmed", candidateEmail: "ada@example.com" },
      jobTitleSnapshot: "Founding Engineer",
      candidate: { name: "Ada Lovelace" },
    })
    assert.equal(notification?.title, "Candidate confirmed Ada Lovelace")
    assert.match(notification?.body ?? "", /Founding Engineer/)
    assert.match(notification?.body ?? "", /ada@example.com/)
    assert.match(notification?.body ?? "", /confirmed consent/)
  })

  it("notifies when candidate confirmation email fails", () => {
    const notification = candidateConfirmationNotification({
      candidateConsentStatus: "pending_candidate_confirmation",
      candidateConfirmation: { status: "email_queued", candidateEmail: "ada@example.com" },
    }, {
      candidateConsentStatus: "confirmation_email_failed",
      candidateConfirmation: {
        status: "email_failed",
        candidateEmail: "ada@example.com",
        lastError: "mailgun_500",
      },
      jobTitleSnapshot: "Founding Engineer",
      candidate: { name: "Ada Lovelace" },
    })
    assert.equal(notification?.title, "Candidate confirmation needs attention")
    assert.match(notification?.body ?? "", /Founding Engineer/)
    assert.match(notification?.body ?? "", /Resend/)
    assert.match(notification?.body ?? "", /mailgun_500/)
  })

  it("does not notify again when confirmation status is unchanged", () => {
    assert.equal(candidateConfirmationNotification({
      candidateConsentStatus: "candidate_confirmed",
      candidateConfirmation: { status: "confirmed", candidateEmail: "ada@example.com" },
    }, {
      candidateConsentStatus: "candidate_confirmed",
      candidateConfirmation: { status: "confirmed", candidateEmail: "ada@example.com" },
    }), null)
  })
})

describe("recruiter payout update notifications", () => {
  it("does not notify when a submission is first created without payout status", () => {
    assert.equal(payoutUpdateNotification(null, {
      status: "submitted",
      candidate: { name: "Ada Lovelace" },
    }), null)
  })

  it("notifies when admin marks a recruiter payout eligible", () => {
    const notification = payoutUpdateNotification({
      recruiterPayout: { status: "none" },
      candidate: { name: "Ada Lovelace" },
    }, {
      recruiterPayout: {
        status: "eligible",
        amount: 12000,
        currency: "USD",
        note: "Candidate accepted the hiring team's interview loop.",
      },
      jobTitleSnapshot: "Founding Engineer",
      candidate: { name: "Ada Lovelace" },
    })
    assert.equal(notification?.title, "Payout eligible for Ada Lovelace")
    assert.match(notification?.body ?? "", /Founding Engineer/)
    assert.match(notification?.body ?? "", /\$12,000/)
    assert.match(notification?.body ?? "", /interview loop/)
  })

  it("notifies when a recruiter payout is recorded as paid", () => {
    const notification = payoutUpdateNotification({
      recruiterPayout: { status: "invoice_ready", amount: 12000, currency: "USD" },
      candidate: { name: "Ada Lovelace" },
    }, {
      recruiterPayout: { status: "paid", amount: 12000, currency: "USD" },
      candidate: { name: "Ada Lovelace" },
    })
    assert.equal(notification?.title, "Payout paid for Ada Lovelace")
    assert.match(notification?.body ?? "", /\$12,000/)
    assert.match(notification?.body ?? "", /Status: paid/)
  })

  it("does not notify again when payout fields are unchanged", () => {
    assert.equal(payoutUpdateNotification({
      recruiterPayout: { status: "eligible", amount: 12000, currency: "USD", note: "Same note" },
    }, {
      recruiterPayout: { status: "eligible", amount: 12000, currency: "USD", note: "Same note" },
    }), null)
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

  it("allows source-save updates to ignore the same linked sourced candidate", () => {
    const linkKey = hashRecruiterCandidateLink("https://linkedin.com/in/ada")

    assert.equal(recruiterCandidateIdentityConflictForRole({
      realJobId: "role-1",
      recruiterId: "recruiter-a",
      candidateLinkKey: linkKey,
      ignoreSourcedCandidateId: "source-1",
    }, [
      {
        id: "source-1",
        collection: "sourced",
        data: {
          jobId: "role-1",
          recruiterId: "recruiter-a",
          candidateLinkKey: linkKey,
          linkedSubmissionId: "sub-1",
        },
      },
    ]), null)
  })

  it("blocks source-save updates when a different submitted record owns the candidate", () => {
    const linkKey = hashRecruiterCandidateLink("https://linkedin.com/in/ada")

    assert.deepEqual(recruiterCandidateIdentityConflictForRole({
      realJobId: "role-1",
      recruiterId: "recruiter-a",
      candidateLinkKey: linkKey,
      ignoreSourcedCandidateId: "source-1",
    }, [
      {
        id: "sub-2",
        collection: "submissions",
        data: {
          jobId: "role-1",
          recruiterId: "recruiter-b",
          candidateLinkKey: linkKey,
          sourcedCandidateId: "source-2",
        },
      },
    ]), {
      reason: "candidate_already_submitted_for_role",
      docId: "sub-2",
    })
  })

  it("validates recruiter candidate identity checks before submission", () => {
    const result = validateRecruiterCandidateIdentityCheckInput({
      jobId: " public-job-1 ",
      candidate: {
        email: " ADA@Example.com ",
        link: " https://linkedin.com/in/ada ",
      },
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(result.value, {
      jobId: "public-job-1",
      candidate: {
        email: "ada@example.com",
        link: "https://linkedin.com/in/ada",
      },
    })
  })

  it("rejects candidate identity checks without a profile link", () => {
    assert.deepEqual(validateRecruiterCandidateIdentityCheckInput({
      jobId: "public-job-1",
      candidate: { email: "ada@example.com" },
    }), {
      ok: false,
      reason: "missing_candidate_link",
    })
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

  it("accepts a recruiter-sourced candidate without a role for the private candidate bench", () => {
    const result = validateRecruiterSourcedCandidateInput({
      stage: "sourced",
      outreach: { status: "not_contacted" },
      candidate: {
        name: " Grace Hopper ",
        link: " https://linkedin.com/in/grace ",
        notes: " platform systems lead ",
      },
    })

    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.value.jobId, undefined)
    assert.equal(result.value.stage, "sourced")
    assert.deepEqual(result.value.candidate, {
      name: "Grace Hopper",
      link: "https://linkedin.com/in/grace",
      notes: "platform systems lead",
    })
  })

  it("rejects malformed sourced candidate payloads", () => {
    assert.deepEqual(validateRecruiterSourcedCandidateInput({}), {
      ok: false,
      reason: "missing_candidate",
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
      calibrationRequest: { note: 123 },
      candidate: { name: "Ada", link: "https://linkedin.com/in/ada" },
    }), {
      ok: false,
      reason: "invalid_calibration_note",
    })
    assert.deepEqual(validateRecruiterSourcedCandidateInput({
      calibrationRequest: { note: "Is this a fit?" },
      candidate: { name: "Ada", link: "https://linkedin.com/in/ada" },
    }), {
      ok: false,
      reason: "calibration_requires_job",
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
      compensationExpectation: "$180k-$220k",
    },
    checklist: { hard_1: true },
    candidateConsent: true,
  }

  it("requires candidate email for recruiter submissions and normalizes it", () => {
    const result = validateSubmission({ ...validSubmission, sourcedCandidateId: "candidate_123" })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.value.candidate.email, "ada@example.com")
    assert.equal(result.value.candidate.linkedinUrl, "https://linkedin.com/in/ada")
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

  it("accepts missing expected salary range on recruiter submissions", () => {
    const blankResult = validateSubmission({
      ...validSubmission,
      candidate: { ...validSubmission.candidate, compensationExpectation: " " },
    })
    assert.equal(blankResult.ok, true)
    if (blankResult.ok) assert.equal(blankResult.value.candidate.compensationExpectation, undefined)

    const { compensationExpectation: _salary, ...candidateWithoutSalary } = validSubmission.candidate
    const missingResult = validateSubmission({
      ...validSubmission,
      candidate: candidateWithoutSalary,
    })
    assert.equal(missingResult.ok, true)
    if (missingResult.ok) assert.equal(missingResult.value.candidate.compensationExpectation, undefined)
  })

  it("requires a LinkedIn profile URL and canonicalizes it for identity tracking", () => {
    assert.deepEqual(validateSubmission({
      ...validSubmission,
      candidate: {
        ...validSubmission.candidate,
        link: "https://storage.example.com/resumes/ada.pdf",
      },
    }), {
      ok: false,
      reason: "candidate_linkedin_url_required",
    })

    const result = validateSubmission({
      ...validSubmission,
      candidate: {
        ...validSubmission.candidate,
        link: "https://www.linkedin.com/in/Ada-Lovelace/?trk=profile",
      },
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.value.candidate.linkedinUrl, "https://linkedin.com/in/ada-lovelace")
    assert.equal(result.value.candidate.link, "https://linkedin.com/in/ada-lovelace")
  })

  it("accepts optional candidate linkedin and resume urls and stores them on the candidate", () => {
    const result = validateSubmission({
      ...validSubmission,
      candidateLinkedinUrl: "  https://linkedin.com/in/ada-lovelace  ",
      candidateResumeUrl: "https://storage.example.com/resumes/ada.pdf",
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.value.candidate.linkedinUrl, "https://linkedin.com/in/ada-lovelace")
    assert.equal(result.value.candidate.resumeUrl, "https://storage.example.com/resumes/ada.pdf")
    assert.equal(result.value.candidate.link, "https://linkedin.com/in/ada-lovelace")
  })

  it("accepts nested candidate.linkedinUrl / candidate.resumeUrl from newer clients", () => {
    const result = validateSubmission({
      ...validSubmission,
      candidate: {
        ...validSubmission.candidate,
        linkedinUrl: "https://linkedin.com/in/ada-lovelace",
        resumeUrl: "https://storage.example.com/resumes/ada.pdf",
      },
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.value.candidate.linkedinUrl, "https://linkedin.com/in/ada-lovelace")
    assert.equal(result.value.candidate.resumeUrl, "https://storage.example.com/resumes/ada.pdf")
  })

  it("drops unknown fields from the stored value", () => {
    const result = validateSubmission({
      ...validSubmission,
      unexpectedTopLevel: "ignored",
      candidate: { ...validSubmission.candidate, unexpectedNested: "ignored" },
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.value.candidate.linkedinUrl, "https://linkedin.com/in/ada")
    assert.equal("resumeUrl" in result.value.candidate, false)
    assert.equal("unexpectedNested" in result.value.candidate, false)
    assert.equal("unexpectedTopLevel" in result.value, false)
    assert.equal(result.value.candidate.name, "Ada Lovelace")
    assert.equal(result.value.candidate.link, "https://linkedin.com/in/ada")
  })

  it("omits absent optional candidate fields before Firestore writes", () => {
    const result = validateSubmission({
      ...validSubmission,
      candidate: {
        name: "Ada Lovelace",
        email: "ada@example.com",
        link: "https://linkedin.com/in/ada",
        compensationExpectation: "$180k-$220k",
        yoe: " ",
      },
    })

    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal("currentRole" in result.value.candidate, false)
    assert.equal("yoe" in result.value.candidate, false)
    assert.equal("notes" in result.value.candidate, false)
    assert.deepEqual(result.value.candidate, {
      name: "Ada Lovelace",
      email: "ada@example.com",
      link: "https://linkedin.com/in/ada",
      linkedinUrl: "https://linkedin.com/in/ada",
      compensationExpectation: "$180k-$220k",
    })
  })

  it("rejects malformed or oversized candidate urls", () => {
    assert.deepEqual(validateSubmission({
      ...validSubmission,
      candidateLinkedinUrl: 42,
    }), {
      ok: false,
      reason: "invalid_candidate_linkedin_url",
    })
    assert.deepEqual(validateSubmission({
      ...validSubmission,
      candidateLinkedinUrl: "https://linkedin.com/company/wekruit",
    }), {
      ok: false,
      reason: "invalid_candidate_linkedin_url",
    })
    assert.deepEqual(validateSubmission({
      ...validSubmission,
      candidateResumeUrl: `https://x.example/${"a".repeat(500)}`,
    }), {
      ok: false,
      reason: "candidate_resume_url_too_long",
    })
  })

  it("accepts extraFields on submissions, trims values, and drops empty entries", () => {
    const result = validateSubmission({
      ...validSubmission,
      extraFields: {
        portfolio: "  ada.dev/work  ",
        summary: "Strong systems depth",
        blank: "   ",
      },
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(result.value.extraFields, {
      portfolio: "ada.dev/work",
      summary: "Strong systems depth",
    })
  })

  it("keeps old payloads without extraFields working", () => {
    const result = validateSubmission(validSubmission)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal("extraFields" in result.value, false)
  })

  it("rejects malformed or oversized extraFields values", () => {
    assert.deepEqual(validateSubmission({
      ...validSubmission,
      extraFields: { portfolio: 42 },
    }), {
      ok: false,
      reason: "invalid_extra_fields",
    })
    assert.deepEqual(validateSubmission({
      ...validSubmission,
      extraFields: ["portfolio"],
    }), {
      ok: false,
      reason: "invalid_extra_fields",
    })
    assert.deepEqual(validateSubmission({
      ...validSubmission,
      extraFields: { portfolio: "a".repeat(501) },
    }), {
      ok: false,
      reason: "extra_field_too_long",
    })
  })
})

describe("recruiter submission per-job submit fields", () => {
  const submitFields: RecruiterBoardSubmitField[] = [
    { id: "portfolio", label: "Portfolio", kind: "url", required: true },
    { id: "github", label: "GitHub", kind: "url" },
    { id: "summary", label: "Summary", kind: "text" },
  ]

  it("sanitizes malformed submitFields configs from the job doc", () => {
    const fields = sanitizeRecruiterSubmitFields([
      { id: "portfolio", label: "Portfolio", kind: "url", required: true },
      { id: "portfolio", label: "duplicate id dropped", kind: "text" },
      { id: "   ", label: "missing id dropped", kind: "text" },
      "junk-entry",
      { id: "notes", kind: "weird-kind", placeholder: "  Anything else?  " },
    ])
    assert.deepEqual(fields, [
      { id: "portfolio", label: "Portfolio", kind: "url", required: true },
      { id: "notes", label: "notes", kind: "text", placeholder: "Anything else?" },
    ])
    assert.deepEqual(sanitizeRecruiterSubmitFields(undefined), [])
  })

  it("requires configured required fields to be present and non-empty", () => {
    assert.deepEqual(resolveSubmissionExtraFields(submitFields, undefined), {
      ok: false,
      reason: "missing_extra_field_portfolio",
    })
    assert.deepEqual(resolveSubmissionExtraFields(submitFields, { portfolio: "   " }), {
      ok: false,
      reason: "missing_extra_field_portfolio",
    })
  })

  it("normalizes url fields by adding https:// when the scheme is missing", () => {
    const result = resolveSubmissionExtraFields(submitFields, {
      portfolio: "ada.dev/work",
      github: "https://github.com/ada",
      summary: "Systems depth",
    })
    assert.deepEqual(result, {
      ok: true,
      value: {
        portfolio: "https://ada.dev/work",
        github: "https://github.com/ada",
        summary: "Systems depth",
      },
    })
  })

  it("rejects url fields that cannot parse as a URL", () => {
    assert.deepEqual(resolveSubmissionExtraFields(submitFields, {
      portfolio: "not a real url",
    }), {
      ok: false,
      reason: "invalid_extra_field_url_portfolio",
    })
  })

  it("drops unknown extraFields keys silently", () => {
    const result = resolveSubmissionExtraFields(submitFields, {
      portfolio: "ada.dev",
      rogue: "drop me",
    })
    assert.deepEqual(result, { ok: true, value: { portfolio: "https://ada.dev" } })
  })

  it("stores nothing when the job has no submitFields config", () => {
    assert.deepEqual(resolveSubmissionExtraFields([], { rogue: "drop me" }), { ok: true, value: null })
    assert.deepEqual(resolveSubmissionExtraFields([{ id: "github", label: "GitHub", kind: "url" }], undefined), {
      ok: true,
      value: null,
    })
  })
})

describe("recruiter submission status pipeline notifications", () => {
  const reviewingDoc = {
    status: "reviewing",
    jobTitleSnapshot: "Founding Engineer",
    candidate: { name: "Ada Lovelace" },
  }

  it("notifies when a submission moves to a WeKruit interview", () => {
    const notification = submissionFeedbackNotification(reviewingDoc, { ...reviewingDoc, status: "wekruit_interview" })
    assert.equal(notification?.title, "Ada Lovelace is moving to a WeKruit interview")
    assert.match(notification?.body ?? "", /Status: in a WeKruit interview/)
    const email = composeRecruiterSubmissionUpdateEmail({
      title: notification!.title,
      body: notification!.body,
      roleTitle: "Founding Engineer",
      companyLabel: "Co. B",
    })
    assert.equal(email.subject, "WeKruit update: Ada Lovelace is moving to a WeKruit interview")
  })

  it("notifies when a submission is sent to the client", () => {
    const notification = submissionFeedbackNotification(reviewingDoc, { ...reviewingDoc, status: "client_review" })
    assert.equal(notification?.title, "Ada Lovelace was sent to the client")
    assert.match(notification?.body ?? "", /Status: with the client/)
  })

  it("notifies with congratulations when a submission is hired", () => {
    const notification = submissionFeedbackNotification(
      { ...reviewingDoc, status: "client_review" },
      { ...reviewingDoc, status: "hired" },
    )
    assert.equal(notification?.title, "Ada Lovelace was hired — congratulations")
    assert.match(notification?.body ?? "", /Status: hired/)
  })

  it("prefers the pipeline transition title when feedback fields change in the same write", () => {
    const notification = submissionFeedbackNotification(reviewingDoc, {
      ...reviewingDoc,
      status: "wekruit_interview",
      recruiterFeedbackRating: 4,
    })
    assert.equal(notification?.title, "Ada Lovelace is moving to a WeKruit interview")
    assert.match(notification?.body ?? "", /Rating 4\/4/)
  })

  it("builds flywheel events for the new pipeline statuses", () => {
    const interview = buildRecruiterSubmissionFeedbackEvent({
      triggerEventId: "evt-wk-1",
      submissionId: "sub-wk-1",
      createdAt: "2026-06-09T12:00:00.000Z",
      before: { status: "reviewing", jobId: "job-1", recruiterId: "recruiter-1" },
      after: { status: "wekruit_interview", jobId: "job-1", recruiterId: "recruiter-1" },
    })
    assert.equal(interview?.outcome, "wekruit_interview")
    const client = buildRecruiterSubmissionFeedbackEvent({
      triggerEventId: "evt-wk-2",
      submissionId: "sub-wk-2",
      createdAt: "2026-06-09T12:00:00.000Z",
      before: { status: "wekruit_interview", jobId: "job-1", recruiterId: "recruiter-1" },
      after: { status: "client_review", jobId: "job-1", recruiterId: "recruiter-1" },
    })
    assert.equal(client?.outcome, "client_review")
  })
})

describe("recruiter submission update email preferences", () => {
  it("defaults submission update emails on when the preference is absent", () => {
    assert.equal(recruiterSubmissionUpdateEmailsEnabled(null), true)
    assert.equal(recruiterSubmissionUpdateEmailsEnabled({}), true)
    assert.equal(recruiterSubmissionUpdateEmailsEnabled({ notificationPreferences: {} }), true)
    assert.equal(recruiterSubmissionUpdateEmailsEnabled({ notificationPreferences: { submissionUpdatesEmail: true } }), true)
    assert.equal(recruiterSubmissionUpdateEmailsEnabled({ notificationPreferences: { submissionUpdatesEmail: false } }), false)
  })

  it("skips the email but records the notification breadcrumb when the recruiter opted out", async () => {
    const db = memoryFirestore()
    const status = await sendRecruiterSubmissionUpdateEmail(db as never, "notif-opt-out", {
      to: "sloane@agency.com",
      emailOptedOut: true,
      title: "Ada Lovelace is moving to a WeKruit interview",
      body: "Founding Engineer · Status: in a WeKruit interview",
    })
    assert.equal(status, "skipped")
    const doc = db.get("pa-recruiter-notifications/notif-opt-out") as Record<string, unknown>
    assert.equal(doc.emailStatus, "skipped")
    assert.equal(doc.emailLastError, "submission_updates_email_disabled")
  })

  it("still attempts the email when the recruiter has not opted out", async () => {
    const db = memoryFirestore()
    const saved = { apiKey: process.env.MAILGUN_API_KEY, domain: process.env.MAILGUN_DOMAIN }
    delete process.env.MAILGUN_API_KEY
    delete process.env.MAILGUN_DOMAIN
    try {
      const status = await sendRecruiterSubmissionUpdateEmail(db as never, "notif-enabled", {
        to: "sloane@agency.com",
        emailOptedOut: false,
        title: "Ada Lovelace was sent to the client",
        body: "Founding Engineer · Status: with the client",
      })
      assert.equal(status, "not_configured")
      const doc = db.get("pa-recruiter-notifications/notif-enabled") as Record<string, unknown>
      assert.equal(doc.emailStatus, "not_configured")
    } finally {
      if (saved.apiKey !== undefined) process.env.MAILGUN_API_KEY = saved.apiKey
      if (saved.domain !== undefined) process.env.MAILGUN_DOMAIN = saved.domain
    }
  })
})

describe("recruiter notification preference updates", () => {
  const current = { newRolesEmail: true, submissionUpdatesEmail: true }

  it("merges only the provided preference keys", () => {
    assert.deepEqual(mergeRecruiterNotificationPreferences(current, { submissionUpdatesEmail: false }), {
      ok: true,
      value: { newRolesEmail: true, submissionUpdatesEmail: false },
    })
    assert.deepEqual(mergeRecruiterNotificationPreferences(
      { newRolesEmail: false, submissionUpdatesEmail: false },
      { newRolesEmail: true },
    ), {
      ok: true,
      value: { newRolesEmail: true, submissionUpdatesEmail: false },
    })
    assert.deepEqual(mergeRecruiterNotificationPreferences(current, {
      newRolesEmail: false,
      submissionUpdatesEmail: false,
    }), {
      ok: true,
      value: { newRolesEmail: false, submissionUpdatesEmail: false },
    })
  })

  it("rejects malformed preference updates", () => {
    assert.deepEqual(mergeRecruiterNotificationPreferences(current, null), {
      ok: false,
      reason: "invalid_notification_preferences",
    })
    assert.deepEqual(mergeRecruiterNotificationPreferences(current, {}), {
      ok: false,
      reason: "missing_notification_preferences_update",
    })
    assert.deepEqual(mergeRecruiterNotificationPreferences(current, { newRolesEmail: "yes" }), {
      ok: false,
      reason: "invalid_new_roles_email",
    })
    assert.deepEqual(mergeRecruiterNotificationPreferences(current, { submissionUpdatesEmail: 1 }), {
      ok: false,
      reason: "invalid_submission_updates_email",
    })
  })

  it("requires recruiter Bearer auth on the preferences endpoint", async () => {
    const out: { statusCode?: number; body?: unknown } = {}
    // Minimal express-shaped res: the v2 onRequest wrapper registers a
    // "finish" listener and runs the cors middleware before the handler.
    const res = {
      set: () => {},
      setHeader: () => {},
      getHeader: () => undefined,
      end: () => {},
      on: () => {},
      status: (code: number) => {
        out.statusCode = code
        return {
          json: (body: unknown) => { out.body = body },
          send: (body: unknown) => { out.body = body },
        }
      },
    }
    const req = {
      method: "POST",
      headers: {},
      body: { notificationPreferences: { submissionUpdatesEmail: false } },
      get: () => undefined,
    }
    await recruiterBoardEntrypoint.paRecruiterPreferencesUpdate(req as never, res as never)
    assert.equal(out.statusCode, 401)
    assert.deepEqual(out.body, { ok: false, reason: "unauthorized" })
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

describe("fetchCollabJobs priority", () => {
  it("exposes only tier+rank and strips internal note/emailAudience", async () => {
    const db = fakeDb([
      {
        id: "urgent-role",
        data: () => ({
          title: "Staff Engineer",
          publicId: "p-urgent",
          recruiterBoard: {
            ...sampleRecruiterBoard,
            priority: {
              tier: "urgent",
              rank: 3,
              note: "ping the top recruiters",
              emailAudience: "recruiters",
              updatedByEmail: "ops@wekruit.com",
            },
          },
        }),
      },
    ])
    const { jobs } = await fetchCollabJobs(db as never, { isAdmin: false })
    assert.deepEqual(jobs[0]!.recruiterBoard.priority, { tier: "urgent", rank: 3 })
  })

  it("omits priority for a normal/unranked role so no badge renders", async () => {
    const db = fakeDb([
      {
        id: "plain-role",
        data: () => ({
          title: "Engineer",
          publicId: "p-plain",
          recruiterBoard: { ...sampleRecruiterBoard, priority: { tier: "normal", rank: null } },
        }),
      },
    ])
    const { jobs } = await fetchCollabJobs(db as never, { isAdmin: false })
    assert.equal(jobs[0]!.recruiterBoard.priority, undefined)
  })

  it("sorts urgent above a lower-sortOrder normal role, and paused last", async () => {
    const db = fakeDb([
      {
        id: "normal-first-by-sortorder",
        data: () => ({
          title: "Normal role",
          publicId: "p-normal",
          recruiterBoard: { ...sampleRecruiterBoard, sortOrder: 0 },
        }),
      },
      {
        id: "urgent-high-sortorder",
        data: () => ({
          title: "Urgent role",
          publicId: "p-urgent2",
          recruiterBoard: { ...sampleRecruiterBoard, sortOrder: 99, priority: { tier: "urgent", rank: null } },
        }),
      },
      {
        id: "paused-low-sortorder",
        data: () => ({
          title: "Paused role",
          publicId: "p-paused",
          recruiterBoard: { ...sampleRecruiterBoard, sortOrder: 1, priority: { tier: "paused", rank: null } },
        }),
      },
    ])
    const { jobs } = await fetchCollabJobs(db as never, { isAdmin: false })
    assert.deepEqual(jobs.map((j) => j.title), ["Urgent role", "Normal role", "Paused role"])
  })
})

describe("fetchCollabJobs anonymous payload", () => {
  it("returns publicId as jobId and real company name when isAdmin === false", async () => {
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
    assert.equal(jobs[0]!.recruiterBoard.label.company, "Helium Robotics, Inc.")
  })

  it("keeps recruiterBoard.submitFields intact for anonymous callers", async () => {
    const submitFields: RecruiterBoardSubmitField[] = [
      { id: "portfolio", label: "Portfolio", kind: "url", required: true },
      { id: "summary", label: "Summary", kind: "text", placeholder: "Why this candidate?" },
    ]
    const db = fakeDb([
      {
        id: "helium-product-engineer-fullstack",
        data: () => ({
          title: "Product Engineer (Fullstack)",
          publicId: "11111111-2222-3333-4444-555555555555",
          recruiterBoard: { ...sampleRecruiterBoard, submitFields },
        }),
      },
    ])
    const anonymous = await fetchCollabJobs(db as never, { isAdmin: false })
    assert.deepEqual(anonymous.jobs[0]!.recruiterBoard.submitFields, submitFields)
    assert.equal(anonymous.jobs[0]!.recruiterBoard.label.company, "Helium Robotics, Inc.")
    const admin = await fetchCollabJobs(db as never, { isAdmin: true })
    assert.deepEqual(admin.jobs[0]!.recruiterBoard.submitFields, submitFields)
  })

  it("preserves company label from recruiterBoard as-is", async () => {
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
    assert.equal(jobs[0]!.jobId, "legacy-job-no-publicid")
    assert.equal(jobs[0]!.recruiterBoard.label.company, "Helium Robotics, Inc.")
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
    assert.equal(jobs[0]!.recruiterBoard.label.company, "Helium Robotics, Inc.")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Synthesized default payload — collaborated docs with no recruiterBoard
// ─────────────────────────────────────────────────────────────────────────────

describe("fetchCollabJobs synthesized default payload", () => {
  it("surfaces a collaborated doc missing recruiterBoard with a synthesized default", async () => {
    const db = fakeDb([
      {
        id: "sekai-founding-engineer",
        data: () => ({
          title: "Founding Engineer",
          companyName: "Sekai",
          publicId: "pub-sekai-founding-engineer",
        }),
      },
    ])
    const { jobs, total } = await fetchCollabJobs(db as never, { isAdmin: false })
    assert.equal(total, 1)
    assert.equal(jobs.length, 1)
    const job = jobs[0]!
    assert.equal(job.jobId, "pub-sekai-founding-engineer")
    assert.equal(job.title, "Founding Engineer")
    assert.equal(job.recruiterBoard.active, true)
    assert.equal(job.recruiterBoard.label.company, "Sekai")
    assert.deepEqual(job.recruiterBoard.label.pills, [])
    assert.deepEqual(job.recruiterBoard.checklist.groups, [])
    assert.deepEqual(job.recruiterBoard.culture.bullets, [])
  })

  it("falls back to the `company` field for the synthesized label", async () => {
    const db = fakeDb([
      {
        id: "hyde-job",
        data: () => ({ title: "GTM Lead", company: "Hyde", publicId: "pub-hyde" }),
      },
    ])
    const { jobs } = await fetchCollabJobs(db as never, { isAdmin: false })
    assert.equal(jobs.length, 1)
    assert.equal(jobs[0]!.recruiterBoard.label.company, "Hyde")
  })

  it("sorts synthesized rows after explicitly-ordered rows", async () => {
    const db = fakeDb([
      {
        id: "uncurated",
        data: () => ({ title: "Uncurated", companyName: "Kapibala", publicId: "pub-uncurated" }),
      },
      {
        id: "curated",
        data: () => ({
          title: "Curated",
          publicId: "pub-curated",
          recruiterBoard: { ...sampleRecruiterBoard, sortOrder: 999 },
        }),
      },
    ])
    const { jobs } = await fetchCollabJobs(db as never, { isAdmin: false })
    assert.equal(jobs.length, 2)
    assert.equal(jobs[0]!.jobId, "pub-curated")
    assert.equal(jobs[1]!.jobId, "pub-uncurated")
  })

  it("keeps explicitly hidden rows hidden — synthesis never overrides active === false", async () => {
    const db = fakeDb([
      {
        id: "deliberately-hidden",
        data: () => ({
          title: "Hidden",
          publicId: "pub-hidden",
          recruiterBoard: { ...sampleRecruiterBoard, active: false },
        }),
      },
      {
        id: "uncurated",
        data: () => ({ title: "Visible", companyName: "WeKruit", publicId: "pub-visible" }),
      },
    ])
    const { jobs } = await fetchCollabJobs(db as never, { isAdmin: false })
    assert.equal(jobs.length, 1)
    assert.equal(jobs[0]!.jobId, "pub-visible")
  })

  it("does not surface synthesized rows in the filled (active === false) list", async () => {
    const db = fakeDb([
      {
        id: "uncurated",
        data: () => ({ title: "Visible", companyName: "WeKruit", publicId: "pub-visible" }),
      },
    ])
    const { jobs } = await fetchCollabJobs(db as never, { isAdmin: false, status: "filled" })
    assert.equal(jobs.length, 0)
  })

  it("logs recruiter_board.synthesized_default_payload with count + ids", async () => {
    const calls: Array<{ msg: string; meta: Record<string, unknown> }> = []
    const original = logger.info
    ;(logger as { info: unknown }).info = (msg: string, meta: Record<string, unknown>) => {
      calls.push({ msg, meta })
    }
    try {
      const db = fakeDb([
        {
          id: "sekai-founding-engineer",
          data: () => ({ title: "Founding Engineer", companyName: "Sekai" }),
        },
        {
          id: "curated",
          data: () => ({
            title: "Curated",
            publicId: "pub-curated",
            recruiterBoard: sampleRecruiterBoard,
          }),
        },
      ])
      await fetchCollabJobs(db as never, { isAdmin: true })
    } finally {
      ;(logger as { info: unknown }).info = original
    }
    const drift = calls.find((c) => c.msg === "recruiter_board.synthesized_default_payload")
    assert.ok(drift, "expected recruiter_board.synthesized_default_payload log")
    assert.equal(drift!.meta.count, 1)
    assert.deepEqual(drift!.meta.ids, ["sekai-founding-engineer"])
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

// ─────────────────────────────────────────────────────────────────────────────
// Sheet model — checklist cell levels, candidate core cells, row edits, thread
// ─────────────────────────────────────────────────────────────────────────────

function nestedMemoryFirestore(seed: Record<string, Record<string, unknown>> = {}) {
  const docs = new Map<string, Record<string, unknown>>()
  for (const [key, value] of Object.entries(seed)) docs.set(key, { ...value })
  const makeSnap = (key: string) => ({
    exists: docs.has(key),
    id: key.slice(key.lastIndexOf("/") + 1),
    data: () => docs.get(key),
  })
  const makeRef = (key: string) => ({
    id: key.slice(key.lastIndexOf("/") + 1),
    get: async () => makeSnap(key),
    set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
      docs.set(key, opts?.merge ? { ...(docs.get(key) ?? {}), ...data } : { ...data })
    },
    update: async (data: Record<string, unknown>) => {
      if (!docs.has(key)) throw new Error(`NOT_FOUND: ${key}`)
      docs.set(key, { ...docs.get(key)!, ...data })
    },
    create: async (data: Record<string, unknown>) => {
      if (docs.has(key)) throw new Error("ALREADY_EXISTS")
      docs.set(key, { ...data })
    },
    collection: (sub: string) => makeCollection(`${key}/${sub}`),
  })
  const makeCollection = (collectionPath: string): Record<string, unknown> => ({
    doc: (docId: string) => makeRef(`${collectionPath}/${docId}`),
    get: async () => ({
      docs: [...docs.keys()]
        .filter((key) => key.startsWith(`${collectionPath}/`) && !key.slice(collectionPath.length + 1).includes("/"))
        .map((key) => makeSnap(key)),
    }),
  })
  return {
    db: { collection: (name: string) => makeCollection(name) },
    docs,
    findKey: (prefix: string) => [...docs.keys()].find((key) => key.startsWith(prefix)),
  }
}

const sheetRecruiter: RecruiterProfilePublic = {
  recruiterId: "rec-1",
  firebaseUid: "rec-1",
  name: "Sloane",
  email: "sloane@agency.com",
  notificationPreferences: { newRolesEmail: true, submissionUpdatesEmail: true },
  workspacePreferences: { primaryRoleIds: [] },
}

const otherSheetRecruiter: RecruiterProfilePublic = {
  ...sheetRecruiter,
  recruiterId: "rec-2",
  firebaseUid: "rec-2",
  email: "other@agency.com",
}

function sheetSubmissionSeed(
  submissionOverrides: Record<string, unknown> = {},
): Record<string, Record<string, unknown>> {
  return {
    "pa-jobs/job-1": {
      title: "Founding Engineer",
      publicId: "public-job-1",
      wekruitCollaborationStatus: "collaborated",
      recruiterBoard: {
        active: true,
        sortOrder: 1,
        label: { company: "Co. B", companyCode: "B", location: "San Francisco", pills: [] },
        culture: { bet: "", bullets: [] },
        checklist: { groups: sampleGroups },
        submitFields: [{ id: "portfolio", label: "Portfolio", kind: "url", required: true }],
      },
    },
    "pa-recruiter-submissions/sub-1": {
      submissionId: "sub-1",
      jobId: "job-1",
      inboundJobId: "public-job-1",
      jobTitleSnapshot: "Founding Engineer",
      companyLabelSnapshot: "Co. B",
      recruiterId: "rec-1",
      recruiterEmail: "sloane@agency.com",
      status: "reviewing",
      candidate: {
        name: "Ada Lovelace",
        email: "ada@example.com",
        link: "https://linkedin.com/in/ada",
        notes: "old note",
      },
      checklist: { h1: true, f1: true },
      extraFields: { portfolio: "https://ada.dev" },
      ...submissionOverrides,
    },
  }
}

describe("checklist cell coercion", () => {
  it("keeps legacy boolean payloads working by coercing true to yes and dropping false", () => {
    const result = coerceSubmissionChecklistInput({ h1: true, h2: false, f1: true })
    assert.deepEqual(result, { ok: true, value: { h1: "yes", f1: "yes" } })
  })

  it("accepts the four string levels verbatim", () => {
    const result = coerceSubmissionChecklistInput({ h1: "strong", h2: "yes", f1: "partial", a1: "no" })
    assert.deepEqual(result, {
      ok: true,
      value: { h1: "strong", h2: "yes", f1: "partial", a1: "no" },
    })
  })

  it("rejects unknown checklist values", () => {
    assert.deepEqual(coerceSubmissionChecklistInput({ h1: "maybe" }), {
      ok: false,
      reason: "invalid_checklist_value",
    })
    assert.deepEqual(coerceSubmissionChecklistInput({ h1: 1 }), {
      ok: false,
      reason: "invalid_checklist_value",
    })
  })

  it("coerces stored legacy boolean maps leniently for list reads", () => {
    assert.deepEqual(coerceStoredSubmissionChecklist({ h1: true, h2: false, f1: "strong", junk: 42 }), {
      h1: "yes",
      f1: "strong",
    })
    assert.deepEqual(coerceStoredSubmissionChecklist(null), {})
  })

  it("scores strong and yes as checked; partial and no as unchecked", () => {
    const score = computeSubmissionScore(sampleGroups, {
      h1: "strong", h2: "yes", h3: "partial",
      f1: "no", f2: "yes",
      b1: "partial",
    })
    assert.equal(score.hardChecked, 2)
    assert.equal(score.hardTotal, 3)
    assert.equal(score.fitChecked, 1)
    assert.equal(score.bonusChecked, 0)
  })

  it("does not flag anti items marked partial", () => {
    const score = computeSubmissionScore(sampleGroups, { a1: "partial", a2: "no" })
    assert.equal(score.antiChecked, 0)
    assert.equal(score.antiTotal, 2)
    const flagged = computeSubmissionScore(sampleGroups, { a1: "strong" })
    assert.equal(flagged.antiChecked, 1)
  })

  it("coerces legacy boolean checklists on submission create", () => {
    const result = validateSubmission({
      jobId: "public-job-1",
      source: "hiring-board",
      submitter: { name: "Sloane", email: "sloane@agency.com" },
      candidate: { name: "Ada", email: "ada@example.com", link: "https://linkedin.com/in/ada", compensationExpectation: "$180k-$220k" },
      checklist: { hard_1: true, hard_2: false, fit_1: "strong" },
      candidateConsent: true,
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(result.value.checklist, { hard_1: "yes", fit_1: "strong" })
  })

  it("accepts a submission with no candidateConsent — submit is the consent (recruiter-asserted)", () => {
    // Regression: WeKruit never contacts candidates, so a submission must never be
    // rejected for a missing candidateConsent flag. The recruiter UI no longer sends
    // one; the old candidate_consent_required gate broke every submission.
    const result = validateSubmission({
      jobId: "public-job-1",
      submitter: { name: "Sloane", email: "sloane@agency.com" },
      candidate: { name: "Ada", email: "ada@example.com", link: "https://linkedin.com/in/ada", compensationExpectation: "$180k-$220k" },
      checklist: { hard_1: "yes" },
      // intentionally no candidateConsent
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.value.candidateConsent, true)
  })

  it("captures candidateBackground self-flags, sanitized, and never blocks the submit", () => {
    const result = validateSubmission({
      jobId: "public-job-1",
      submitter: { name: "Sloane", email: "sloane@agency.com" },
      candidate: { name: "Ada", email: "ada@example.com", link: "https://linkedin.com/in/ada", compensationExpectation: "$180k-$220k" },
      checklist: {},
      candidateBackground: { school: "weak", company: "strong", gpa: "bogus", junkKey: "weak" },
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    // unknown keys (junkKey) and invalid values (gpa: "bogus") are dropped
    assert.deepEqual(result.value.candidateBackground, { school: "weak", company: "strong" })
  })

  it("rejects malformed checklist values on submission create", () => {
    assert.deepEqual(validateSubmission({
      jobId: "public-job-1",
      submitter: { name: "Sloane", email: "sloane@agency.com" },
      candidate: { name: "Ada", email: "ada@example.com", link: "https://linkedin.com/in/ada" },
      checklist: { hard_1: "kinda" },
      candidateConsent: true,
    }), {
      ok: false,
      reason: "invalid_checklist_value",
    })
  })
})

describe("candidate core cells", () => {
  const baseSubmission = {
    jobId: "public-job-1",
    submitter: { name: "Sloane", email: "sloane@agency.com" },
    candidate: {
      name: "Ada Lovelace",
      email: "ada@example.com",
      link: "https://linkedin.com/in/ada",
      compensationExpectation: "$180k-$220k",
    },
    checklist: { h1: true },
    candidateConsent: true,
  }

  it("accepts, trims, and stores the seven core cells on create", () => {
    const result = validateSubmission({
      ...baseSubmission,
      candidate: {
        ...baseSubmission.candidate,
        currentCompany: "  Acme Robotics  ",
        location: " Brooklyn, NY ",
        workAuthorization: " US citizen ",
        employmentStatus: " employed ",
        compensationExpectation: " $180k base ",
        noticePeriod: " 2 weeks ",
        interviewAvailability: " weekday mornings ",
      },
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.value.candidate.currentCompany, "Acme Robotics")
    assert.equal(result.value.candidate.location, "Brooklyn, NY")
    assert.equal(result.value.candidate.workAuthorization, "US citizen")
    assert.equal(result.value.candidate.employmentStatus, "employed")
    assert.equal(result.value.candidate.compensationExpectation, "$180k base")
    assert.equal(result.value.candidate.noticePeriod, "2 weeks")
    assert.equal(result.value.candidate.interviewAvailability, "weekday mornings")
  })

  it("never writes absent or blank core cells", () => {
    const result = validateSubmission({
      ...baseSubmission,
      candidate: { ...baseSubmission.candidate, currentCompany: "  ", noticePeriod: "" },
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    for (const field of [
      "currentCompany",
      "location",
      "workAuthorization",
      "employmentStatus",
      "noticePeriod",
      "interviewAvailability",
    ]) {
      assert.equal(field in result.value.candidate, false, `${field} must be omitted`)
    }
    assert.equal(result.value.candidate.compensationExpectation, "$180k-$220k")
  })

  it("rejects non-string or oversized core cells", () => {
    assert.deepEqual(validateSubmission({
      ...baseSubmission,
      candidate: { ...baseSubmission.candidate, workAuthorization: 42 },
    }), {
      ok: false,
      reason: "invalid_workAuthorization",
    })
    assert.deepEqual(validateSubmission({
      ...baseSubmission,
      candidate: { ...baseSubmission.candidate, compensationExpectation: "x".repeat(301) },
    }), {
      ok: false,
      reason: "compensationExpectation_too_long",
    })
  })

  it("round-trips core cells and the coerced checklist through the list shape", () => {
    const row = publicRecruiterSubmission({
      id: "sub-1",
      data: () => ({
        jobId: "job-1",
        status: "reviewing",
        candidate: {
          name: "Ada Lovelace",
          email: "ada@example.com",
          link: "https://linkedin.com/in/ada",
          linkedinUrl: "https://linkedin.com/in/ada-lovelace",
          currentCompany: "Acme Robotics",
          location: "Brooklyn, NY",
          workAuthorization: "US citizen",
          employmentStatus: "employed",
          compensationExpectation: "$180k base",
          noticePeriod: "2 weeks",
          interviewAvailability: "weekday mornings",
          junk: 42,
        },
        checklist: { h1: true, h2: false, f1: "partial" },
      }),
    })
    assert.deepEqual(row.candidate, {
      name: "Ada Lovelace",
      email: "ada@example.com",
      link: "https://linkedin.com/in/ada",
      linkedinUrl: "https://linkedin.com/in/ada-lovelace",
      currentCompany: "Acme Robotics",
      location: "Brooklyn, NY",
      workAuthorization: "US citizen",
      employmentStatus: "employed",
      compensationExpectation: "$180k base",
      noticePeriod: "2 weeks",
      interviewAvailability: "weekday mornings",
    })
    assert.deepEqual(row.checklist, { h1: "yes", f1: "partial" })
  })
})

describe("recruiter submission update validation", () => {
  it("requires a well-formed submission id", () => {
    assert.deepEqual(validateRecruiterSubmissionUpdateInput({ candidate: { notes: "x" } }), {
      ok: false,
      reason: "missing_submission_id",
    })
    assert.deepEqual(validateRecruiterSubmissionUpdateInput({ submissionId: "../bad", candidate: { notes: "x" } }), {
      ok: false,
      reason: "invalid_submission_id",
    })
  })

  it("requires at least one editable section", () => {
    assert.deepEqual(validateRecruiterSubmissionUpdateInput({ submissionId: "sub-1" }), {
      ok: false,
      reason: "missing_update",
    })
    assert.deepEqual(validateRecruiterSubmissionUpdateInput({
      submissionId: "sub-1",
      candidate: { name: "Ada", email: "new@example.com", link: "https://x", unknownField: "x" },
    }), {
      ok: false,
      reason: "missing_update",
    })
  })

  it("trims editable candidate fields, keeps empty string as a clear marker, and ignores identity fields", () => {
    const result = validateRecruiterSubmissionUpdateInput({
      submissionId: "sub-1",
      candidate: {
        name: "Hacked Name",
        email: "hacked@example.com",
        link: "https://hacked.example",
        currentCompany: "  Acme  ",
        notes: "",
        linkedinUrl: " https://linkedin.com/in/ada ",
      },
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(result.value.candidate, {
      currentCompany: "Acme",
      notes: "",
      linkedinUrl: "https://linkedin.com/in/ada",
    })
  })

  it("applies create-equivalent limits to edited candidate fields", () => {
    assert.deepEqual(validateRecruiterSubmissionUpdateInput({
      submissionId: "sub-1",
      candidate: { noticePeriod: 42 },
    }), {
      ok: false,
      reason: "invalid_noticePeriod",
    })
    assert.deepEqual(validateRecruiterSubmissionUpdateInput({
      submissionId: "sub-1",
      candidate: { location: "x".repeat(301) },
    }), {
      ok: false,
      reason: "location_too_long",
    })
    assert.deepEqual(validateRecruiterSubmissionUpdateInput({
      submissionId: "sub-1",
      candidate: { linkedinUrl: `https://x.example/${"a".repeat(500)}` },
    }), {
      ok: false,
      reason: "candidate_linkedin_url_too_long",
    })
  })

  it("allows clearing expected salary range on recruiter edits", () => {
    assert.deepEqual(validateRecruiterSubmissionUpdateInput({
      submissionId: "sub-1",
      candidate: { compensationExpectation: "  " },
    }), {
      ok: true,
      value: {
        submissionId: "sub-1",
        candidate: { compensationExpectation: "" },
      },
    })
  })

  it("coerces checklist edits with the create rules", () => {
    const result = validateRecruiterSubmissionUpdateInput({
      submissionId: "sub-1",
      checklist: { h1: true, h2: false, h3: "partial" },
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(result.value.checklist, { h1: "yes", h3: "partial" })
    assert.deepEqual(validateRecruiterSubmissionUpdateInput({
      submissionId: "sub-1",
      checklist: { h1: "nope" },
    }), {
      ok: false,
      reason: "invalid_checklist_value",
    })
  })

  it("cleans extraFields edits with the create rules", () => {
    const result = validateRecruiterSubmissionUpdateInput({
      submissionId: "sub-1",
      extraFields: { portfolio: "  ada.dev/work  ", blank: "  " },
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(result.value.extraFields, { portfolio: "ada.dev/work" })
    assert.deepEqual(validateRecruiterSubmissionUpdateInput({
      submissionId: "sub-1",
      extraFields: { portfolio: 9 },
    }), {
      ok: false,
      reason: "invalid_extra_fields",
    })
  })
})

describe("recruiter submission update endpoint behavior", () => {
  it("rejects edits from a non-owning recruiter with 403", async () => {
    const fake = nestedMemoryFirestore(sheetSubmissionSeed())
    const result = await applyRecruiterSubmissionUpdate(fake.db as never, otherSheetRecruiter, {
      submissionId: "sub-1",
      candidate: { notes: "mine now" },
    })
    assert.deepEqual(result, { ok: false, status: 403, reason: "forbidden" })
    const stored = fake.docs.get("pa-recruiter-submissions/sub-1") as Record<string, unknown>
    assert.equal((stored.candidate as Record<string, unknown>).notes, "old note")
  })

  it("returns 404 for a missing submission", async () => {
    const fake = nestedMemoryFirestore()
    const result = await applyRecruiterSubmissionUpdate(fake.db as never, sheetRecruiter, {
      submissionId: "sub-404",
      candidate: { notes: "x" },
    })
    assert.deepEqual(result, { ok: false, status: 404, reason: "submission_not_found" })
  })

  it("locks the row with 409 once the submission reaches client_review", async () => {
    const fake = nestedMemoryFirestore(sheetSubmissionSeed({ status: "client_review" }))
    const result = await applyRecruiterSubmissionUpdate(fake.db as never, sheetRecruiter, {
      submissionId: "sub-1",
      candidate: { notes: "too late" },
    })
    assert.deepEqual(result, { ok: false, status: 409, reason: "row_locked" })
  })

  it("keeps the row editable through submitted, new, reviewing, and wekruit_interview", async () => {
    for (const status of ["submitted", "new", "reviewing", "wekruit_interview"]) {
      const fake = nestedMemoryFirestore(sheetSubmissionSeed({ status }))
      const result = await applyRecruiterSubmissionUpdate(fake.db as never, sheetRecruiter, {
        submissionId: "sub-1",
        candidate: { currentCompany: "Acme" },
      })
      assert.equal(result.ok, true, `status ${status} must stay editable`)
    }
  })

  it("merges candidate cells, clears empty-string fields, and stamps the edit audit", async () => {
    const fake = nestedMemoryFirestore(sheetSubmissionSeed())
    const result = await applyRecruiterSubmissionUpdate(fake.db as never, sheetRecruiter, {
      submissionId: "sub-1",
      candidate: { currentCompany: "Acme Robotics", noticePeriod: "2 weeks", notes: "" },
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    const stored = fake.docs.get("pa-recruiter-submissions/sub-1") as Record<string, unknown>
    const candidate = stored.candidate as Record<string, unknown>
    assert.equal(candidate.name, "Ada Lovelace")
    assert.equal(candidate.email, "ada@example.com")
    assert.equal(candidate.currentCompany, "Acme Robotics")
    assert.equal(candidate.noticePeriod, "2 weeks")
    assert.equal("notes" in candidate, false)
    assert.equal(stored.lastEditedBy, "recruiter")
    assert.ok(stored.lastEditedAt)
    assert.equal(result.submission.candidate?.currentCompany, "Acme Robotics")
    assert.equal(result.submission.candidate?.noticePeriod, "2 weeks")
  })

  it("recomputes the score when checklist cells change", async () => {
    const fake = nestedMemoryFirestore(sheetSubmissionSeed())
    const result = await applyRecruiterSubmissionUpdate(fake.db as never, sheetRecruiter, {
      submissionId: "sub-1",
      checklist: { h2: "strong", h3: "partial", a1: "no" },
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    const expectedChecklist: Record<string, ChecklistCellLevel> = {
      h1: "yes",
      f1: "yes",
      h2: "strong",
      h3: "partial",
      a1: "no",
    }
    assert.deepEqual(result.submission.checklist, expectedChecklist)
    assert.deepEqual(result.submission.score, {
      hardChecked: 2, hardTotal: 3,
      fitChecked: 1, fitTotal: 2,
      bonusChecked: 0, bonusTotal: 1,
      antiChecked: 0, antiTotal: 2,
    })
    const stored = fake.docs.get("pa-recruiter-submissions/sub-1") as Record<string, unknown>
    assert.deepEqual(stored.checklist, expectedChecklist)
  })

  it("re-validates extraFields against the job submitFields config", async () => {
    const missingRequired = nestedMemoryFirestore(sheetSubmissionSeed())
    assert.deepEqual(await applyRecruiterSubmissionUpdate(missingRequired.db as never, sheetRecruiter, {
      submissionId: "sub-1",
      extraFields: {},
    }), {
      ok: false,
      status: 400,
      reason: "missing_extra_field_portfolio",
    })

    const fake = nestedMemoryFirestore(sheetSubmissionSeed())
    const result = await applyRecruiterSubmissionUpdate(fake.db as never, sheetRecruiter, {
      submissionId: "sub-1",
      extraFields: { portfolio: "ada.dev/work", rogue: "drop me" },
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(result.submission.extraFields, { portfolio: "https://ada.dev/work" })
  })

  it("returns 404 job_not_found when scoring config is unavailable", async () => {
    const seed = sheetSubmissionSeed()
    delete (seed as Record<string, unknown>)["pa-jobs/job-1"]
    const fake = nestedMemoryFirestore(seed)
    const result = await applyRecruiterSubmissionUpdate(fake.db as never, sheetRecruiter, {
      submissionId: "sub-1",
      checklist: { h1: "strong" },
    })
    assert.deepEqual(result, { ok: false, status: 404, reason: "job_not_found" })
  })

  it("does not fire recruiter-facing notifications for cell edits", () => {
    const before = sheetSubmissionSeed()["pa-recruiter-submissions/sub-1"]!
    const after = {
      ...before,
      candidate: { ...(before.candidate as Record<string, unknown>), currentCompany: "Acme" },
      checklist: { h1: "yes", f1: "yes", h2: "strong" },
      lastEditedBy: "recruiter",
    }
    assert.equal(submissionFeedbackNotification(before, after), null)
    assert.equal(submissionRequestedInfoNotification(before, after), null)
    assert.equal(candidateConfirmationNotification(before, after), null)
    assert.equal(payoutUpdateNotification(before, after), null)
  })

  it("requires recruiter Bearer auth on the update endpoint", async () => {
    const out: { statusCode?: number; body?: unknown } = {}
    const res = {
      set: () => {},
      setHeader: () => {},
      getHeader: () => undefined,
      end: () => {},
      on: () => {},
      status: (code: number) => {
        out.statusCode = code
        return {
          json: (body: unknown) => { out.body = body },
          send: (body: unknown) => { out.body = body },
        }
      },
    }
    const req = {
      method: "POST",
      headers: {},
      body: { submissionId: "sub-1", candidate: { notes: "x" } },
      get: () => undefined,
    }
    await recruiterBoardEntrypoint.paRecruiterSubmissionUpdate(req as never, res as never)
    assert.equal(out.statusCode, 401)
    assert.deepEqual(out.body, { ok: false, reason: "unauthorized" })
  })
})

describe("recruiter submission comments", () => {
  it("validates comment payloads", () => {
    assert.deepEqual(validateRecruiterSubmissionCommentAddInput({ message: "hi" }), {
      ok: false,
      reason: "missing_submission_id",
    })
    assert.deepEqual(validateRecruiterSubmissionCommentAddInput({ submissionId: "../bad", message: "hi" }), {
      ok: false,
      reason: "invalid_submission_id",
    })
    assert.deepEqual(validateRecruiterSubmissionCommentAddInput({ submissionId: "sub-1", message: "   " }), {
      ok: false,
      reason: "missing_message",
    })
    assert.deepEqual(validateRecruiterSubmissionCommentAddInput({
      submissionId: "sub-1",
      message: "x".repeat(4001),
    }), {
      ok: false,
      reason: "message_too_long",
    })
    assert.deepEqual(validateRecruiterSubmissionCommentAddInput({ submissionId: "sub-1", message: " Need an update " }), {
      ok: true,
      value: { submissionId: "sub-1", message: "Need an update" },
    })
  })

  it("lets only the owning recruiter add a comment, stamped with the profile identity", async () => {
    const fake = nestedMemoryFirestore(sheetSubmissionSeed())
    const denied = await addRecruiterSubmissionComment(fake.db as never, otherSheetRecruiter, {
      submissionId: "sub-1",
      message: "not mine",
    })
    assert.deepEqual(denied, { ok: false, status: 403, reason: "forbidden" })

    const missing = await addRecruiterSubmissionComment(fake.db as never, sheetRecruiter, {
      submissionId: "sub-404",
      message: "hello",
    })
    assert.deepEqual(missing, { ok: false, status: 404, reason: "submission_not_found" })

    const added = await addRecruiterSubmissionComment(
      fake.db as never,
      sheetRecruiter,
      { submissionId: "sub-1", message: "Any feedback on Ada?" },
      "2026-06-09T10:00:00.000Z",
    )
    assert.equal(added.ok, true)
    if (!added.ok) return
    assert.equal(added.comment.by, "recruiter")
    assert.equal(added.comment.authorName, "Sloane")
    assert.equal(added.comment.authorEmail, "sloane@agency.com")
    assert.equal(added.comment.at, "2026-06-09T10:00:00.000Z")
    const storedKey = fake.findKey(`pa-recruiter-submissions/sub-1/comments/${added.comment.id}`)
    assert.ok(storedKey, "comment lands in the submission subcollection")
    const stored = fake.docs.get(storedKey!) as Record<string, unknown>
    assert.equal(stored.message, "Any feedback on Ada?")
    assert.equal(stored.by, "recruiter")
  })

  it("lists comments oldest-first for the owning recruiter only", async () => {
    const fake = nestedMemoryFirestore({
      ...sheetSubmissionSeed(),
      "pa-recruiter-submissions/sub-1/comments/c-late": {
        message: "Second",
        by: "wekruit",
        authorName: "WeKruit",
        at: "2026-06-09T12:00:00.000Z",
      },
      "pa-recruiter-submissions/sub-1/comments/c-early": {
        message: "First",
        by: "recruiter",
        authorName: "Sloane",
        authorEmail: "sloane@agency.com",
        at: "2026-06-09T10:00:00.000Z",
      },
      "pa-recruiter-submissions/sub-1/comments/c-junk": {
        by: "recruiter",
        at: "2026-06-09T11:00:00.000Z",
      },
    })

    const denied = await listRecruiterSubmissionComments(fake.db as never, otherSheetRecruiter, "sub-1")
    assert.deepEqual(denied, { ok: false, status: 403, reason: "forbidden" })

    const listed = await listRecruiterSubmissionComments(fake.db as never, sheetRecruiter, "sub-1")
    assert.equal(listed.ok, true)
    if (!listed.ok) return
    assert.deepEqual(listed.comments.map((comment) => comment.message), ["First", "Second"])
    assert.deepEqual(listed.comments[0], {
      id: "c-early",
      message: "First",
      by: "recruiter",
      authorName: "Sloane",
      authorEmail: "sloane@agency.com",
      at: "2026-06-09T10:00:00.000Z",
    })
    assert.equal(listed.comments[1]?.by, "wekruit")
  })

  it("requires recruiter Bearer auth on both comment endpoints", async () => {
    for (const [handler, req] of [
      [recruiterBoardEntrypoint.paRecruiterSubmissionCommentsList, {
        method: "GET",
        headers: {},
        query: { submissionId: "sub-1" },
        get: () => undefined,
      }],
      [recruiterBoardEntrypoint.paRecruiterSubmissionCommentAdd, {
        method: "POST",
        headers: {},
        body: { submissionId: "sub-1", message: "hello" },
        get: () => undefined,
      }],
    ] as const) {
      const out: { statusCode?: number; body?: unknown } = {}
      const res = {
        set: () => {},
        setHeader: () => {},
        getHeader: () => undefined,
        end: () => {},
        on: () => {},
        status: (code: number) => {
          out.statusCode = code
          return {
            json: (body: unknown) => { out.body = body },
            send: (body: unknown) => { out.body = body },
          }
        },
      }
      await (handler as (rq: never, rs: never) => Promise<void>)(req as never, res as never)
      assert.equal(out.statusCode, 401)
      assert.deepEqual(out.body, { ok: false, reason: "unauthorized" })
    }
  })
})

describe("recruiter submission comment notifications", () => {
  const wekruitComment = {
    message: "We will move Ada forward this week.",
    by: "wekruit",
    authorName: "WeKruit Ops",
    at: "2026-06-09T12:00:00.000Z",
  }
  const recruiterComment = {
    message: "Any update on Ada?",
    by: "recruiter",
    authorName: "Sloane",
    authorEmail: "sloane@agency.com",
    at: "2026-06-09T11:00:00.000Z",
  }

  function withoutMailgunEnv<T>(run: () => Promise<T>): Promise<T> {
    const saved = { apiKey: process.env.MAILGUN_API_KEY, domain: process.env.MAILGUN_DOMAIN }
    delete process.env.MAILGUN_API_KEY
    delete process.env.MAILGUN_DOMAIN
    return run().finally(() => {
      if (saved.apiKey !== undefined) process.env.MAILGUN_API_KEY = saved.apiKey
      if (saved.domain !== undefined) process.env.MAILGUN_DOMAIN = saved.domain
    })
  }

  it("titles WeKruit replies for email and keeps recruiter comments in-app only", () => {
    const submission = sheetSubmissionSeed()["pa-recruiter-submissions/sub-1"]!
    const wekruit = submissionCommentNotification(wekruitComment, submission)
    assert.equal(wekruit?.title, "WeKruit replied on Ada Lovelace")
    assert.match(wekruit?.body ?? "", /Founding Engineer/)
    assert.match(wekruit?.body ?? "", /move Ada forward/)
    assert.equal(wekruit?.emailable, true)
    const recruiter = submissionCommentNotification(recruiterComment, submission)
    assert.equal(recruiter?.title, "New comment on Ada Lovelace")
    assert.equal(recruiter?.emailable, false)
    assert.equal(submissionCommentNotification({ by: "wekruit", message: "  " }, submission), null)
    assert.equal(submissionCommentNotification({ by: "candidate", message: "hi" }, submission), null)
    const email = composeRecruiterSubmissionUpdateEmail({
      title: wekruit!.title,
      body: wekruit!.body,
      roleTitle: "Founding Engineer",
      companyLabel: "Co. B",
    })
    assert.equal(email.subject, "WeKruit replied on Ada Lovelace")
  })

  it("creates a notification and attempts the email for a WeKruit reply", async () => {
    await withoutMailgunEnv(async () => {
      const fake = nestedMemoryFirestore(sheetSubmissionSeed())
      const result = await deliverRecruiterSubmissionCommentNotification(fake.db as never, {
        triggerEventId: "evt-comment-1",
        submissionId: "sub-1",
        comment: wekruitComment,
      })
      assert.equal(result.notified, true)
      assert.equal(result.emailStatus, "not_configured")
      const notificationKey = fake.findKey("pa-recruiter-notifications/")
      assert.ok(notificationKey, "notification doc created")
      const notification = fake.docs.get(notificationKey!) as Record<string, unknown>
      assert.equal(notification.type, "submission_comment")
      assert.equal(notification.recruiterId, "rec-1")
      assert.equal(notification.entityType, "submission")
      assert.equal(notification.entityId, "sub-1")
      assert.equal(notification.title, "WeKruit replied on Ada Lovelace")
      assert.equal(notification.emailStatus, "not_configured")
    })
  })

  it("skips the email but keeps the notification when the recruiter opted out", async () => {
    await withoutMailgunEnv(async () => {
      const fake = nestedMemoryFirestore({
        ...sheetSubmissionSeed(),
        "pa-recruiter-users/rec-1": {
          recruiterId: "rec-1",
          email: "sloane@agency.com",
          notificationPreferences: { submissionUpdatesEmail: false },
        },
      })
      const result = await deliverRecruiterSubmissionCommentNotification(fake.db as never, {
        triggerEventId: "evt-comment-2",
        submissionId: "sub-1",
        comment: wekruitComment,
      })
      assert.equal(result.notified, true)
      assert.equal(result.emailStatus, "skipped")
      const notificationKey = fake.findKey("pa-recruiter-notifications/")
      const notification = fake.docs.get(notificationKey!) as Record<string, unknown>
      assert.equal(notification.emailStatus, "skipped")
      assert.equal(notification.emailLastError, "submission_updates_email_disabled")
    })
  })

  it("writes the notification doc only — never an email — for recruiter comments", async () => {
    await withoutMailgunEnv(async () => {
      const fake = nestedMemoryFirestore(sheetSubmissionSeed())
      const result = await deliverRecruiterSubmissionCommentNotification(fake.db as never, {
        triggerEventId: "evt-comment-3",
        submissionId: "sub-1",
        comment: recruiterComment,
      })
      assert.equal(result.notified, true)
      assert.equal(result.emailStatus, "not_emailed")
      const notificationKey = fake.findKey("pa-recruiter-notifications/")
      assert.ok(notificationKey, "notification doc created")
      const notification = fake.docs.get(notificationKey!) as Record<string, unknown>
      assert.equal(notification.type, "submission_comment")
      assert.equal(notification.title, "New comment on Ada Lovelace")
      assert.equal("emailStatus" in notification, false)
    })
  })

  it("does not double-notify or double-email on an idempotent trigger replay", async () => {
    await withoutMailgunEnv(async () => {
      const fake = nestedMemoryFirestore(sheetSubmissionSeed())
      const first = await deliverRecruiterSubmissionCommentNotification(fake.db as never, {
        triggerEventId: "evt-comment-4",
        submissionId: "sub-1",
        comment: wekruitComment,
      })
      assert.equal(first.notified, true)
      const replay = await deliverRecruiterSubmissionCommentNotification(fake.db as never, {
        triggerEventId: "evt-comment-4",
        submissionId: "sub-1",
        comment: wekruitComment,
      })
      assert.equal(replay.notified, false)
      assert.equal(replay.emailStatus, "not_emailed")
    })
  })

  it("exports the sheet endpoints and the comment trigger from the deployed entrypoint", () => {
    for (const name of [
      "paRecruiterSubmissionUpdate",
      "paRecruiterSubmissionCommentsList",
      "paRecruiterSubmissionCommentAdd",
      "paRecruiterSubmissionCommentNotify",
    ]) {
      assert.equal(name in recruiterBoardEntrypoint, true, `${name} must be exported`)
    }
  })
})
