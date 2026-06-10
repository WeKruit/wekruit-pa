/**
 * "Email me status updates" switch — pa-recruiter-users
 * notificationPreferences.submissionUpdatesEmail (absent ⇒ true).
 * Reads from the paRecruiterMe profile, writes via paRecruiterPreferencesUpdate.
 * Rendered on the board header (near the profile area) and the My submissions
 * view so the recruiter can subscribe from either surface.
 */
import { useState } from "react"
import { updateRecruiterPreferences, type RecruiterSession } from "../lib/recruiter-board-api.js"

export function submissionUpdatesEmailEnabled(session: RecruiterSession | null): boolean {
  return session?.recruiter.notificationPreferences?.submissionUpdatesEmail !== false
}

export function SubmissionUpdatesToggle({
  session,
  onSessionChange,
  compact = false,
}: {
  session: RecruiterSession
  onSessionChange: (session: RecruiterSession) => void
  compact?: boolean
}) {
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const enabled = submissionUpdatesEmailEnabled(session)
  const setEnabled = async (next: boolean) => {
    setSaving(true)
    setErr(null)
    try {
      const updated = await updateRecruiterPreferences({
        notificationPreferences: {
          ...session.recruiter.notificationPreferences,
          submissionUpdatesEmail: next,
        },
      })
      onSessionChange(updated)
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }
  return (
    <label className={`rb-email-updates-toggle${compact ? " is-compact" : ""}`}>
      <input
        type="checkbox"
        role="switch"
        checked={enabled}
        disabled={saving}
        onChange={(e) => void setEnabled(e.target.checked)}
      />
      <span>Email me status updates</span>
      {err && <em>{err}</em>}
    </label>
  )
}
