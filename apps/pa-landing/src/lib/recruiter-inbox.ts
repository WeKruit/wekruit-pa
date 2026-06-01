export type RecruiterInboxAction = "roles" | "submissions" | "matches" | "candidates"

export type RecruiterInboxTone = "live" | "info" | "success" | "warn" | "mute"

export interface RecruiterNotificationInboxMeta {
  typeLabel: string
  unreadBucket: string
  action: RecruiterInboxAction
  cta: string
  readTone: RecruiterInboxTone
}

export function recruiterNotificationInboxMeta(type: string): RecruiterNotificationInboxMeta {
  switch (type) {
    case "candidate_calibration":
      return {
        typeLabel: "Candidate calibration",
        unreadBucket: "Unread candidate calibration",
        action: "candidates",
        cta: "Open candidate",
        readTone: "info",
      }
    case "new_role":
      return {
        typeLabel: "New role alert",
        unreadBucket: "Unread role alert",
        action: "roles",
        cta: "Open role",
        readTone: "mute",
      }
    case "role_application_decision":
      return {
        typeLabel: "Access decision",
        unreadBucket: "Unread access decision",
        action: "roles",
        cta: "Review access",
        readTone: "info",
      }
    case "role_question_answer":
      return {
        typeLabel: "Role answer returned",
        unreadBucket: "Unread role answer",
        action: "roles",
        cta: "Open answer",
        readTone: "info",
      }
    case "submission_feedback":
      return {
        typeLabel: "Submission notification",
        unreadBucket: "Unread submission feedback",
        action: "submissions",
        cta: "Review submission",
        readTone: "info",
      }
    default:
      return {
        typeLabel: "Platform alert",
        unreadBucket: "Unread platform alert",
        action: "candidates",
        cta: "Open workspace",
        readTone: "mute",
      }
  }
}
