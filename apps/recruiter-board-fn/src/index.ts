/**
 * Recruiter-board Cloud Functions codebase entrypoint.
 *
 * Multi-codebase deploy: this file is loaded by firebase-tools as the
 * `recruiter-board` codebase (see firebase.json). It MUST stay minimal —
 * the whole point of separating from pa-orchestrator is to avoid the
 * 19.9MB monolith bundle. Do not add unrelated CFs here.
 */
import { initializeApp, getApps } from "firebase-admin/app"

if (getApps().length === 0) {
  initializeApp()
}

export {
  paCollabJobsList,
  paCollabJobsListSchema,
  paRecruiterAccess,
  paRecruiterCandidateCalibrationNotify,
  paRecruiterCandidateConsentResend,
  paRecruiterInviteCodeCreate,
  paRecruiterInviteCodeReplace,
  paRecruiterInviteCodeRestore,
  paRecruiterMe,
  paRecruiterNotificationsList,
  paRecruiterNotificationsRead,
  paRecruiterCandidateConsentConfirm,
  paRecruiterPreferencesUpdate,
  paRecruiterRoleApplicationDecisionNotify,
  paRecruiterRoleApplicationSave,
  paRecruiterRoleApplicationsList,
  paRecruiterRoleReleasedNotify,
  paRecruiterRoleFeedbackSignalWrite,
  paRecruiterRoleFeedbackList,
  paRecruiterRoleFeedbackSave,
  paRecruiterRoleIntelligenceList,
  paRecruiterRoleQuestionAnswerNotify,
  paRecruiterRoleQuestionCreate,
  paRecruiterRoleQuestionsList,
  paRecruiterCandidateIdentityCheck,
  paRecruiterSourcedCandidateSave,
  paRecruiterSourcedCandidatesList,
  paRecruiterSubmission,
  paRecruiterSubmissionFeedbackNotify,
  paRecruiterSubmissionsList,
} from "./recruiter-board.js"
