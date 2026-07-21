import { useState, type CSSProperties } from "react"
import { httpsCallable } from "firebase/functions"

import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Panel,
} from "../components/ui.js"
import { AdminJobLink, AdminUserLink } from "../components/AdminEntityLink.js"
import { functions } from "../lib/firebase.js"
import {
  runRediscoverCallable,
  type RediscoverResult,
  type RediscoverTier,
} from "../lib/job-enrich-api.js"
import {
  MATCH_DEBUG_DEFAULT_WEIGHTS,
  MATCH_DEBUG_WEIGHT_KEYS,
  actionTone,
  buildCandidateDebugRequest,
  buildJobDebugRequest,
  compactList,
  displaySponsorship,
  formatScore,
  matchDebugCallableName,
  type MatchDebugDirection,
  type MatchDebugWeightKey,
} from "./MatchDebug.helpers.js"

interface CandidateDebugJob {
  jobId: string
  jobTitle?: string
  companyName?: string
  atsApplyUrl?: string | null
  roleFunction?: string[]
  seniorityLevel?: string | null
  sponsorship?: boolean | null
  firstSeenAt?: string | null
  v16Score?: Record<string, number>
  matchedSkills?: Array<{ name: string; proficiency?: string; weight?: number }>
  reason?: string
  requiredSkills?: string[]
}

interface CandidateDebugResult {
  jobs: CandidateDebugJob[]
  total: number
  dropped: number
  hardFilter: Record<string, number>
  noUserTags?: boolean
  llmCacheStale?: boolean
  userTags?: Record<string, unknown> | null
}

interface JobCandidateRow {
  candidateId: string
  displayName?: string
  candidateLifecycleState?: string
  hardFilterResult?: string
  finalScore?: number
  softScore?: number
  llmScore?: number
  embeddingScore?: number
  finalRank?: number
  recommendedAction?: "auto_outbound" | "hitl_review" | "do_not_contact"
  scoreBreakdown?: Record<string, { score?: number; weight?: number; summary?: string }>
  matchedSignals?: string[]
  blockedSignals?: string[]
  reasons?: string[]
  risks?: string[]
  missingInfo?: string[]
  candidateTagSnapshot?: Record<string, unknown>
}

interface JobDebugResult {
  direction: "job_to_candidate"
  jobId: string
  job: {
    jobTitle?: string
    companyName?: string
    sponsorship?: boolean | null
    roleFunction?: string[]
    industrySector?: string[]
  }
  candidatePool: {
    totalLoaded: number
    totalReturned: number
  }
  candidates: JobCandidateRow[]
  hardFilter: Record<string, number>
  dropped: number
}

export function MatchDebug() {
  const [direction, setDirection] = useState<MatchDebugDirection>("candidate_to_jobs")
  const [userId, setUserId] = useState("")
  const [jobId, setJobId] = useState("")
  const [jobLimit, setJobLimit] = useState(20)
  const [candidateResult, setCandidateResult] = useState<CandidateDebugResult | null>(null)
  const [jobResult, setJobResult] = useState<JobDebugResult | null>(null)
  const [rediscoverResult, setRediscoverResult] = useState<RediscoverResult | null>(null)
  const [rediscoverTiers, setRediscoverTiers] = useState<RediscoverTier[]>(["tier_1", "tier_2"])
  const [rediscovering, setRediscovering] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [weights, setWeights] = useState<Record<MatchDebugWeightKey, number>>({
    ...MATCH_DEBUG_DEFAULT_WEIGHTS,
  })

  async function runQuery(): Promise<void> {
    setLoading(true)
    setError(null)
    setCandidateResult(null)
    setJobResult(null)
    try {
      if (direction === "candidate_to_jobs") {
        const fn = httpsCallable<ReturnType<typeof buildCandidateDebugRequest>, CandidateDebugResult>(
          functions(),
          matchDebugCallableName(direction)
        )
        const res = await fn(buildCandidateDebugRequest(userId, weights, 10))
        setCandidateResult(res.data)
      } else {
        const fn = httpsCallable<ReturnType<typeof buildJobDebugRequest>, JobDebugResult>(
          functions(),
          matchDebugCallableName(direction)
        )
        const res = await fn(buildJobDebugRequest(jobId, jobLimit))
        setJobResult(res.data)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  async function runRediscover(): Promise<void> {
    setRediscovering(true)
    setError(null)
    setRediscoverResult(null)
    try {
      const res = await runRediscoverCallable(jobId, rediscoverTiers, jobLimit)
      setRediscoverResult(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRediscovering(false)
    }
  }

  const canRun = direction === "candidate_to_jobs" ? userId.trim().length > 0 : jobId.trim().length > 0

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="v2.0 S5 / Admin"
        title="Match Debug"
        description="Inspect candidate-to-jobs and job-to-candidates matching evidence without sending outbound."
      />

      <Panel title="Query" eyebrow="direction + inputs">
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <button type="button" onClick={() => setDirection("candidate_to_jobs")} style={tabStyle(direction === "candidate_to_jobs")}>
            Candidate to jobs
          </button>
          <button type="button" onClick={() => setDirection("job_to_candidates")} style={tabStyle(direction === "job_to_candidates")}>
            Job to candidates
          </button>
        </div>

        {direction === "candidate_to_jobs" ? (
          <CandidateQuery userId={userId} setUserId={setUserId} weights={weights} setWeights={setWeights} />
        ) : (
          <JobQuery
            jobId={jobId}
            setJobId={setJobId}
            jobLimit={jobLimit}
            setJobLimit={setJobLimit}
            rediscoverTiers={rediscoverTiers}
            setRediscoverTiers={setRediscoverTiers}
            onRediscover={() => void runRediscover()}
            rediscovering={rediscovering}
          />
        )}

        <button
          type="button"
          onClick={() => void runQuery()}
          disabled={loading || !canRun}
          style={{
            marginTop: 12,
            padding: "0.5rem 1rem",
            background: loading || !canRun ? "#94a3b8" : "#1a73e8",
            color: "white",
            border: "none",
            borderRadius: "0.375rem",
            cursor: loading || !canRun ? "not-allowed" : "pointer",
            fontWeight: 600,
          }}
        >
          {loading ? "Running" : "Run debug"}
        </button>
      </Panel>

      {error ? (
        <Panel title="Error" eyebrow="callable failure">
          <ErrorState message={error} />
        </Panel>
      ) : null}
      {loading ? (
        <Panel title="Running query" eyebrow={direction}>
          <LoadingState label="Running match debug" />
        </Panel>
      ) : null}
      {candidateResult ? <CandidateResults result={candidateResult} /> : null}
      {jobResult ? <JobResults result={jobResult} /> : null}
      {rediscovering ? (
        <Panel title="Rediscovering" eyebrow="silver-medalist tiered pool">
          <LoadingState label="Ranking tiered candidate pool" />
        </Panel>
      ) : null}
      {rediscoverResult ? <RediscoverResults result={rediscoverResult} /> : null}
    </div>
  )
}

function CandidateQuery({
  userId,
  setUserId,
  weights,
  setWeights,
}: {
  userId: string
  setUserId: (value: string) => void
  weights: Record<MatchDebugWeightKey, number>
  setWeights: (value: Record<MatchDebugWeightKey, number>) => void
}) {
  return (
    <>
      <input
        type="text"
        placeholder="userId"
        value={userId}
        onChange={(event) => setUserId(event.target.value)}
        style={inputStyle}
      />
      <details style={{ marginTop: 12 }}>
        <summary style={{ cursor: "pointer", fontWeight: 700 }}>Score weights</summary>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12, marginTop: 10 }}>
          {MATCH_DEBUG_WEIGHT_KEYS.map((key) => (
            <label key={key} style={{ display: "grid", gap: 4, fontSize: 13 }}>
              <span>{key}: {weights[key].toFixed(2)}</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={weights[key]}
                onChange={(event) => setWeights({ ...weights, [key]: Number(event.target.value) })}
              />
            </label>
          ))}
        </div>
      </details>
    </>
  )
}

const REDISCOVER_TIER_OPTIONS: RediscoverTier[] = ["tier_1", "tier_2", "tier_3"]

function JobQuery({
  jobId,
  setJobId,
  jobLimit,
  setJobLimit,
  rediscoverTiers,
  setRediscoverTiers,
  onRediscover,
  rediscovering,
}: {
  jobId: string
  setJobId: (value: string) => void
  jobLimit: number
  setJobLimit: (value: number) => void
  rediscoverTiers: RediscoverTier[]
  setRediscoverTiers: (value: RediscoverTier[]) => void
  onRediscover: () => void
  rediscovering: boolean
}) {
  function toggleTier(tier: RediscoverTier) {
    setRediscoverTiers(
      rediscoverTiers.includes(tier)
        ? rediscoverTiers.filter((t) => t !== tier)
        : [...rediscoverTiers, tier],
    )
  }
  const canRediscover = jobId.trim().length > 0 && rediscoverTiers.length > 0 && !rediscovering
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 120px", gap: 8 }}>
        <input
          type="text"
          placeholder="matching-jobs jobId"
          value={jobId}
          onChange={(event) => setJobId(event.target.value)}
          style={inputStyle}
        />
        <input
          type="number"
          min={1}
          max={50}
          value={jobLimit}
          onChange={(event) => setJobLimit(Math.max(1, Math.min(50, Number(event.target.value))))}
          style={inputStyle}
        />
      </div>
      <details style={{ marginTop: 12 }}>
        <summary style={{ cursor: "pointer", fontWeight: 700 }}>Rediscover silver-medalists</summary>
        <div style={{ marginTop: 10, fontSize: 13, color: "#475569" }}>
          Rank the retained candidate-tier pool (strong candidates rejected on a prior role) against this job —
          the NOT_PASS-stays-in-pool reactivation. Consent-safe: ids + scores + tier only.
        </div>
        <div style={{ display: "flex", gap: 12, marginTop: 10, flexWrap: "wrap" }}>
          {REDISCOVER_TIER_OPTIONS.map((tier) => (
            <label key={tier} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
              <input type="checkbox" checked={rediscoverTiers.includes(tier)} onChange={() => toggleTier(tier)} />
              {tier}
            </label>
          ))}
        </div>
        <button
          type="button"
          onClick={onRediscover}
          disabled={!canRediscover}
          style={{
            marginTop: 10,
            padding: "0.45rem 1rem",
            background: canRediscover ? "#7c3aed" : "#94a3b8",
            color: "white",
            border: "none",
            borderRadius: "0.375rem",
            cursor: canRediscover ? "pointer" : "not-allowed",
            fontWeight: 600,
          }}
        >
          {rediscovering ? "Rediscovering…" : "Rediscover silver-medalists"}
        </button>
      </details>
    </>
  )
}

function CandidateResults({ result }: { result: CandidateDebugResult }) {
  return (
    <>
      <Panel title="Filter summary" eyebrow="candidate to jobs">
        <div>Total survivors: <strong>{result.total}</strong> · Dropped: <strong>{result.dropped}</strong></div>
        <pre style={preStyle}>{JSON.stringify(result.hardFilter, null, 2)}</pre>
      </Panel>
      <Panel title={`Top ${result.jobs.length} jobs`} eyebrow="V16 breakdown">
        {result.jobs.length === 0 ? (
          <EmptyState title={result.noUserTags ? "No user tags" : "No matches"} body="Inspect hard-filter counters above." />
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {result.jobs.map((job, index) => (
              <article key={job.jobId} style={rowStyle}>
                <strong>
                  {index + 1}. <AdminJobLink jobId={job.jobId}>{job.jobTitle ?? job.jobId}</AdminJobLink> @ {job.companyName ?? "(no company)"}
                </strong>
                <div style={mutedStyle}>
                  score={formatScore(job.v16Score?.total)} · sponsor={displaySponsorship(job.sponsorship)} · role=[{compactList(job.roleFunction)}]
                </div>
                <div>{job.reason}</div>
              </article>
            ))}
          </div>
        )}
      </Panel>
    </>
  )
}

function JobResults({ result }: { result: JobDebugResult }) {
  return (
    <>
      <Panel title="Filter summary" eyebrow="job to candidates">
        <div>
          Loaded: <strong>{result.candidatePool.totalLoaded}</strong> · Returned:{" "}
          <strong>{result.candidatePool.totalReturned}</strong> · Dropped: <strong>{result.dropped}</strong>
        </div>
        <div style={mutedStyle}>
          <AdminJobLink jobId={result.jobId}>{result.job.jobTitle ?? result.jobId}</AdminJobLink> @ {result.job.companyName ?? "(company unknown)"} · sponsor={displaySponsorship(result.job.sponsorship)}
        </div>
        <pre style={preStyle}>{JSON.stringify(result.hardFilter, null, 2)}</pre>
      </Panel>
      <Panel title={`Top ${result.candidates.length} candidates`} eyebrow="S5 recommended action">
        {result.candidates.length === 0 ? (
          <EmptyState title="No candidates" body="No retained/profile-ready candidates matched this job." />
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {result.candidates.map((candidate) => (
              <article key={candidate.candidateId} style={rowStyle}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                  <strong>
                    {candidate.finalRank ?? "-"} ·{" "}
                    <AdminUserLink userId={candidate.candidateId}>{candidate.displayName ?? candidate.candidateId}</AdminUserLink>
                  </strong>
                  <span style={badgeStyle(actionTone(candidate.recommendedAction))}>
                    {candidate.recommendedAction ? candidate.recommendedAction.replaceAll("_", " ") : "no action"}
                  </span>
                </div>
                <div style={mutedStyle}>
                  final={formatScore(candidate.finalScore)} · soft={formatScore(candidate.softScore)} · llm={formatScore(candidate.llmScore)} · emb={formatScore(candidate.embeddingScore)} · hard={candidate.hardFilterResult ?? "-"}
                </div>
                <DebugList label="Reasons" values={candidate.reasons} />
                <DebugList label="Risks" values={candidate.risks} />
                <DebugList label="Missing info" values={candidate.missingInfo} />
                <DebugList label="Blocked" values={candidate.blockedSignals} />
              </article>
            ))}
          </div>
        )}
      </Panel>
    </>
  )
}

function RediscoverResults({ result }: { result: RediscoverResult }) {
  if (result.error) {
    return (
      <Panel title="Rediscover" eyebrow="silver-medalist tiered pool">
        <EmptyState
          title="Job not in the matchable catalog yet"
          body={`${result.error}\n\nThis job (${result.jobId}) isn't indexed in matching-jobs — collab jobs created via the admin form may not be scraped/indexed yet. Rediscover currently ranks against the matching-jobs catalog.`}
        />
      </Panel>
    )
  }
  const candidates = result.candidates ?? []
  return (
    <>
      <Panel title="Rediscover summary" eyebrow="silver-medalist tiered pool">
        <div>
          Tier pool loaded: <strong>{result.candidatePool?.totalLoaded ?? 0}</strong> · Returned:{" "}
          <strong>{result.candidatePool?.totalReturned ?? candidates.length}</strong>
        </div>
        <div style={mutedStyle}>
          <AdminJobLink jobId={result.jobId}>{result.job?.jobTitle ?? result.jobId}</AdminJobLink> @{" "}
          {result.job?.companyName ?? "(company unknown)"} · tiers=[{(result.tiers ?? []).join(", ")}]
        </div>
      </Panel>
      <Panel title={`Top ${candidates.length} silver-medalists`} eyebrow="retained-pool reactivation">
        {candidates.length === 0 ? (
          <EmptyState title="No tiered candidates" body="No tier_1/tier_2/tier_3 candidates matched this job." />
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {candidates.map((candidate) => (
              <article key={candidate.candidateId} style={rowStyle}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                  <strong>
                    {candidate.finalRank ?? "-"} ·{" "}
                    <AdminUserLink userId={candidate.candidateId}>
                      {candidate.displayName ?? candidate.candidateId}
                    </AdminUserLink>
                  </strong>
                  <span style={{ display: "flex", gap: 6 }}>
                    {candidate.globalTier ? <span style={badgeStyle("muted")}>{candidate.globalTier}</span> : null}
                    <span style={badgeStyle(actionTone(candidate.recommendedAction))}>
                      {candidate.recommendedAction ? candidate.recommendedAction.replaceAll("_", " ") : "no action"}
                    </span>
                  </span>
                </div>
                <div style={mutedStyle}>
                  final={formatScore(candidate.finalScore)} · soft={formatScore(candidate.softScore)} · llm=
                  {formatScore(candidate.llmScore)} · emb={formatScore(candidate.embeddingScore)} · hard=
                  {candidate.hardFilterResult ?? "-"}
                  {candidate.tierReusable === false ? " · tier not reusable" : ""}
                </div>
                <DebugList label="Reasons" values={candidate.reasons} />
                <DebugList label="Risks" values={candidate.risks} />
              </article>
            ))}
          </div>
        )}
      </Panel>
    </>
  )
}

function DebugList({ label, values }: { label: string; values?: string[] }) {
  if (!values || values.length === 0) return null
  return <div><strong>{label}:</strong> {values.join(", ")}</div>
}

function tabStyle(active: boolean): CSSProperties {
  return {
    padding: "0.45rem 0.75rem",
    borderRadius: 6,
    border: `1px solid ${active ? "#1a73e8" : "#cbd5e1"}`,
    background: active ? "#e8f0fe" : "white",
    color: active ? "#174ea6" : "#334155",
    fontWeight: 700,
    cursor: "pointer",
  }
}

function badgeStyle(tone: "ok" | "warn" | "muted"): CSSProperties {
  const map = {
    ok: { background: "#dcfce7", color: "#166534" },
    warn: { background: "#fef3c7", color: "#92400e" },
    muted: { background: "#f1f5f9", color: "#475569" },
  }[tone]
  return { ...map, borderRadius: 999, padding: "0.2rem 0.55rem", fontSize: 12, fontWeight: 800 }
}

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "0.5rem 0.75rem",
  border: "1px solid #cbd5e1",
  borderRadius: "0.375rem",
  fontFamily: "monospace",
  fontSize: "0.9em",
}

const rowStyle: CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  padding: 12,
  fontSize: "0.9em",
}

const mutedStyle: CSSProperties = {
  color: "#64748b",
  marginTop: 4,
}

const preStyle: CSSProperties = {
  background: "#f8fafc",
  borderRadius: 6,
  padding: 10,
  overflowX: "auto",
}
