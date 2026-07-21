/**
 * Shared recruiter reason taxonomy + chip UI (Adam 2026-06-23).
 *
 * Single source of truth for the quick reject/accept reasons rendered in BOTH the
 * Submission view (RecruiterSubmissions) and the Recruiter Board (RecruiterBoardOps),
 * so the two surfaces share one candidate-review UI instead of diverging (the Board
 * previously had only a Background subset). One-tap chips, grouped, so a reviewer
 * picks a reason instead of typing.
 *
 * "over_leveled" carries the "too senior" signal — age is never a reason (legal).
 */
import type { ReactElement } from "react"

export interface SubmissionFeedbackReason {
  id: string
  label: string
  group: string
}

export const SUBMISSION_FEEDBACK_REASONS: readonly SubmissionFeedbackReason[] = [
  // Positive
  { id: "strong_match", label: "Strong match", group: "Positive" },
  { id: "clear_evidence", label: "Clear evidence", group: "Positive" },
  { id: "good_candidate_motivation", label: "Candidate motivated", group: "Positive" },
  // Background pillars (school · GPA · degree · company)
  { id: "weak_school", label: "Weak / non-target school", group: "Background" },
  { id: "low_gpa", label: "Low GPA", group: "Background" },
  { id: "degree_mismatch", label: "Degree / field mismatch", group: "Background" },
  { id: "weak_company_pedigree", label: "Weak company pedigree", group: "Background" },
  { id: "no_relevant_domain", label: "No relevant domain", group: "Background" },
  // Engineering depth
  { id: "no_end_to_end", label: "No end-to-end ownership", group: "Depth" },
  { id: "weak_technical_depth", label: "Lacks technical depth", group: "Depth" },
  { id: "not_hands_on", label: "Not a hands-on builder", group: "Depth" },
  { id: "no_impact_evidence", label: "No quantifiable impact", group: "Depth" },
  // Role-specific
  { id: "no_strong_portfolio", label: "No strong portfolio (design)", group: "Role-specific" },
  { id: "weak_product_design", label: "Weak product/UX depth (design)", group: "Role-specific" },
  { id: "weak_social_presence", label: "Weak social/channel record (GTM)", group: "Role-specific" },
  { id: "no_growth_track_record", label: "No growth results (GTM)", group: "Role-specific" },
  // Level & fit
  { id: "below_experience_bar", label: "Below experience bar", group: "Level & fit" },
  { id: "over_leveled", label: "Over-leveled / overqualified", group: "Level & fit" },
  { id: "seniority_mismatch", label: "Seniority mismatch", group: "Level & fit" },
  { id: "comp_mismatch", label: "Comp mismatch", group: "Level & fit" },
  { id: "location_mismatch", label: "Location mismatch", group: "Level & fit" },
  // Process / signal
  { id: "missing_hard_filter", label: "Missing hard filter", group: "Process" },
  { id: "weak_evidence", label: "Weak evidence in submission", group: "Process" },
  { id: "candidate_not_interested", label: "Candidate not interested", group: "Process" },
  { id: "duplicate", label: "Duplicate", group: "Process" },
]

export const SUBMISSION_FEEDBACK_REASON_GROUPS = [
  "Positive", "Background", "Depth", "Role-specific", "Level & fit", "Process",
] as const

export function feedbackReasonLabel(reason: string): string {
  return SUBMISSION_FEEDBACK_REASONS.find((r) => r.id === reason)?.label ?? reason
}

/**
 * Grouped, one-tap reason chips. `selected` accepts an array OR a Set so both the
 * Submission view (draft array) and the Board (Set) reuse it as-is. Positive group =
 * green, everything else = reject-red.
 */
export function ReasonChips({
  selected,
  onToggle,
}: {
  selected: readonly string[] | ReadonlySet<string>
  onToggle: (id: string) => void
}): ReactElement {
  const has = (id: string): boolean =>
    Array.isArray(selected) ? selected.includes(id) : (selected as ReadonlySet<string>).has(id)
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {SUBMISSION_FEEDBACK_REASON_GROUPS.map((groupName) => {
        const groupReasons = SUBMISSION_FEEDBACK_REASONS.filter((r) => r.group === groupName)
        if (!groupReasons.length) return null
        return (
          <div key={groupName}>
            <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.04em", color: "#999", marginBottom: 4 }}>
              {groupName}
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {groupReasons.map((reason) => {
                const active = has(reason.id)
                const positive = reason.group === "Positive"
                const activeBg = positive ? "#0f6e56" : "#993c1d"
                return (
                  <button
                    type="button"
                    key={reason.id}
                    onClick={() => onToggle(reason.id)}
                    aria-pressed={active}
                    style={{
                      padding: "5px 8px",
                      border: active ? `1px solid ${activeBg}` : "1px solid #ddd",
                      background: active ? activeBg : "#fff",
                      color: active ? "#fff" : "#555",
                      borderRadius: 999,
                      fontSize: 12,
                      cursor: "pointer",
                    }}
                  >
                    {reason.label}
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
