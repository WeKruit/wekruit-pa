import { useEffect, useMemo, useState, type ReactNode } from "react"
import { collectionGroup, limit, onSnapshot, orderBy, query } from "firebase/firestore"
import { httpsCallable } from "firebase/functions"
import { CheckCircle, RefreshCw, Save, XCircle } from "lucide-react"
import { AdminJobLink } from "../components/AdminEntityLink.js"
import { Badge, EmptyState, ErrorState, LoadingState, PageHeader, Panel } from "../components/ui.js"
import { db, functions } from "../lib/firebase.js"
import {
  compactValue,
  displaySponsorship,
  enrichmentStatusTone,
  formatPercent,
  formatScore,
  formatTime,
  listify,
  sortByUpdatedAt,
  timestampToIso,
  type StatusTone,
} from "./JobEnrichmentReview.helpers.js"

type EnrichmentStatus = "draft" | "needs_review" | "approved" | "rejected" | string

type JobEnrichmentDraft = {
  id: string
  draftId: string
  jobId: string
  status?: EnrichmentStatus
  approvalReady?: boolean
  rawJob?: Record<string, unknown> | null
  enrichedTags?: unknown
  hardFilters?: Record<string, unknown> | null
  softScoringWeights?: Record<string, unknown> | null
  prescreenConfigDraft?: unknown
  scoringRubric?: unknown
  candidateBrief?: unknown
  evalFixtureSummary?: unknown
  evalFixtures?: unknown
  confidence?: number
  hitlFlags?: unknown
  coverage?: number | string | null
  updatedAt?: string | null
  createdAt?: string | null
}

type ActionKey = "refresh" | "save" | "approve" | "reject"

type RefreshInput = { jobId: string; draftId?: string }
type ApproveInput = { jobId: string; draftId: string }
type RejectInput = { jobId: string; draftId: string; reason: string }
type SaveCorrectionsInput = { jobId: string; draftId: string; corrections: string }

const STATUS_OPTIONS = ["all", "draft", "needs_review", "approved", "rejected"] as const
const iconStyle = { width: 15, height: 15, verticalAlign: "-2px", marginRight: 6 }

export function JobEnrichmentReview() {
  const [drafts, setDrafts] = useState<JobEnrichmentDraft[]>([])
  const [selectedId, setSelectedId] = useState("")
  const [queryText, setQueryText] = useState("")
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_OPTIONS)[number]>("all")
  const [corrections, setCorrections] = useState("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<ActionKey | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    const draftsQuery = query(collectionGroup(db(), "enrichment"), orderBy("updatedAt", "desc"), limit(100))
    return onSnapshot(
      draftsQuery,
      (snap) => {
        const rows = snap.docs.map((docSnap) => normalizeDraft(docSnap.id, docSnap.data(), docSnap.ref.parent.parent?.id))
        setDrafts(sortByUpdatedAt(rows))
        setLoading(false)
      },
      (e) => {
        setError(e.message)
        setLoading(false)
      }
    )
  }, [])

  const visibleDrafts = useMemo(() => {
    const needle = queryText.trim().toLowerCase()
    return drafts.filter((draft) => {
      if (statusFilter !== "all" && String(draft.status ?? "").toLowerCase() !== statusFilter) return false
      if (!needle) return true
      return draftSearchText(draft).includes(needle)
    })
  }, [drafts, queryText, statusFilter])

  useEffect(() => {
    if (visibleDrafts.length === 0) {
      setSelectedId("")
      return
    }
    if (!selectedId || !visibleDrafts.some((draft) => draft.id === selectedId)) {
      setSelectedId(visibleDrafts[0]!.id)
    }
  }, [selectedId, visibleDrafts])

  const selectedDraft = useMemo(
    () => visibleDrafts.find((draft) => draft.id === selectedId) ?? null,
    [selectedId, visibleDrafts]
  )

  async function refreshDraft(): Promise<void> {
    if (!selectedDraft) return
    setBusy("refresh")
    setNotice(null)
    setError(null)
    try {
      const fn = httpsCallable<RefreshInput, { ok: boolean }>(functions(), "paJobEnrichmentRefreshDraft")
      await fn({ jobId: selectedDraft.jobId, draftId: selectedDraft.draftId })
      setNotice("Refresh queued")
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  async function saveCorrections(): Promise<void> {
    if (!selectedDraft || !corrections.trim()) return
    setBusy("save")
    setNotice(null)
    setError(null)
    try {
      const fn = httpsCallable<SaveCorrectionsInput, { ok: boolean }>(functions(), "paJobEnrichmentSaveCorrections")
      await fn({
        jobId: selectedDraft.jobId,
        draftId: selectedDraft.draftId,
        corrections: corrections.trim(),
      })
      setCorrections("")
      setNotice("Corrections saved")
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  async function approveDraft(): Promise<void> {
    if (!selectedDraft || !selectedDraft.approvalReady) return
    setBusy("approve")
    setNotice(null)
    setError(null)
    try {
      const fn = httpsCallable<ApproveInput, { ok: boolean }>(functions(), "paJobEnrichmentApproveDraft")
      await fn({ jobId: selectedDraft.jobId, draftId: selectedDraft.draftId })
      setNotice("Draft approved")
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  async function rejectDraft(): Promise<void> {
    const reason = corrections.trim()
    if (!selectedDraft || !reason) return
    setBusy("reject")
    setNotice(null)
    setError(null)
    try {
      const fn = httpsCallable<RejectInput, { ok: boolean }>(functions(), "paJobEnrichmentRejectDraft")
      await fn({ jobId: selectedDraft.jobId, draftId: selectedDraft.draftId, reason })
      setCorrections("")
      setNotice("Draft rejected")
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  if (loading) return <LoadingState label="Loading job enrichment drafts..." />

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="S4 / Admin"
        title="Job Enrichment Review"
        description="Review generated job enrichment drafts before tags, hard filters, scoring, and Claire prescreen config become approved marketplace inputs."
        actions={
          <button type="button" onClick={() => void refreshDraft()} disabled={busy !== null || !selectedDraft}>
            <RefreshCw style={iconStyle} />
            {busy === "refresh" ? "Refreshing..." : "Refresh draft"}
          </button>
        }
      />

      {error ? <ErrorState message={error} /> : null}
      {notice ? <div className="notice notice-good">{notice}</div> : null}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(19rem, 0.36fr) minmax(0, 1fr)", gap: "1rem" }}>
        <Panel title={`${visibleDrafts.length} draft(s)`} eyebrow="pa-jobs/*/enrichment">
          <div className="toolbar" style={{ marginBottom: "0.75rem" }}>
            <input
              value={queryText}
              onChange={(e) => setQueryText(e.target.value)}
              placeholder="Filter job, company, jobId"
              style={{ minWidth: "13rem" }}
            />
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}>
              {STATUS_OPTIONS.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </div>
          <DraftList drafts={visibleDrafts} selectedId={selectedId} onSelect={setSelectedId} />
        </Panel>

        {selectedDraft ? (
          <div className="page-stack">
            <Panel
              title={jobTitle(selectedDraft)}
              eyebrow={`${companyName(selectedDraft)} · ${selectedDraft.jobId}`}
              actions={
                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", justifyContent: "flex-end" }}>
                    <AdminJobLink jobId={selectedDraft.jobId}>Open job</AdminJobLink>
	                  <button
	                    type="button"
	                    onClick={() => void saveCorrections()}
	                    disabled={busy !== null || !corrections.trim()}
	                  >
	                    <Save style={iconStyle} />
	                    {busy === "save" ? "Saving..." : "Save corrections"}
	                  </button>
	                  <button
	                    type="button"
	                    className="danger-button"
	                    onClick={() => void rejectDraft()}
	                    disabled={busy !== null || !corrections.trim()}
	                  >
	                    <XCircle style={iconStyle} />
	                    {busy === "reject" ? "Rejecting..." : "Reject draft"}
	                  </button>
	                  <button
	                    type="button"
	                    onClick={() => void approveDraft()}
	                    disabled={busy !== null || !selectedDraft.approvalReady}
                  >
                    <CheckCircle style={iconStyle} />
                    {busy === "approve" ? "Approving..." : "Approve draft"}
                  </button>
                </div>
              }
            >
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.45rem", marginBottom: "0.75rem" }}>
                <Badge tone={enrichmentStatusTone(selectedDraft.status)}>{selectedDraft.status ?? "unknown"}</Badge>
                <Badge tone={selectedDraft.approvalReady ? "ok" : "warn"}>
                  {selectedDraft.approvalReady ? "approval ready" : "draft only"}
                </Badge>
                <Badge tone={confidenceTone(selectedDraft.confidence)}>
                  confidence {formatPercent(selectedDraft.confidence)}
                </Badge>
                <Badge tone={coverageTone(selectedDraft.coverage)}>coverage {formatCoverage(selectedDraft.coverage)}</Badge>
                <Badge tone={hitlFlagCount(selectedDraft.hitlFlags) > 0 ? "warn" : "ok"}>
                  HITL {hitlFlagCount(selectedDraft.hitlFlags)}
                </Badge>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "0.5rem" }}>
                <MetaRow label="draftId" value={selectedDraft.draftId} />
                <MetaRow label="updated" value={formatTime(selectedDraft.updatedAt)} />
                <MetaRow label="location" value={compactValue(pickRaw(selectedDraft, ["location", "jobLocation", "workplace"]))} />
                <MetaRow label="source" value={compactValue(pickRaw(selectedDraft, ["source", "sourceRepo", "atsSource"]))} />
              </div>
            </Panel>

            <div className="split-grid">
              <Panel title="Extracted tags" eyebrow="canonical vocab candidate">
                <KeyValueBlock value={selectedDraft.enrichedTags} />
              </Panel>
              <Panel title="Hard filters" eyebrow="must not infer unknown as false">
                <HardFiltersBlock draft={selectedDraft} />
              </Panel>
            </div>

            <div className="split-grid">
              <Panel title="Soft signals" eyebrow="match weights">
                <KeyValueBlock value={selectedDraft.softScoringWeights} />
              </Panel>
              <Panel title="HITL flags" eyebrow="review triggers">
                <ListBlock value={selectedDraft.hitlFlags} empty="No HITL flags" />
              </Panel>
            </div>

            <Panel title="Questions" eyebrow="prescreenConfigDraft remains draft until approved">
              <PrescreenBlock value={selectedDraft.prescreenConfigDraft} />
            </Panel>

            <div className="split-grid">
              <Panel title="Scoring rubric" eyebrow="generated evaluator draft">
                <KeyValueBlock value={selectedDraft.scoringRubric} />
              </Panel>
              <Panel title="Claire brief" eyebrow="candidate-facing summary draft">
                <TextBlock value={selectedDraft.candidateBrief} />
              </Panel>
            </div>

            <Panel title="Eval fixtures" eyebrow="fixture summary + examples">
              <EvalFixturesBlock summary={selectedDraft.evalFixtureSummary} fixtures={selectedDraft.evalFixtures} />
            </Panel>

            <Panel title="Corrections" eyebrow="saved through paJobEnrichmentSaveCorrections">
              <textarea
                value={corrections}
                onChange={(e) => setCorrections(e.target.value)}
                placeholder="Operator corrections for the enrichment draft"
                rows={5}
                style={{ width: "100%", resize: "vertical" }}
                disabled={busy !== null}
              />
            </Panel>
          </div>
        ) : (
          <Panel title="Select a draft">
            <EmptyState title="No draft selected" body="No enrichment draft matches the current filters." />
          </Panel>
        )}
      </div>
    </div>
  )
}

export default JobEnrichmentReview

function DraftList({
  drafts,
  selectedId,
  onSelect,
}: {
  drafts: JobEnrichmentDraft[]
  selectedId: string
  onSelect: (id: string) => void
}) {
  if (drafts.length === 0) {
    return <EmptyState title="No drafts" body="No job enrichment drafts match the current filters." />
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.45rem" }}>
      {drafts.map((draft) => (
        <button
          key={draft.id}
          type="button"
          onClick={() => onSelect(draft.id)}
          style={{
            textAlign: "left",
            border: selectedId === draft.id ? "1px solid #1a73e8" : "1px solid #e2e8f0",
            background: selectedId === draft.id ? "#eff6ff" : "#fff",
            borderRadius: "0.375rem",
            padding: "0.65rem",
            cursor: "pointer",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem", alignItems: "center" }}>
            <strong style={{ overflowWrap: "anywhere" }}>{jobTitle(draft)}</strong>
            <Badge tone={enrichmentStatusTone(draft.status)}>{draft.status ?? "unknown"}</Badge>
          </div>
          <div className="muted-copy" style={{ marginTop: "0.25rem", overflowWrap: "anywhere" }}>
            {companyName(draft)} · <AdminJobLink jobId={draft.jobId}>{draft.jobId}</AdminJobLink>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem", marginTop: "0.45rem" }}>
            <Badge tone={draft.approvalReady ? "ok" : "info"}>{draft.approvalReady ? "ready" : "draft"}</Badge>
            <Badge tone={confidenceTone(draft.confidence)}>{formatPercent(draft.confidence)}</Badge>
            <Badge tone={hitlFlagCount(draft.hitlFlags) > 0 ? "warn" : "muted"}>HITL {hitlFlagCount(draft.hitlFlags)}</Badge>
          </div>
          <div className="muted-copy" style={{ marginTop: "0.35rem" }}>
            {formatTime(draft.updatedAt)}
          </div>
        </button>
      ))}
    </div>
  )
}

function HardFiltersBlock({ draft }: { draft: JobEnrichmentDraft }) {
  const sponsorship = displaySponsorship(
    draft.hardFilters?.sponsorshipAvailable ??
      draft.hardFilters?.sponsorship ??
      pickRaw(draft, ["sponsorship", "visaSponsorship"])
  )
  const rows = [
    { label: "sponsorship", value: sponsorship.label, tone: sponsorship.tone },
    { label: "location", value: compactValue(draft.hardFilters?.location ?? draft.hardFilters?.locations) },
    { label: "jobType", value: compactValue(draft.hardFilters?.jobType ?? draft.hardFilters?.jobTypes) },
    { label: "careerStage", value: compactValue(draft.hardFilters?.careerStage ?? draft.hardFilters?.seniority) },
    {
      label: "salary",
      value: compactValue(
        draft.hardFilters?.salary ??
          draft.hardFilters?.salaryRange ??
          salaryRangeText(draft.hardFilters?.salaryMinUsd, draft.hardFilters?.salaryMaxUsd)
      ),
    },
  ]
  const extra = Object.entries(draft.hardFilters ?? {}).filter(
    ([key]) =>
      ![
        "sponsorshipAvailable",
        "sponsorship",
        "location",
        "locations",
        "jobType",
        "jobTypes",
        "careerStage",
        "seniority",
        "salary",
        "salaryRange",
        "salaryMinUsd",
        "salaryMaxUsd",
      ].includes(key)
  )
  return (
    <div style={{ display: "grid", gap: "0.4rem" }}>
      {rows.map((row) => (
        <MetaRow
          key={row.label}
          label={row.label}
          value={row.value}
          badge={row.tone ? <Badge tone={row.tone}>{row.value}</Badge> : undefined}
        />
      ))}
      {extra.map(([key, value]) => (
        <MetaRow key={key} label={key} value={compactValue(value)} />
      ))}
    </div>
  )
}

function PrescreenBlock({ value }: { value: unknown }) {
  const questions = extractQuestions(value)
  if (questions.length === 0) return <KeyValueBlock value={value} />
  return (
    <div className="table-shell">
      <table>
        <thead>
          <tr>
            <th>Question</th>
            <th>Signal</th>
            <th>Scoring</th>
          </tr>
        </thead>
        <tbody>
          {questions.map((question, index) => (
            <tr key={`${question.id}:${index}`}>
              <td>
                <strong>{question.label}</strong>
                <div className="muted-copy" style={{ marginTop: "0.2rem", overflowWrap: "anywhere" }}>
                  {question.prompt}
                </div>
              </td>
              <td>{question.signal}</td>
              <td>{question.scoring}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function EvalFixturesBlock({ summary, fixtures }: { summary: unknown; fixtures: unknown }) {
  return (
    <div style={{ display: "grid", gap: "0.75rem" }}>
      <KeyValueBlock value={summary} empty="No eval fixture summary" />
      <ListBlock value={fixtures} empty="No eval fixtures" />
    </div>
  )
}

function KeyValueBlock({ value, empty = "No data" }: { value: unknown; empty?: string }) {
  if (value === undefined || value === null || value === "") {
    return <EmptyState title={empty} body="This draft has not produced this section yet." />
  }
  if (typeof value !== "object" || Array.isArray(value)) return <TextBlock value={value} />
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return <EmptyState title={empty} body="This draft has not produced this section yet." />
  return (
    <div style={{ display: "grid", gap: "0.4rem" }}>
      {entries.map(([key, entry]) => (
        <MetaRow key={key} label={key} value={compactValue(entry, 520)} />
      ))}
    </div>
  )
}

function ListBlock({ value, empty }: { value: unknown; empty: string }) {
  const items = listify(value)
  if (items.length === 0) return <EmptyState title={empty} body="Nothing has been recorded for this draft." />
  return (
    <ul style={{ margin: 0, paddingLeft: "1.1rem", display: "grid", gap: "0.35rem" }}>
      {items.map((item, index) => (
        <li key={`${item}:${index}`} style={{ overflowWrap: "anywhere" }}>
          {item}
        </li>
      ))}
    </ul>
  )
}

function TextBlock({ value }: { value: unknown }) {
  return (
    <pre
      style={{
        background: "#f8fafc",
        borderRadius: "0.375rem",
        margin: 0,
        maxHeight: "24rem",
        overflow: "auto",
        padding: "0.75rem",
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
      }}
    >
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  )
}

function MetaRow({ label, value, badge }: { label: string; value: string; badge?: ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "8rem minmax(0, 1fr)", gap: "0.5rem", alignItems: "baseline" }}>
      <span className="muted-copy">{label}</span>
      <span style={{ overflowWrap: "anywhere" }}>{badge ?? value}</span>
    </div>
  )
}

function normalizeDraft(id: string, data: Record<string, unknown>, parentJobId: string | undefined): JobEnrichmentDraft {
  const rawSnapshot = isRecord(data.rawSnapshot) ? data.rawSnapshot : null
  const opportunity = isRecord(data.opportunity) ? data.opportunity : null
  const rawJob = isRecord(data.rawJob) ? data.rawJob : rawSnapshot
  const jobId = stringOrUndefined(data.jobId) ?? parentJobId ?? stringOrUndefined(rawJob?.jobId) ?? "unknown-job"
  const draftId = stringOrUndefined(data.draftId) ?? id
  const coverage = isRecord(data.coverage)
    ? stringOrUndefined(data.coverage.overall)
    : numberOrUndefined(data.coverage)
  return {
    id: `${jobId}:${draftId}`,
    draftId,
    jobId,
    status: stringOrUndefined(data.status),
    approvalReady: data.approvalReady === true,
    rawJob,
    enrichedTags: data.enrichedTags ?? pickOpportunityTags(opportunity),
    hardFilters: isRecord(data.hardFilters)
      ? data.hardFilters
      : isRecord(opportunity?.hardFilters)
        ? opportunity.hardFilters
        : null,
    softScoringWeights: isRecord(data.softScoringWeights)
      ? data.softScoringWeights
      : isRecord(opportunity?.softScoringWeights)
        ? opportunity.softScoringWeights
        : null,
    prescreenConfigDraft: data.prescreenConfigDraft ?? opportunity?.prescreen,
    scoringRubric: data.scoringRubric ?? opportunity?.scoringRubric,
    candidateBrief: data.candidateBrief ?? opportunity?.candidateBrief,
    evalFixtureSummary: data.evalFixtureSummary ?? (isRecord(data.evalFixtures) ? data.evalFixtures.summary : undefined),
    evalFixtures: data.evalFixtures,
    confidence: numberOrUndefined(data.confidence),
    coverage,
    hitlFlags: data.hitlFlags,
    updatedAt: timestampToIso(data.updatedAt),
    createdAt: timestampToIso(data.createdAt),
  }
}

function extractQuestions(value: unknown): { id: string; label: string; prompt: string; signal: string; scoring: string }[] {
  const source = isRecord(value) && Array.isArray(value.questions) ? value.questions : Array.isArray(value) ? value : []
  return source.filter(isRecord).map((question, index) => ({
    id: stringOrUndefined(question.id) ?? stringOrUndefined(question.questionId) ?? String(index + 1),
    label: stringOrUndefined(question.id) ?? stringOrUndefined(question.questionId) ?? `Q${index + 1}`,
    prompt: compactValue(question.prompt ?? question.text ?? question.question, 420),
    signal: compactValue(question.signal ?? question.tag ?? question.axis ?? question.expectedSignal, 180),
    scoring: compactValue(question.scoring ?? question.rubric ?? question.acceptanceCriteria ?? question.expectedAnswer, 260),
  }))
}

function draftSearchText(draft: JobEnrichmentDraft): string {
  return [
    draft.jobId,
    draft.draftId,
    draft.status,
    jobTitle(draft),
    companyName(draft),
    compactValue(pickRaw(draft, ["location", "jobLocation", "workplace"])),
  ]
    .join(" ")
    .toLowerCase()
}

function jobTitle(draft: JobEnrichmentDraft): string {
  return compactValue(pickRaw(draft, ["jobTitle", "title", "role", "position"]), 90)
}

function companyName(draft: JobEnrichmentDraft): string {
  return compactValue(pickRaw(draft, ["companyName", "company", "employerName"]), 90)
}

function pickRaw(draft: JobEnrichmentDraft, keys: string[]): unknown {
  for (const key of keys) {
    const value = draft.rawJob?.[key]
    if (value !== undefined && value !== null && value !== "") return value
  }
  return undefined
}

function hitlFlagCount(value: unknown): number {
  if (!value) return 0
  if (Array.isArray(value)) return value.length
  if (typeof value === "object") return Object.keys(value).length
  return 1
}

function confidenceTone(value: number | undefined): StatusTone {
  if (typeof value !== "number" || !Number.isFinite(value)) return "muted"
  if (value >= 0.8) return "ok"
  if (value >= 0.6) return "info"
  return "warn"
}

function coverageTone(value: number | string | null | undefined): StatusTone {
  if (value === "high") return "ok"
  if (value === "medium") return "info"
  if (value === "low") return "warn"
  if (typeof value !== "number" || !Number.isFinite(value)) return "muted"
  if (value >= 0.75) return "ok"
  if (value >= 0.5) return "info"
  return "warn"
}

function formatCoverage(value: number | string | null | undefined): string {
  if (typeof value === "string" && value) return value
  return formatPercent(value)
}

function pickOpportunityTags(opportunity: Record<string, unknown> | null): Record<string, unknown> | undefined {
  if (!opportunity) return undefined
  return {
    roleFunction: opportunity.roleFunction,
    industrySector: opportunity.industrySector,
    skills: opportunity.skills,
    relevantTags: opportunity.relevantTags,
    seniority: opportunity.seniority,
  }
}

function salaryRangeText(min: unknown, max: unknown): string | undefined {
  const minNumber = typeof min === "number" && Number.isFinite(min) ? min : null
  const maxNumber = typeof max === "number" && Number.isFinite(max) ? max : null
  if (minNumber === null && maxNumber === null) return undefined
  if (minNumber !== null && maxNumber !== null) return `$${minNumber} - $${maxNumber}`
  if (minNumber !== null) return `$${minNumber}+`
  return `up to $${maxNumber}`
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
