import { collection, getDocs, limit, query, where } from "firebase/firestore"
import { useEffect, useMemo, useState } from "react"
import { AdminJobLink, AdminPrescreenSessionLink, AdminUserLink } from "../components/AdminEntityLink.js"
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
  tags?: Record<string, unknown>
  globalTags?: Record<string, unknown>
  conversationDerivedPreferences?: Record<string, unknown>
  outreach?: { status?: string; cooldownUntil?: string; lastOutboundAt?: string; stickyAccountGroupId?: string }
}

type ParsedResume = MarketplaceRow & {
  originalFileName?: string
  parserModel?: string
  parserVersion?: string
  experiences?: unknown
  workHistory?: unknown
  candidateProfile?: Record<string, unknown>
}

type ExperienceEntry = {
  title?: string
  company?: string
  location?: string
  startDate?: string
  endDate?: string
  currentRole?: boolean
  description?: string
  bullets: string[]
}

export function CandidateMarketplace({
  candidateId,
  profile,
}: {
  candidateId: string
  profile: CandidateProfile
}) {
  const [rows, setRows] = useState<MarketplaceRowsByKey>(() => emptyMarketplaceRows())
  const [latestResume, setLatestResume] = useState<ParsedResume | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setErr(null)
    ;(async () => {
      try {
        const [results, resume] = await Promise.all([
          Promise.all(
            MARKETPLACE_TABLES.map(async (table) => {
              const data = await readCandidateMarketplaceRows(table, candidateId)
              return [table.key, data] as const
            })
          ),
          readLatestParsedResume(candidateId),
        ])
        if (cancelled) return
        setRows({ ...emptyMarketplaceRows(), ...Object.fromEntries(results) })
        setLatestResume(resume)
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
          <Metric label="Auth mappings" value={String(summary.authMappings)} />
          <Metric label="Identity events" value={String(summary.identityEvents)} />
          <Metric label="Open conflicts" value={String(summary.openIdentityConflicts)} />
        </div>
        <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", marginTop: 14 }}>
          <ProfileFact label="mem0 user" value={profile.mem0UserId} />
          <ProfileFact label="Latest resume" value={profile.latestResumeArtifactId} />
          <ProfileFact label="LinkedIn" value={profile.linkedinUrl} />
          <ProfileFact label="PII consent" value={profile.piiConsentAt} />
          <ProfileFact label="Level 1" value={profile.level1CollectedAt} />
          <ProfileFact label="Outreach" value={profile.outreach?.status} />
          <TagSummary tags={profile.tags ?? profile.globalTags} />
          <ExperienceSummary resume={latestResume} />
          <ProfileFact label="Chat preferences" value={profile.conversationDerivedPreferences} />
        </div>
      </Panel>

      {loading ? (
        <Panel title="Marketplace collections">
          <LoadingState label="Loading marketplace rows..." />
        </Panel>
      ) : (
        <>
          <MarketplaceTable
            title="Candidate auth mappings"
            rows={rows.authMappings}
            columns={authMappingColumns}
            tableKey="authMappings"
          />
          <MarketplaceTable
            title="Identity events"
            rows={rows.identityEvents}
            columns={identityEventColumns}
            tableKey="identityEvents"
          />
          <MarketplaceTable
            title="Identity conflicts"
            rows={rows.identityConflicts}
            columns={identityConflictColumns}
            tableKey="identityConflicts"
          />
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

async function readCandidateMarketplaceRows(
  table: (typeof MARKETPLACE_TABLES)[number],
  candidateId: string
): Promise<MarketplaceRow[]> {
  if (table.key === "identityConflicts") {
    const docsById = new Map<string, MarketplaceRow>()
    for (const field of ["primaryCandidateId", "competingCandidateId"]) {
      const snap = await getDocs(
        query(collection(db(), table.collection), where(field, "==", candidateId), limit(100))
      )
      for (const docSnap of snap.docs) {
        docsById.set(docSnap.id, { id: docSnap.id, ...docSnap.data() } as MarketplaceRow)
      }
    }
    return sortRowsByTime([...docsById.values()], table.timeFields)
  }

  const snap = await getDocs(
    query(collection(db(), table.collection), where("candidateId", "==", candidateId), limit(100))
  )
  return sortRowsByTime(
    snap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }) as MarketplaceRow),
    table.timeFields
  )
}

async function readLatestParsedResume(candidateId: string): Promise<ParsedResume | null> {
  const snap = await getDocs(query(collection(db(), "parsedCandidateResumes"), where("userId", "==", candidateId), limit(20)))
  const rows = sortRowsByTime(
    snap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }) as MarketplaceRow),
    ["createdAt", "updatedAt", "ingestedAt"]
  )
  return (rows[0] as ParsedResume | undefined) ?? null
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

function TagSummary({ tags }: { tags: unknown }) {
  if (!isRecord(tags)) {
    return <ProfileFact label="Candidate tags" value={tags} />
  }

  const sections = [
    { label: "Target locations", values: stringArrayField(tags, ["targetLocations", "locations"]) },
    { label: "Industry", values: stringArrayField(tags, ["industryEnum", "industries", "industrySector", "industryTags"]) },
    { label: "Specialization", values: stringArrayField(tags, ["specialization", "specializations", "relevantSpecialization"]) },
    { label: "Role focus", values: stringArrayField(tags, ["targetRoleFunction", "roleFunction", "roleFunctions"]) },
    { label: "Skills", values: skillNames(tags.skills) },
  ].filter((section) => section.values.length > 0)

  return (
    <div style={{ gridColumn: "1 / -1", minWidth: 0 }}>
      <div style={{ color: "#64748b", fontSize: "0.76em", textTransform: "uppercase" }}>Candidate tags</div>
      <div style={{ display: "grid", gap: 12, marginTop: 8 }}>
        <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
          <ProfileFact label="Recent role" value={stringField(tags, "recentRoleTitle")} />
          <ProfileFact label="Recent company" value={stringField(tags, "recentCompany")} />
          <ProfileFact label="Career stage" value={stringField(tags, "careerStage")} />
          <ProfileFact label="Updated" value={stringField(tags, "updatedAt") ?? stringField(tags, "lastUpdatedAt")} />
        </div>
        {sections.map((section) => (
          <TagSection key={section.label} label={section.label} values={section.values} />
        ))}
        <details>
          <summary style={{ color: "#475569", cursor: "pointer", fontSize: "0.86em" }}>Raw JSON</summary>
          <pre
            style={{
              background: "#f8fafc",
              border: "1px solid #e2e8f0",
              borderRadius: 8,
              color: "#0f172a",
              fontSize: "0.78em",
              lineHeight: 1.45,
              margin: "8px 0 0",
              maxHeight: 260,
              overflow: "auto",
              padding: 12,
              whiteSpace: "pre-wrap",
            }}
          >
            {JSON.stringify(tags, null, 2)}
          </pre>
        </details>
      </div>
    </div>
  )
}

function TagSection({ label, values, limit = 18 }: { label: string; values: string[]; limit?: number }) {
  const [expanded, setExpanded] = useState(false)
  const uniqueValues = dedupeStrings(values)
  const visibleValues = expanded ? uniqueValues : uniqueValues.slice(0, limit)
  const remaining = Math.max(0, uniqueValues.length - visibleValues.length)

  if (uniqueValues.length === 0) return null

  return (
    <div>
      <div style={{ color: "#64748b", fontSize: "0.76em", textTransform: "uppercase" }}>{label}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 6 }}>
        {visibleValues.map((value) => (
          <span
            key={value}
            style={{
              border: "1px solid #cbd5e1",
              borderRadius: 7,
              color: "#0f172a",
              fontSize: "0.86em",
              padding: "0.28rem 0.55rem",
            }}
          >
            {formatTagText(value)}
          </span>
        ))}
        {uniqueValues.length > limit ? (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
            style={{
              background: "transparent",
              border: "none",
              color: "#475569",
              cursor: "pointer",
              font: "inherit",
              fontSize: "0.86em",
              padding: "0.28rem 0",
              textDecoration: "underline",
            }}
          >
            {expanded ? "Show fewer" : `+${remaining} more`}
          </button>
        ) : null}
      </div>
    </div>
  )
}

function ExperienceSummary({ resume }: { resume: ParsedResume | null }) {
  const experiences = resume ? resumeExperiences(resume) : []

  return (
    <div style={{ gridColumn: "1 / -1", minWidth: 0 }}>
      <div style={{ color: "#64748b", fontSize: "0.76em", textTransform: "uppercase" }}>Past experience</div>
      {!resume ? (
        <div style={{ color: "#64748b", fontSize: "0.9em", marginTop: 6 }}>No parsed resume found.</div>
      ) : experiences.length === 0 ? (
        <div style={{ color: "#64748b", fontSize: "0.9em", marginTop: 6 }}>
          Parsed resume found, but no work history entries were extracted.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 10, marginTop: 8 }}>
          <div style={{ color: "#64748b", fontSize: "0.82em" }}>
            Source: {resume.originalFileName || resume.id}
            {resume.parserModel ? ` · ${resume.parserModel}` : ""}
          </div>
          {experiences.map((experience, index) => (
            <ExperienceCard key={`${experience.company ?? "company"}-${experience.title ?? "title"}-${index}`} experience={experience} />
          ))}
        </div>
      )}
    </div>
  )
}

function ExperienceCard({ experience }: { experience: ExperienceEntry }) {
  const title = experience.title || "Role"
  const company = experience.company || "Company"
  const dateRange = [experience.startDate, experience.currentRole ? "Present" : experience.endDate].filter(Boolean).join(" - ")
  const meta = [dateRange, experience.location].filter(Boolean).join(" · ")
  const visibleBullets = experience.bullets.slice(0, 3)

  return (
    <div style={{ borderLeft: "3px solid #cbd5e1", paddingLeft: 12 }}>
      <div style={{ color: "#0f172a", fontWeight: 650 }}>
        {title} @ {company}
      </div>
      {meta ? <div style={{ color: "#64748b", fontSize: "0.84em", marginTop: 2 }}>{meta}</div> : null}
      {experience.description ? (
        <div style={{ color: "#334155", fontSize: "0.9em", lineHeight: 1.45, marginTop: 6 }}>{experience.description}</div>
      ) : null}
      {visibleBullets.length ? (
        <ul style={{ color: "#334155", fontSize: "0.86em", lineHeight: 1.45, margin: "6px 0 0", paddingLeft: 18 }}>
          {visibleBullets.map((bullet) => (
            <li key={bullet}>{bullet}</li>
          ))}
        </ul>
      ) : null}
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

function jobLinkCell(field = "jobId", max = 180) {
  return (row: MarketplaceRow) => {
    const jobId = linkableId(row[field])
    return jobId ? <AdminJobLink jobId={jobId}>{compactValue(jobId, max)}</AdminJobLink> : "-"
  }
}

function userLinkCell(field: string, max = 180) {
  return (row: MarketplaceRow) => {
    const userId = linkableId(row[field])
    return userId ? <AdminUserLink userId={userId}>{compactValue(userId, max)}</AdminUserLink> : "-"
  }
}

function prescreenSessionLinkCell(field = "prescreenSessionId", max = 180) {
  return (row: MarketplaceRow) => {
    const sessionId = linkableId(row[field])
    return sessionId ? <AdminPrescreenSessionLink sessionId={sessionId}>{compactValue(sessionId, max)}</AdminPrescreenSessionLink> : "-"
  }
}

function linkableId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

function statusCell(field: string) {
  return (row: MarketplaceRow) => <StatusBadge value={String(row[field] ?? "")} />
}

const jobStateColumns: DataTableColumn<MarketplaceRow>[] = [
  { key: "jobId", header: "Job", render: jobLinkCell() },
  { key: "state", header: "State", render: statusCell("state") },
  { key: "stateUpdatedAt", header: "Updated", render: valueCell("stateUpdatedAt") },
  { key: "reason", header: "Reason", render: valueCell("reason", 260) },
  { key: "prescreenSessionId", header: "Prescreen", render: prescreenSessionLinkCell("prescreenSessionId", 160) },
  { key: "latestMatchId", header: "Latest match", render: valueCell("latestMatchId") },
]

const matchColumns: DataTableColumn<MarketplaceRow>[] = [
  { key: "jobId", header: "Job", render: jobLinkCell() },
  { key: "finalScore", header: "Score", render: (row) => formatScore(row.finalScore) },
  { key: "recommendedAction", header: "Action", render: statusCell("recommendedAction") },
  { key: "hardFilterResult", header: "Hard filter", render: statusCell("hardFilterResult") },
  { key: "reasons", header: "Reasons", render: valueCell("reasons", 320) },
]

const inviteColumns: DataTableColumn<MarketplaceRow>[] = [
  { key: "jobId", header: "Job", render: jobLinkCell() },
  { key: "status", header: "Status", render: statusCell("status") },
  { key: "policyDecision", header: "Policy", render: statusCell("policyDecision") },
  { key: "updatedAt", header: "Updated", render: valueCell("updatedAt") },
  { key: "outboundId", header: "Outbound", render: valueCell("outboundId") },
]

const employerSnapshotColumns: DataTableColumn<MarketplaceRow>[] = [
  { key: "jobId", header: "Job", render: jobLinkCell() },
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

const authMappingColumns: DataTableColumn<MarketplaceRow>[] = [
  { key: "id", header: "Firebase uid", render: userLinkCell("id") },
  { key: "candidateId", header: "Candidate", render: userLinkCell("candidateId") },
  { key: "emailNormalized", header: "Email", render: valueCell("emailNormalized") },
  { key: "provider", header: "Provider", render: statusCell("provider") },
  { key: "claimedAt", header: "Claimed", render: valueCell("claimedAt") },
  { key: "updatedAt", header: "Updated", render: valueCell("updatedAt") },
]

const identityEventColumns: DataTableColumn<MarketplaceRow>[] = [
  { key: "occurredAt", header: "Occurred", render: valueCell("occurredAt") },
  { key: "type", header: "Type", render: statusCell("type") },
  { key: "actor", header: "Actor", render: statusCell("actor") },
  { key: "handleKind", header: "Handle", render: statusCell("handleKind") },
  { key: "eventId", header: "Event", render: (row) => compactValue(row.eventId ?? row.id) },
  { key: "summary", header: "Summary", render: (row) => compactValue(row.summary ?? row.reason ?? row.evidence, 320) },
]

const identityConflictColumns: DataTableColumn<MarketplaceRow>[] = [
  { key: "createdAt", header: "Created", render: valueCell("createdAt") },
  { key: "type", header: "Type", render: statusCell("type") },
  { key: "status", header: "Status", render: statusCell("status") },
  { key: "severity", header: "Severity", render: statusCell("severity") },
  { key: "conflictId", header: "Conflict", render: (row) => compactValue(row.conflictId ?? row.id) },
  { key: "summary", header: "Summary", render: (row) => compactValue(row.summary ?? row.reason ?? row.payloadRedacted, 360) },
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
  { key: "jobId", header: "Job", render: jobLinkCell() },
  { key: "outcome", header: "Outcome", render: valueCell("outcome", 260) },
]

const correctionColumns: DataTableColumn<MarketplaceRow>[] = [
  { key: "createdAt", header: "Created", render: valueCell("createdAt") },
  { key: "targetType", header: "Target", render: statusCell("targetType") },
  { key: "actor", header: "Actor", render: statusCell("actor") },
  { key: "jobId", header: "Job", render: jobLinkCell() },
  { key: "reason", header: "Reason", render: valueCell("reason", 320) },
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function stringArrayField(record: Record<string, unknown>, keys: string[]): string[] {
  return keys.flatMap((key) => normalizeStringList(record[key]))
}

function normalizeStringList(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : []
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (typeof item === "string") return item.trim() ? [item.trim()] : []
    if (!isRecord(item)) return []
    const label =
      stringField(item, "label") ??
      stringField(item, "name") ??
      stringField(item, "value") ??
      stringField(item, "canonical") ??
      stringField(item, "id")
    return label ? [label] : []
  })
}

function skillNames(value: unknown): string[] {
  if (isRecord(value)) return Object.keys(value).filter((key) => Boolean(value[key]))
  return normalizeStringList(value)
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
  }
  return out
}

function formatTagText(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function resumeExperiences(resume: ParsedResume): ExperienceEntry[] {
  const source =
    (Array.isArray(resume.workHistory) && resume.workHistory) ||
    (Array.isArray(resume.experiences) && resume.experiences) ||
    (Array.isArray(resume.candidateProfile?.workHistory) && resume.candidateProfile.workHistory) ||
    (Array.isArray(resume.candidateProfile?.experiences) && resume.candidateProfile.experiences) ||
    []

  return source.filter(isRecord).map((entry) => ({
    title: stringField(entry, "title") ?? stringField(entry, "role"),
    company: stringField(entry, "company"),
    location: stringField(entry, "location"),
    startDate: stringField(entry, "startDate"),
    endDate: stringField(entry, "endDate"),
    currentRole: entry.currentRole === true,
    description: stringField(entry, "description"),
    bullets: normalizeStringList(entry.bullets),
  }))
}
