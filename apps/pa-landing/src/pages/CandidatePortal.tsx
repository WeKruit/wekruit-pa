import { useEffect, useState, type FormEvent } from "react"
import { Link } from "react-router-dom"
import { onAuthStateChanged, signOut, type User } from "firebase/auth"
import { httpsCallable } from "firebase/functions"
import { auth, functions } from "../lib/firebase.js"
import {
  createCandidateProfileCorrectionSubmitter,
  type CandidateSelfProfile,
} from "../lib/candidate-profile-correction.js"
import {
  createCandidatePrivacyRequestSubmitter,
  type CandidatePrivacyRequestKind,
} from "../lib/candidate-privacy-request.js"
import { CandidateShell } from "./CandidateLogin.js"

const GLOBAL_UID_KEY = "wkr_uid"

interface CandidateClaimResult {
  ok: true
  candidateId: string
  selfProfile: CandidateSelfProfile
  idempotent: boolean
}

type ClaimState =
  | { status: "loading" }
  | { status: "signed_out" }
  | { status: "ready"; user: User; profile: CandidateSelfProfile }
  | { status: "error"; message: string }

export function useClaimedProfile(): ClaimState {
  const [state, setState] = useState<ClaimState>({ status: "loading" })

  useEffect(() => {
    let cancelled = false
    const unsubscribe = onAuthStateChanged(auth(), (user) => {
      if (!user) {
        setState({ status: "signed_out" })
        return
      }
      setState({ status: "loading" })
      void (async () => {
        try {
          const claimProfile = httpsCallable<{ browserUid?: string | null }, CandidateClaimResult>(
            functions(),
            "paCandidateClaimProfile"
          )
          const browserUid = window.localStorage.getItem(GLOBAL_UID_KEY)
          const result = await claimProfile({ browserUid })
          if (!cancelled) {
            setState({ status: "ready", user, profile: result.data.selfProfile })
          }
        } catch (err) {
          console.error("candidate profile claim failed", err)
          if (!cancelled) {
            setState({ status: "error", message: profileLoadErrorMessage(err) })
          }
        }
      })()
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  return state
}

function profileLoadErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (/unauthenticated|sign in/i.test(raw)) {
    return "Your session expired. Sign in again to load your WeKruit profile."
  }
  if (/failed-precondition|operator review|conflict/i.test(raw)) {
    return "We need to review this profile before showing it here."
  }
  return "We could not load your profile just now. Refresh the page, or sign in again if this keeps happening."
}

export function CandidateMe() {
  const state = useClaimedProfile()
  return (
    <CandidateShell>
      <main className="candidate-panel">
        <p className="candidate-kicker">Candidate profile</p>
        {state.status === "loading" ? (
          <>
            <h1>Loading your profile</h1>
            <p>Checking your signed-in WeKruit profile.</p>
          </>
        ) : null}
        {state.status === "signed_out" ? (
          <>
            <h1>Sign in required</h1>
            <Link className="candidate-primary-link" to="/login">Sign in</Link>
          </>
        ) : null}
        {state.status === "error" ? (
          <>
            <h1>Profile unavailable</h1>
            <p className="candidate-error">{state.message}</p>
            <Link className="candidate-primary-link" to="/login">Sign in again</Link>
          </>
        ) : null}
        {state.status === "ready" ? (
          <>
            <h1>{state.profile.displayName ?? "Your profile"}</h1>
            <dl className="candidate-profile-list">
              <div>
                <dt>Email</dt>
                <dd>{state.profile.emailMasked ?? state.user.email ?? "Not set"}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{state.profile.lifecycleState}</dd>
              </div>
              <div>
                <dt>Phone</dt>
                <dd>{state.profile.phoneMasked ?? "Not set"}</dd>
              </div>
            </dl>
            <div className="candidate-actions">
              <Link className="candidate-primary-link" to="/me/matches">View matches</Link>
              <Link className="candidate-primary-link" to="/me/profile">View profile</Link>
              <button className="candidate-secondary-button" type="button" onClick={() => void signOut(auth())}>
                Sign out
              </button>
            </div>
          </>
        ) : null}
      </main>
    </CandidateShell>
  )
}

export function CandidateProfile() {
  const state = useClaimedProfile()
  return (
    <CandidateShell>
      <main className="candidate-panel candidate-profile-panel">
        <p className="candidate-kicker">Profile details</p>
        {state.status === "loading" ? (
          <>
            <h1>Loading your profile</h1>
            <p>Checking your resume, labels, and saved preferences.</p>
          </>
        ) : null}
        {state.status === "signed_out" ? (
          <>
            <h1>Sign in required</h1>
            <Link className="candidate-primary-link" to="/login">Sign in</Link>
          </>
        ) : null}
        {state.status === "error" ? (
          <>
            <h1>Profile unavailable</h1>
            <p className="candidate-error">{state.message}</p>
          </>
        ) : null}
        {state.status === "ready" ? <ProfileDetails profile={state.profile} /> : null}
      </main>
    </CandidateShell>
  )
}

function ProfileDetails({ profile }: { profile: CandidateSelfProfile }) {
  const [currentProfile, setCurrentProfile] = useState(profile)
  const tags = currentProfile.globalTags

  useEffect(() => {
    setCurrentProfile(profile)
  }, [profile])

  return (
    <>
      <style>{CANDIDATE_PROFILE_STYLES}</style>
      <h1>{currentProfile.displayName ?? "Your profile"}</h1>
      <dl className="candidate-profile-list">
        <ProfileRow label="Candidate ID" value={currentProfile.candidateId} />
        <ProfileRow label="Lifecycle" value={currentProfile.lifecycleState} />
        <ProfileRow label="Email" value={currentProfile.emailMasked ?? "Not set"} />
        <ProfileRow label="Phone" value={currentProfile.phoneMasked ?? "Not set"} />
        <ProfileRow label="Resume" value={currentProfile.latestResumeArtifactId ?? "Not set"} />
        <ProfileRow label="LinkedIn" value={currentProfile.linkedinUrl ?? "Not set"} />
      </dl>
      {currentProfile.profileSummary ? <p className="candidate-summary">{currentProfile.profileSummary}</p> : null}
      {tags ? (
        <div className="candidate-tag-groups">
          <TagGroup label="Roles" values={tags.roleFunction} />
          <TagGroup label="Skills" values={tags.skills} />
          <TagGroup label="Industries" values={tags.industrySector} />
          <TagGroup label="Locations" values={tags.targetLocations} />
          <TagGroup label="Job types" values={tags.targetJobType} />
          <TagGroup label="Tags" values={tags.relevantTags} />
        </div>
      ) : null}
      <ProfileCorrectionPanel onProfileUpdated={setCurrentProfile} />
      <PrivacyRequestPanel />
    </>
  )
}

function ProfileCorrectionPanel({
  onProfileUpdated,
}: {
  onProfileUpdated: (profile: CandidateSelfProfile) => void
}) {
  const [correctionText, setCorrectionText] = useState("")
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle")
  const [message, setMessage] = useState<string | null>(null)

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setMessage(null)
    setStatus("submitting")
    try {
      const submitCorrection = createCandidateProfileCorrectionSubmitter(functions())
      const result = await submitCorrection({ correctionText })
      onProfileUpdated(result.selfProfile)
      setCorrectionText("")
      const applied = result.appliedKeys?.length ? ` Updated: ${result.appliedKeys.join(", ")}.` : ""
      setMessage(`Correction submitted.${applied}`)
      setStatus("success")
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
      setStatus("error")
    }
  }

  return (
    <section className="candidate-correction-panel" aria-labelledby="candidate-correction-title">
      <h2 id="candidate-correction-title">Update profile preferences</h2>
      <form onSubmit={onSubmit} className="candidate-correction-form">
        <label>
          Correction
          <textarea
            value={correctionText}
            onChange={(event) => setCorrectionText(event.target.value)}
            disabled={status === "submitting"}
            rows={4}
            placeholder="Example: I prefer product roles in New York or remote, and I want to avoid early-stage startups."
          />
        </label>
        <button type="submit" disabled={status === "submitting" || correctionText.trim().length === 0}>
          {status === "submitting" ? "Submitting" : "Submit correction"}
        </button>
      </form>
      {status === "success" && message ? <p className="candidate-success">{message}</p> : null}
      {status === "error" && message ? <p className="candidate-error">{message}</p> : null}
    </section>
  )
}

const PRIVACY_REQUEST_OPTIONS: Array<{ kind: CandidatePrivacyRequestKind; label: string }> = [
  { kind: "export", label: "Export my data" },
  { kind: "delete", label: "Delete my profile" },
  { kind: "stop_outreach", label: "Stop outreach" },
  { kind: "privacy_question", label: "Privacy question" },
]

function PrivacyRequestPanel() {
  const [kind, setKind] = useState<CandidatePrivacyRequestKind>("export")
  const [detailText, setDetailText] = useState("")
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle")
  const [message, setMessage] = useState<string | null>(null)

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setMessage(null)
    setStatus("submitting")
    try {
      const submitPrivacyRequest = createCandidatePrivacyRequestSubmitter(functions())
      const result = await submitPrivacyRequest({ kind, detailText })
      setDetailText("")
      setMessage(result.existingOpen ? "Open request already exists." : "Request submitted for review.")
      setStatus("success")
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
      setStatus("error")
    }
  }

  return (
    <section className="candidate-correction-panel" aria-labelledby="candidate-privacy-title">
      <h2 id="candidate-privacy-title">Privacy requests</h2>
      <form onSubmit={onSubmit} className="candidate-correction-form">
        <label>
          Request
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value as CandidatePrivacyRequestKind)}
            disabled={status === "submitting"}
          >
            {PRIVACY_REQUEST_OPTIONS.map((option) => (
              <option key={option.kind} value={option.kind}>{option.label}</option>
            ))}
          </select>
        </label>
        <label>
          Details
          <textarea
            value={detailText}
            onChange={(event) => setDetailText(event.target.value)}
            disabled={status === "submitting"}
            rows={3}
            placeholder="Add context for the operator review."
          />
        </label>
        <button type="submit" disabled={status === "submitting"}>
          {status === "submitting" ? "Submitting" : "Submit request"}
        </button>
      </form>
      {status === "success" && message ? <p className="candidate-success">{message}</p> : null}
      {status === "error" && message ? <p className="candidate-error">{message}</p> : null}
    </section>
  )
}

function ProfileRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

function TagGroup({ label, values }: { label: string; values?: string[] }) {
  if (!values || values.length === 0) return null
  return (
    <section className="candidate-tag-group">
      <h2>{label}</h2>
      <div>
        {values.slice(0, 24).map((value) => (
          <span key={value}>{value}</span>
        ))}
      </div>
    </section>
  )
}

const CANDIDATE_PROFILE_STYLES = `
.candidate-correction-panel {
  display: grid;
  gap: 12px;
  margin-top: 22px;
  padding-top: 18px;
  border-top: 1px solid #e5dccd;
}
.candidate-correction-panel h2 {
  margin: 0;
  font-size: 18px;
  line-height: 1.25;
  letter-spacing: 0;
}
.candidate-correction-form {
  display: grid;
  gap: 12px;
}
.candidate-correction-form label {
  display: grid;
  gap: 6px;
  color: #364233;
  font-weight: 800;
}
.candidate-correction-form textarea {
  width: 100%;
  min-height: 110px;
  resize: vertical;
  border: 1px solid #cfc3ae;
  border-radius: 8px;
  padding: 12px;
  font: inherit;
  line-height: 1.45;
  background: #fff;
  color: #18211a;
}
.candidate-correction-form select {
  width: min(100%, 320px);
  min-height: 42px;
  border: 1px solid #cfc3ae;
  border-radius: 8px;
  padding: 0 12px;
  font: inherit;
  background: #fff;
  color: #18211a;
}
.candidate-correction-form textarea:disabled {
  opacity: 0.7;
}
.candidate-correction-form select:disabled {
  opacity: 0.7;
}
.candidate-correction-form button {
  justify-self: start;
  min-height: 42px;
  padding: 0 16px;
  border-radius: 8px;
  border: 1px solid #2f6f4f;
  background: #2f6f4f;
  color: #fffdf8;
  font: inherit;
  font-weight: 800;
  cursor: pointer;
}
.candidate-correction-form button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
`
