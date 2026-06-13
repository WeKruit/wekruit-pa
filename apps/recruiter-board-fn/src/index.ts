/**
 * Recruiter-board Cloud Functions codebase entrypoint.
 *
 * Multi-codebase deploy: this file is loaded by firebase-tools as the
 * `recruiter-board` codebase (see firebase.json). It MUST stay minimal —
 * the whole point of separating from pa-orchestrator is to avoid the
 * 19.9MB monolith bundle. Do not add unrelated CFs here.
 */
import { initializeApp, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

if (getApps().length === 0) {
  initializeApp()
  getFirestore().settings({ ignoreUndefinedProperties: true })
}

export {
  paCollabJobsList,
  paCollabJobsListSchema,
  paRecruiterAccess,
  paRecruiterCandidateCalibrationNotify,
  paRecruiterInviteCodeCreate,
  paRecruiterInviteCodeResend,
  paRecruiterInviteCodeReplace,
  paRecruiterInviteCodeRestore,
  paRecruiterMe,
  paRecruiterNotificationsList,
  paRecruiterNotificationsRead,
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
  paRecruiterSubmissionCommentAdd,
  paRecruiterSubmissionCommentNotify,
  paRecruiterSubmissionCommentsList,
  paRecruiterSubmissionFeedbackNotify,
  paRecruiterSubmissionGet,
  paRecruiterSubmissionUpdate,
  paRecruiterSubmissionsList,
} from "./recruiter-board.js"
