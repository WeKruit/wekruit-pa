import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { onAuthStateChanged, signOut, type User } from "firebase/auth"
import { httpsCallable } from "firebase/functions"
import { auth, functions } from "../lib/firebase.js"
import { CandidateShell } from "./CandidateLogin.js"

const GLOBAL_UID_KEY = "wkr_uid"

interface CandidateSelfProfile {
  candidateId: string
  lifecycleState: string
  displayName?: string
  emailMasked?: string
  phoneMasked?: string
  latestResumeArtifactId?: string
  profileSummary?: string
  linkedinUrl?: string
  handles?: Array<{ kind: string; verifiedAt?: string | null; source?: string }>
  globalTags?: {
    roleFunction?: string[]
    skills?: string[]
    industrySector?: string[]
    targetLocations?: string[]
    targetJobType?: string[]
    relevantTags?: string[]
  }
}

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
          if (!cancelled) {
            setState({ status: "error", message: err instanceof Error ? err.message : String(err) })
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

export function CandidateMe() {
  const state = useClaimedProfile()
  return (
    <CandidateShell>
      <main className="candidate-panel">
        <p className="candidate-kicker">Candidate profile</p>
        {state.status === "loading" ? <h1>Loading</h1> : null}
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
        {state.status === "loading" ? <h1>Loading</h1> : null}
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
  const tags = profile.globalTags
  return (
    <>
      <h1>{profile.displayName ?? "Your profile"}</h1>
      <dl className="candidate-profile-list">
        <ProfileRow label="Candidate ID" value={profile.candidateId} />
        <ProfileRow label="Lifecycle" value={profile.lifecycleState} />
        <ProfileRow label="Email" value={profile.emailMasked ?? "Not set"} />
        <ProfileRow label="Phone" value={profile.phoneMasked ?? "Not set"} />
        <ProfileRow label="Resume" value={profile.latestResumeArtifactId ?? "Not set"} />
        <ProfileRow label="LinkedIn" value={profile.linkedinUrl ?? "Not set"} />
      </dl>
      {profile.profileSummary ? <p className="candidate-summary">{profile.profileSummary}</p> : null}
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
    </>
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
