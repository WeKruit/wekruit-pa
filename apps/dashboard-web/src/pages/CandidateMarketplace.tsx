import { collection, getDocs, limit, query, where } from "firebase/firestore"
import { useEffect, useMemo, useState } from "react"
import { DataTable, EmptyState, ErrorState, LoadingState, Panel, StatusBadge, type DataTableColumn } from "../components/ui.js"
import { db } from "../lib/firebase.js"
import {
  MARKETPLACE_TABLES,
  compactValue,
  emptyMarketplaceRows,
  formatPercent,
  formatScore,
  sortRowsByTime,
  summarizeMarketplace,
  type MarketplaceRow,
  type MarketplaceRowsByKey,
  type MarketplaceTableKey,
} from "./CandidateMarketplace.helpers.js"

type CandidateProfile = Record<string, unknown> & {
  candidateLifecycleState?: string
  lifecycleUpdatedAt?: string
  profileCompleteness?: number
  mem0UserId?: string
  latestResumeArtifactId?: string
  linkedinUrl?: string
  piiConsentAt?: string
  level1CollectedAt?: string
  outreach?: { status?: string; cooldownUntil?: string; lastOutboundAt?: string; stickyAccountGroupId?: string }
}

export function CandidateMarketplace({
  candidateId,
  profile,
}: {
  candidateId: string
  profile: CandidateProfile
}) {
  const [rows, setRows] = useState<MarketplaceRowsByKey>(() => emptyMarketplaceRows())
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setErr(null)
    ;(async () => {
      try {
        const results = await Promise.all(
          MARKETPLACE_TABLES.map(async (table) => {
            const snap = await getDocs(
              query(collection(db(), table.collection), where("candidateId", "==", candidateId), limit(100))
            )
            const data = sortRowsByTime(
              snap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }) as MarketplaceRow),
              table.timeFields
            )
            return [table.key, data] as const
          })
        )
        if (cancelled) return
        setRows({ ...emptyMarketplaceRows(), ...Object.fromEntries(results) })
      } catch (e: unknown) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [candidateId])

  const summary = useMemo(() => summarizeMarketplace(rows), [rows])

  if (err) {
    return <ErrorState message={err} />
  }

  return (
    <>
      <Panel title="Marketplace profile" eyebrow="Global candidate">
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
          <Metric label="Lifecycle" value={profile.candidateLifecycleState || "prospect"} />
          <Metric label="Completeness" value={formatPercent(profile.profileCompleteness)} />
          <Metric label="Job states" value={String(summary.totalJobStates)} />
          <Metric label="Passed" value={String(summary.passedJobs)} />
          <Metric label="Active" value={String(summary.activeJobs)} />
          <Metric label="Retained" value={String(summary.notPassedJobs)} />
        </div>
        <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", marginTop: 14 }}>
          <ProfileFact label="mem0 user" value={profile.mem0UserId} />
          <ProfileFact label="Latest resume" value={profile.latestResumeArtifactId} />
          <ProfileFact label="LinkedIn" value={profile.linkedinUrl} />
          <ProfileFact label="PII consent" value={profile.piiConsentAt} />
          <ProfileFact label="Level 1" value={profile.level1CollectedAt} />
          <ProfileFact label="Outreach" value={profile.outreach?.status} />
        </div>
      </Panel>

      {loading ? (
        <Panel title="Marketplace collections">
          <LoadingState label="Loading marketplace rows..." />
        </Panel>
      ) : (
        <>
          <MarketplaceTable
            title="Candidate job states"
            rows={rows.jobStates}
            columns={jobStateColumns}
            tableKey="jobStates"
          />
          <MarketplaceTable title="Job matches" rows={rows.matches} columns={matchColumns} tableKey="matches" />
          <MarketplaceTable title="Outbound invites" rows={rows.invites} columns={inviteColumns} tableKey="invites" />
          <MarketplaceTable
            title="Employer-visible snapshots"
            rows={rows.employerSnapshots}
            columns={employerSnapshotColumns}
            tableKey="employerSnapshots"
          />
          <MarketplaceTable title="Linked handles" rows={rows.handles} columns={handleColumns} tableKey="handles" />
          <MarketplaceTable title="Resume artifacts" rows={rows.resumes} columns={resumeColumns} tableKey="resumes" />
          <MarketplaceTable title="Feedback events" rows={rows.feedback} columns={feedbackColumns} tableKey="feedback" />
          <MarketplaceTable title="Correction events" rows={rows.corrections} columns={correctionColumns} tableKey="corrections" />
        </>
      )}
    </>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "0.75rem 0.85rem", background: "#fff" }}>
      <div style={{ color: "#64748b", fontSize: "0.74em", textTransform: "uppercase" }}>{label}</div>
      <div style={{ color: "#0f172a", fontSize: "1.15em", fontWeight: 650, marginTop: 4 }}>{value}</div>
    </div>
  )
}

function ProfileFact({ label, value }: { label: string; value: unknown }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ color: "#64748b", fontSize: "0.76em", textTransform: "uppercase" }}>{label}</div>
      <div style={{ color: "#0f172a", fontSize: "0.9em", overflowWrap: "anywhere" }}>{compactValue(value, 140)}</div>
    </div>
  )
}

function MarketplaceTable({
  title,
  rows,
  columns,
  tableKey,
}: {
  title: string
  rows: MarketplaceRow[]
  columns: DataTableColumn<MarketplaceRow>[]
  tableKey: MarketplaceTableKey
}) {
  return (
    <Panel title={`${title} (${rows.length})`}>
      <DataTable<MarketplaceRow>
        rows={rows}
        empty={<EmptyState title={`No ${title.toLowerCase()}`} body={`No rows in ${collectionFor(tableKey)} for this candidate.`} />}
        columns={columns}
      />
    </Panel>
  )
}

function collectionFor(key: MarketplaceTableKey): string {
  return MARKETPLACE_TABLES.find((table) => table.key === key)?.collection ?? key
}

function valueCell(field: string, max = 180) {
  return (row: MarketplaceRow) => compactValue(row[field], max)
}

function statusCell(field: string) {
  return (row: MarketplaceRow) => <StatusBadge value={String(row[field] ?? "")} />
}

const jobStateColumns: DataTableColumn<MarketplaceRow>[] = [
  { key: "jobId", header: "Job", render: valueCell("jobId") },
  { key: "state", header: "State", render: statusCell("state") },
  { key: "stateUpdatedAt", header: "Updated", render: valueCell("stateUpdatedAt") },
  { key: "reason", header: "Reason", render: valueCell("reason", 260) },
  { key: "latestMatchId", header: "Latest match", render: valueCell("latestMatchId") },
]

const matchColumns: DataTableColumn<MarketplaceRow>[] = [
  { key: "jobId", header: "Job", render: valueCell("jobId") },
  { key: "finalScore", header: "Score", render: (row) => formatScore(row.finalScore) },
  { key: "recommendedAction", header: "Action", render: statusCell("recommendedAction") },
  { key: "hardFilterResult", header: "Hard filter", render: statusCell("hardFilterResult") },
  { key: "reasons", header: "Reasons", render: valueCell("reasons", 320) },
]

const inviteColumns: DataTableColumn<MarketplaceRow>[] = [
  { key: "jobId", header: "Job", render: valueCell("jobId") },
  { key: "status", header: "Status", render: statusCell("status") },
  { key: "policyDecision", header: "Policy", render: statusCell("policyDecision") },
  { key: "updatedAt", header: "Updated", render: valueCell("updatedAt") },
  { key: "outboundId", header: "Outbound", render: valueCell("outboundId") },
]

const employerSnapshotColumns: DataTableColumn<MarketplaceRow>[] = [
  { key: "jobId", header: "Job", render: valueCell("jobId") },
  { key: "createdAt", header: "Created", render: valueCell("createdAt") },
  { key: "createdBy", header: "By", render: statusCell("createdBy") },
  { key: "passReason", header: "Pass reason", render: valueCell("passReason", 280) },
  { key: "matchReason", header: "Match reason", render: valueCell("matchReason", 280) },
]

const handleColumns: DataTableColumn<MarketplaceRow>[] = [
  { key: "kind", header: "Kind", render: statusCell("kind") },
  { key: "source", header: "Source", render: statusCell("source") },
  { key: "verifiedAt", header: "Verified", render: valueCell("verifiedAt") },
  { key: "deliverable", header: "Deliverable", render: (row) => compactValue(row.deliverable) },
  { key: "createdAt", header: "Created", render: valueCell("createdAt") },
]

const resumeColumns: DataTableColumn<MarketplaceRow>[] = [
  { key: "status", header: "Status", render: statusCell("status") },
  { key: "source", header: "Source", render: statusCell("source") },
  { key: "fileName", header: "File", render: valueCell("fileName", 260) },
  { key: "parsedCandidateResumeId", header: "Parsed resume", render: valueCell("parsedCandidateResumeId") },
  { key: "updatedAt", header: "Updated", render: valueCell("updatedAt") },
]

const feedbackColumns: DataTableColumn<MarketplaceRow>[] = [
  { key: "createdAt", header: "Created", render: valueCell("createdAt") },
  { key: "kind", header: "Kind", render: statusCell("kind") },
  { key: "actor", header: "Actor", render: statusCell("actor") },
  { key: "jobId", header: "Job", render: valueCell("jobId") },
  { key: "outcome", header: "Outcome", render: valueCell("outcome", 260) },
]

const correctionColumns: DataTableColumn<MarketplaceRow>[] = [
  { key: "createdAt", header: "Created", render: valueCell("createdAt") },
  { key: "targetType", header: "Target", render: statusCell("targetType") },
  { key: "actor", header: "Actor", render: statusCell("actor") },
  { key: "jobId", header: "Job", render: valueCell("jobId") },
  { key: "reason", header: "Reason", render: valueCell("reason", 320) },
]
