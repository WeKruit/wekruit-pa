/**
 * Unified job workspace — `/admin/jobs/:jobId`.
 *
 * Single edit surface for a `pa-jobs` doc: company / title / location /
 * salary / ATS URL / descriptionMd / collaboration status / candidate-page
 * status. Drives publish & unpublish via the three lifecycle fields:
 *
 *   publicVisible: boolean
 *   wekruitCollaborationStatus: "collaborated" | "not_collaborated"
 *   candidatePageStatus: "draft" | "ready" | "published"
 *
 * Per the 2026-05-14 product lock these three are the SOURCE OF TRUTH —
 * never inferred from companyId / external-supply status / source.
 */
import { useEffect, useMemo, useState } from "react"
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom"
import { EmptyState, ErrorState, LoadingState, PageHeader, Panel } from "../../components/ui.js"
import { EnrichWithClaire } from "../../components/EnrichWithClaire.js"
import {
  getCompany,
  getJob,
  listCompanies,
  updateJob,
  type CompanyRow as CompanyOptionRow,
  type JobLifecycleUpdate,
  type JobRow,
} from "../../lib/external-supply-client.js"
import { createJob } from "../../lib/job-admin-api.js"
import { suggestJobId } from "../../lib/job-admin-ids.js"

const CANDIDATE_HOST = "https://wekruit.com"

export function JobWorkspace({ createMode = false }: { createMode?: boolean }) {
  if (createMode) return <CreateJobWorkspace />
  return <ExistingJobWorkspace />
}

function CreateJobWorkspace() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const requestedCompanyId = searchParams.get("companyId") ?? ""
  const preferredNext = searchParams.get("next") === "prescreen" ? "prescreen" : "workspace"

  const [companies, setCompanies] = useState<CompanyOptionRow[]>([])
  const [loadingCompanies, setLoadingCompanies] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [jobIdTouched, setJobIdTouched] = useState(false)
  const [form, setForm] = useState({
    companyId: requestedCompanyId,
    title: "",
    jobId: "",
    department: "",
    rawLocation: "",
    atsApplyUrl: "",
    descriptionMd: "",
  })

  useEffect(() => {
    let cancelled = false
    setLoadingCompanies(true)
    setError(null)
    void (async () => {
      try {
        const [rows, requestedCompany] = await Promise.all([
          listCompanies(300),
          requestedCompanyId ? getCompany(requestedCompanyId) : Promise.resolve(null),
        ])
        if (cancelled) return
        const unique = new Map<string, CompanyOptionRow>()
        if (requestedCompany) unique.set(requestedCompany.companyId, requestedCompany)
        for (const row of rows) {
          if (!unique.has(row.companyId)) unique.set(row.companyId, row)
        }
        const nextCompanies = Array.from(unique.values())
        setCompanies(nextCompanies)
        const initialCompanyId =
          requestedCompanyId && nextCompanies.some((row) => row.companyId === requestedCompanyId)
            ? requestedCompanyId
            : nextCompanies[0]?.companyId ?? ""
        setForm((prev) => ({
          ...prev,
          companyId: prev.companyId || initialCompanyId,
          jobId:
            prev.jobId ||
            (initialCompanyId && prev.title ? suggestJobId(initialCompanyId, prev.title) : ""),
        }))
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoadingCompanies(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [requestedCompanyId])

  const selectedCompany = useMemo(
    () => companies.find((row) => row.companyId === form.companyId) ?? null,
    [companies, form.companyId],
  )

  function updateCompanyId(companyId: string) {
    setForm((prev) => ({
      ...prev,
      companyId,
      jobId: jobIdTouched ? prev.jobId : companyId && prev.title ? suggestJobId(companyId, prev.title) : "",
    }))
  }

  function updateTitle(title: string) {
    setForm((prev) => ({
      ...prev,
      title,
      jobId: jobIdTouched ? prev.jobId : prev.companyId && title ? suggestJobId(prev.companyId, title) : "",
    }))
  }

  async function submit(target: "workspace" | "prescreen") {
    setSaving(true)
    setError(null)
    try {
      const created = await createJob({
        ...form,
        companyName: selectedCompany?.displayName ?? selectedCompany?.name ?? form.companyId,
      })
      navigate(
        target === "prescreen"
          ? `/admin/jobs/${encodeURIComponent(created.jobId)}/prescreen`
          : `/admin/jobs/${encodeURIComponent(created.jobId)}`,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  if (loadingCompanies) return <LoadingState label="Loading companies…" />

  if (!loadingCompanies && companies.length === 0) {
    return (
      <div className="page-stack">
        <PageHeader
          eyebrow="Admin / Jobs"
          title="Create job"
          description="Create the company first, then add a job under it."
        />
        <Panel>
          <EmptyState
            title="No companies available"
            body="Create a company in the directory first so the new job can stay linked to company management, sourcing, and prescreen."
            action={<Link to="/admin/companies?create=1">Create company</Link>}
          />
        </Panel>
      </div>
    )
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Admin / Jobs"
        title="Create job"
        description="Create a new pa-jobs doc tied to an existing company. New jobs start private + draft, then publish from the job workspace."
        actions={
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {form.companyId ? (
              <Link
                to={`/admin/external-supply/jobs/${encodeURIComponent(form.companyId)}`}
                style={secondaryBtnStyle}
              >
                Back to company jobs
              </Link>
            ) : null}
            <Link to="/admin/companies?create=1" style={secondaryBtnStyle}>
              Create company
            </Link>
          </div>
        }
      />

      <Panel title="Job identity" eyebrow="company-scoped create flow">
        <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 760 }}>
          <Field label="Company">
            <select
              value={form.companyId}
              onChange={(e) => updateCompanyId(e.target.value)}
              style={selectStyle}
            >
              <option value="">Select a company…</option>
              {companies.map((row) => (
                <option key={row.companyId} value={row.companyId}>
                  {(row.displayName ?? row.name ?? row.companyId) + ` (${row.companyId})`}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Title">
            <input
              type="text"
              value={form.title}
              onChange={(e) => updateTitle(e.target.value)}
              placeholder="Senior Frontend Engineer"
              style={inputStyle}
            />
          </Field>
          <Field label="Job ID">
            <input
              type="text"
              value={form.jobId}
              onChange={(e) => {
                setJobIdTouched(true)
                setForm((prev) => ({ ...prev, jobId: e.target.value }))
              }}
              placeholder="rain-senior-frontend-engineer-abc12345"
              style={{ ...inputStyle, fontFamily: "monospace" }}
            />
          </Field>
          {selectedCompany ? (
            <div style={{ fontSize: "0.8em", color: "#475569" }}>
              New job will be linked to <strong>{selectedCompany.displayName ?? selectedCompany.name ?? selectedCompany.companyId}</strong>.
            </div>
          ) : null}
        </div>
      </Panel>

      <Panel title="Optional fields" eyebrow="seed the workspace and prescreen with useful defaults">
        <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 760 }}>
          <Field label="Department">
            <input
              type="text"
              value={form.department}
              onChange={(e) => setForm((prev) => ({ ...prev, department: e.target.value }))}
              style={inputStyle}
            />
          </Field>
          <Field label="Location (free text)">
            <input
              type="text"
              value={form.rawLocation}
              onChange={(e) => setForm((prev) => ({ ...prev, rawLocation: e.target.value }))}
              placeholder="San Francisco, CA / Remote"
              style={inputStyle}
            />
          </Field>
          <Field label="ATS / JD URL">
            <input
              type="url"
              value={form.atsApplyUrl}
              onChange={(e) => setForm((prev) => ({ ...prev, atsApplyUrl: e.target.value }))}
              style={inputStyle}
            />
          </Field>
          <Field label="Description (markdown)">
            <textarea
              value={form.descriptionMd}
              onChange={(e) => setForm((prev) => ({ ...prev, descriptionMd: e.target.value }))}
              rows={10}
              style={{ ...inputStyle, fontFamily: "monospace", fontSize: "0.85em" }}
            />
          </Field>
          <EnrichWithClaire
            title={form.title}
            descriptionMd={form.descriptionMd}
            companyName={selectedCompany?.displayName ?? selectedCompany?.name ?? form.companyId}
            locationRaw={form.rawLocation}
          />
          {error ? <ErrorState message={error} /> : null}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              disabled={saving}
              onClick={() => void submit(preferredNext)}
              style={primaryBtnStyle}
            >
              {saving
                ? "Creating…"
                : preferredNext === "prescreen"
                  ? "Create job and open prescreen"
                  : "Create job and open workspace"}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => void submit(preferredNext === "prescreen" ? "workspace" : "prescreen")}
              style={secondaryBtnStyle}
            >
              {preferredNext === "prescreen" ? "Create and open workspace" : "Create and open prescreen"}
            </button>
          </div>
        </div>
      </Panel>
    </div>
  )
}

function ExistingJobWorkspace() {
  const { jobId = "" } = useParams<{ jobId: string }>()
  const [job, setJob] = useState<JobRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)

  // Local form state — committed to Firestore via Save / Publish buttons.
  const [form, setForm] = useState<JobLifecycleUpdate>({})

  useEffect(() => {
    if (!jobId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    getJob(jobId)
      .then((j) => {
        if (cancelled) return
        setJob(j)
        if (j) {
          setForm({
            title: j.title ?? "",
            descriptionMd: j.descriptionMd ?? "",
            atsApplyUrl: j.atsApplyUrl ?? "",
            rawLocation: j.rawLocation ?? "",
            publicVisible: j.publicVisible ?? false,
            wekruitCollaborationStatus: j.wekruitCollaborationStatus ?? "not_collaborated",
            candidatePageStatus: j.candidatePageStatus ?? "draft",
          })
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [jobId])

  const candidateUrl = useMemo(() => `${CANDIDATE_HOST}/j/${jobId}`, [jobId])

  async function save(extra: JobLifecycleUpdate = {}) {
    setSaving(true)
    setError(null)
    try {
      const payload: JobLifecycleUpdate = { ...form, ...extra }
      await updateJob(jobId, payload)
      setSavedAt(new Date().toISOString())
      // Re-read to confirm.
      const fresh = await getJob(jobId)
      if (fresh) {
        setJob(fresh)
        setForm({
          title: fresh.title ?? "",
          descriptionMd: fresh.descriptionMd ?? "",
          atsApplyUrl: fresh.atsApplyUrl ?? "",
          rawLocation: fresh.rawLocation ?? "",
          publicVisible: fresh.publicVisible ?? false,
          wekruitCollaborationStatus: fresh.wekruitCollaborationStatus ?? "not_collaborated",
          candidatePageStatus: fresh.candidatePageStatus ?? "draft",
        })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  if (!jobId) return <ErrorState message="Missing jobId param." />
  if (loading) return <LoadingState label="Loading job…" />
  if (error && !job) return <ErrorState message={error} />
  if (!job) return <ErrorState message={`Job "${jobId}" not found.`} />

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Admin / Jobs"
        title={form.title || job.title || jobId}
        description={`pa-jobs/${jobId}`}
        actions={
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <a href={candidateUrl} target="_blank" rel="noreferrer" style={secondaryBtnStyle}>
              Preview candidate page →
            </a>
            <Link
              to={`/admin/external-supply/batches/new?companyId=${encodeURIComponent(job.companyId ?? "")}&jobId=${encodeURIComponent(jobId)}`}
              style={secondaryBtnStyle}
            >
              Source candidates
            </Link>
            <Link
              to={`/admin/passed-candidates?jobId=${encodeURIComponent(jobId)}`}
              style={secondaryBtnStyle}
            >
              Passed candidates
            </Link>
          </div>
        }
      />

      <Panel title="Lifecycle" eyebrow="three locked fields — drive everything downstream">
        <div style={lifecycleGrid}>
          <Field label="Candidate page status">
            <select
              value={form.candidatePageStatus ?? "draft"}
              onChange={(e) =>
                setForm({ ...form, candidatePageStatus: e.target.value as JobLifecycleUpdate["candidatePageStatus"] })
              }
              style={selectStyle}
            >
              <option value="draft">Draft (admin only)</option>
              <option value="ready">Ready (review pending)</option>
              <option value="published">Published (live)</option>
            </select>
          </Field>
          <Field label="Public visibility (wekruit.com)">
            <select
              value={form.publicVisible ? "true" : "false"}
              onChange={(e) => setForm({ ...form, publicVisible: e.target.value === "true" })}
              style={selectStyle}
            >
              <option value="false">Private — admin only</option>
              <option value="true">Public — listed on candidate site</option>
            </select>
          </Field>
          <Field label="WeKruit collaboration status">
            <select
              value={form.wekruitCollaborationStatus ?? "not_collaborated"}
              onChange={(e) =>
                setForm({
                  ...form,
                  wekruitCollaborationStatus: e.target.value as JobLifecycleUpdate["wekruitCollaborationStatus"],
                })
              }
              style={selectStyle}
            >
              <option value="not_collaborated">Not collaborated</option>
              <option value="collaborated">Collaborated (badge shown)</option>
            </select>
          </Field>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button
            type="button"
            disabled={saving}
            onClick={() =>
              save({
                publicVisible: true,
                candidatePageStatus: "published",
              })
            }
            style={primaryBtnStyle}
          >
            {saving ? "…" : "Publish"}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() =>
              save({
                publicVisible: false,
                candidatePageStatus: "draft",
              })
            }
            style={secondaryBtnStyle}
          >
            Unpublish
          </button>
          <button type="button" disabled={saving} onClick={() => save()} style={secondaryBtnStyle}>
            Save lifecycle
          </button>
          {savedAt ? (
            <span style={{ fontSize: "0.75em", color: "#16a34a", alignSelf: "center" }}>
              Saved {new Date(savedAt).toLocaleTimeString()}
            </span>
          ) : null}
        </div>
        {error ? <ErrorState message={error} /> : null}
      </Panel>

      <Panel title="Candidate pipeline" eyebrow="job-scoped evidence">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <Link to={`/admin/passed-candidates?jobId=${encodeURIComponent(jobId)}`} target="_blank" rel="noopener noreferrer" style={secondaryBtnStyle}>
            View passed prescreen snapshots
          </Link>
          <Link to={`/admin/match-debug?jobId=${encodeURIComponent(jobId)}`} target="_blank" rel="noopener noreferrer" style={secondaryBtnStyle}>
            Run job-to-candidates match debug
          </Link>
          <Link to={`/admin/jobs/${encodeURIComponent(jobId)}/prescreen`} target="_blank" rel="noopener noreferrer" style={secondaryBtnStyle}>
            Edit Claire prescreen
          </Link>
        </div>
      </Panel>

      <Panel title="Job fields" eyebrow="content shown on candidate page + matching">
        <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 760 }}>
          <Field label="Title">
            <input
              type="text"
              value={form.title ?? ""}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              style={inputStyle}
            />
          </Field>
          <Field label="Location (free text)">
            <input
              type="text"
              value={form.rawLocation ?? ""}
              onChange={(e) => setForm({ ...form, rawLocation: e.target.value })}
              style={inputStyle}
            />
          </Field>
          <Field label="ATS / JD URL">
            <input
              type="url"
              value={form.atsApplyUrl ?? ""}
              onChange={(e) => setForm({ ...form, atsApplyUrl: e.target.value })}
              style={inputStyle}
            />
          </Field>
          <Field label="Description (markdown)">
            <textarea
              value={form.descriptionMd ?? ""}
              onChange={(e) => setForm({ ...form, descriptionMd: e.target.value })}
              rows={10}
              style={{ ...inputStyle, fontFamily: "monospace", fontSize: "0.85em" }}
            />
          </Field>
          <EnrichWithClaire
            title={form.title ?? job.title}
            descriptionMd={form.descriptionMd ?? ""}
            companyName={job.companyId ?? undefined}
            locationRaw={form.rawLocation ?? job.rawLocation ?? undefined}
          />
          <div>
            <button type="button" disabled={saving} onClick={() => save()} style={primaryBtnStyle}>
              {saving ? "Saving…" : "Save fields"}
            </button>
          </div>
        </div>
      </Panel>

      <Panel title="Read-only — derived from matching pipeline" eyebrow="company / role / seniority">
        <dl style={readonlyDl}>
          <dt>companyId</dt>
          <dd>{job.companyId ?? "—"}</dd>
          <dt>department</dt>
          <dd>{job.department ?? "—"}</dd>
          <dt>seniorityLevel</dt>
          <dd>{job.seniorityLevel ?? "—"}</dd>
          <dt>jobType</dt>
          <dd>{job.jobType ?? "—"}</dd>
          <dt>salaryMin / salaryMax</dt>
          <dd>
            {job.salaryMin ?? "—"} / {job.salaryMax ?? "—"}
          </dd>
          <dt>industrySector</dt>
          <dd>{(job.industrySector ?? []).join(", ") || "—"}</dd>
          <dt>roleFunction</dt>
          <dd>{(job.roleFunction ?? []).join(", ") || "—"}</dd>
          <dt>source / firstSeenAt</dt>
          <dd>
            {job.source ?? "—"} / {job.firstSeenAt ?? "—"}
          </dd>
        </dl>
      </Panel>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: "0.78em", fontWeight: 600, color: "#475569" }}>{label}</span>
      {children}
    </label>
  )
}

const inputStyle: React.CSSProperties = {
  padding: "0.45rem 0.7rem",
  border: "1px solid #cbd5e1",
  borderRadius: 4,
  fontSize: "0.9em",
}
const selectStyle: React.CSSProperties = {
  ...inputStyle,
  background: "white",
}
const primaryBtnStyle: React.CSSProperties = {
  background: "#1a73e8",
  color: "white",
  border: "none",
  padding: "0.5rem 1.1rem",
  borderRadius: 4,
  cursor: "pointer",
  fontWeight: 500,
}
const secondaryBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "1px solid #cbd5e1",
  color: "#0f172a",
  padding: "0.45rem 0.9rem",
  borderRadius: 4,
  cursor: "pointer",
  fontWeight: 500,
  textDecoration: "none",
  fontSize: "0.85em",
  display: "inline-block",
}
const lifecycleGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr 1fr",
  gap: 12,
}
const readonlyDl: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "200px 1fr",
  gap: "6px 12px",
  fontSize: "0.85em",
  margin: 0,
}
