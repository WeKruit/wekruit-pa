import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { httpsCallable } from "firebase/functions"
import { functions } from "../lib/firebase.js"
import { CandidateShell } from "./CandidateLogin.js"
import { useClaimedProfile } from "./CandidatePortal.js"

type CandidateMatchCard = {
  matchId: string
  jobId: string
  bucket: "recommended" | "invited"
  status: "recommended" | "invited" | "interview_started" | "passed" | "not_passed" | "paused"
  job: {
    title: string
    company: string
    location?: string
    salaryRange?: string
    href: string
  }
  whyMatched: string[]
  rank?: number
  computedAt: string
}

type CandidateMatchesResult = {
  ok: true
  candidateId: string
  generatedAt: string
  matches: CandidateMatchCard[]
}

type MatchesState =
  | { status: "idle" | "loading" }
  | { status: "ready"; matches: CandidateMatchCard[] }
  | { status: "error"; message: string }

function useCandidateMatches(enabled: boolean): MatchesState {
  const [state, setState] = useState<MatchesState>({ status: "idle" })

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    setState({ status: "loading" })
    void (async () => {
      try {
        const listMatches = httpsCallable<{ limit: number }, CandidateMatchesResult>(
          functions(),
          "paCandidateListMatches"
        )
        const result = await listMatches({ limit: 25 })
        if (!cancelled) setState({ status: "ready", matches: result.data.matches })
      } catch (err) {
        if (!cancelled) setState({ status: "error", message: err instanceof Error ? err.message : String(err) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [enabled])

  return state
}

export default function CandidateMatches() {
  const profileState = useClaimedProfile()
  const matchesState = useCandidateMatches(profileState.status === "ready")
  return (
    <CandidateShell>
      <style>{CANDIDATE_MATCHES_STYLES}</style>
      <main className="candidate-panel candidate-matches-panel">
        <p className="candidate-kicker">Job matches</p>
        {profileState.status === "loading" || matchesState.status === "loading" || matchesState.status === "idle" ? (
          <h1>Loading</h1>
        ) : null}
        {profileState.status === "signed_out" ? (
          <>
            <h1>Sign in required</h1>
            <Link className="candidate-primary-link" to="/login">Sign in</Link>
          </>
        ) : null}
        {profileState.status === "error" ? (
          <>
            <h1>Profile unavailable</h1>
            <p className="candidate-error">{profileState.message}</p>
            <Link className="candidate-primary-link" to="/me">Back to profile</Link>
          </>
        ) : null}
        {matchesState.status === "error" ? (
          <>
            <h1>Matches unavailable</h1>
            <p className="candidate-error">{matchesState.message}</p>
            <Link className="candidate-primary-link" to="/me">Back to profile</Link>
          </>
        ) : null}
        {profileState.status === "ready" && matchesState.status === "ready" ? (
          <MatchesView matches={matchesState.matches} />
        ) : null}
      </main>
    </CandidateShell>
  )
}

function MatchesView({ matches }: { matches: CandidateMatchCard[] }) {
  const invited = matches.filter((match) => match.bucket === "invited")
  const recommended = matches.filter((match) => match.bucket === "recommended")
  return (
    <>
      <h1>Matches</h1>
      {matches.length === 0 ? (
        <div className="candidate-empty-state">
          <p>No recommended or invited jobs yet.</p>
          <Link className="candidate-secondary-button" to="/me/profile">Review profile</Link>
        </div>
      ) : (
        <div className="candidate-match-list">
          <MatchSection title="Invited" matches={invited} />
          <MatchSection title="Recommended" matches={recommended} />
        </div>
      )}
    </>
  )
}

function MatchSection({ title, matches }: { title: string; matches: CandidateMatchCard[] }) {
  if (matches.length === 0) return null
  return (
    <section className="candidate-match-section">
      <h2>{title}</h2>
      <div>
        {matches.map((match) => (
          <MatchCard key={`${match.matchId}-${match.jobId}`} match={match} />
        ))}
      </div>
    </section>
  )
}

function MatchCard({ match }: { match: CandidateMatchCard }) {
  return (
    <article className="candidate-match-card">
      <div className="candidate-match-heading">
        <div>
          <h3>{match.job.title}</h3>
          <p>{match.job.company}{match.job.location ? ` · ${match.job.location}` : ""}</p>
        </div>
        <span>{formatToken(match.status)}</span>
      </div>
      {match.job.salaryRange ? <p className="candidate-match-salary">{match.job.salaryRange}</p> : null}
      <ReasonList values={match.whyMatched} />
      <div className="candidate-actions">
        <Link className="candidate-primary-link" to={match.job.href}>Open job</Link>
      </div>
    </article>
  )
}

function ReasonList({ values }: { values: string[] }) {
  if (values.length === 0) return null
  return (
    <section className="candidate-match-reasons">
      <h4>Why this matches</h4>
      <ul>
        {values.slice(0, 4).map((value) => (
          <li key={value}>{value}</li>
        ))}
      </ul>
    </section>
  )
}

function formatToken(value: string): string {
  return value.replaceAll("_", " ")
}

const CANDIDATE_MATCHES_STYLES = `
.candidate-matches-panel {
  max-width: 760px;
}
.candidate-empty-state {
  display: grid;
  gap: 12px;
  color: #364233;
}
.candidate-match-list {
  display: grid;
  gap: 20px;
}
.candidate-match-section {
  display: grid;
  gap: 10px;
}
.candidate-match-section > h2 {
  margin: 0;
  font-size: 18px;
  letter-spacing: 0;
}
.candidate-match-section > div {
  display: grid;
  gap: 12px;
}
.candidate-match-card {
  display: grid;
  gap: 12px;
  padding: 16px;
  border: 1px solid #ddd3c2;
  border-radius: 8px;
  background: #fffaf0;
}
.candidate-match-heading {
  display: flex;
  gap: 16px;
  align-items: flex-start;
  justify-content: space-between;
}
.candidate-match-heading h3 {
  margin: 0;
  font-size: 20px;
  line-height: 1.2;
  letter-spacing: 0;
}
.candidate-match-heading p {
  margin: 6px 0 0;
  color: #5f665b;
}
.candidate-match-heading span {
  display: inline-flex;
  align-items: center;
  min-height: 30px;
  padding: 0 10px;
  border-radius: 8px;
  background: #edf5ee;
  color: #24543c;
  font-size: 13px;
  font-weight: 900;
  text-transform: capitalize;
  white-space: nowrap;
}
.candidate-match-salary {
  margin: 0;
  color: #16643b;
  font-weight: 800;
}
.candidate-match-reasons h4 {
  margin: 0 0 6px;
  font-size: 14px;
  letter-spacing: 0;
}
.candidate-match-reasons ul {
  margin: 0;
  padding-left: 18px;
  color: #364233;
  line-height: 1.45;
}
`
