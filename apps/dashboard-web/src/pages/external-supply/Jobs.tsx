/**
 * v2.0 External Supply (post-V2 hotfix 2026-05-14) —
 * `/admin/external-supply/jobs` and `/admin/external-supply/jobs/:companyId`.
 *
 * Operator entry point for **per-job candidate sourcing**:
 *   1. The bare `/jobs` route lists WeKruit-collab companies (from
 *      `pa-companies`) with the count of collab `pa-jobs` linked to each.
 *   2. Drilling into a company shows that company's open jobs and surfaces a
 *      "Source candidates for this job" action on each row that opens the
 *      drag-drop wizard prefilled with `?companyId=...&jobId=...` so the
 *      preview tier forecast + downstream evaluation pre-bind to the job.
 *
 * Read-only — no Firestore writes from this page. Mirrors V1 ui.tsx primitives.
 */
import { Link, useParams } from "react-router-dom"
import { useEffect, useMemo, useState } from "react"
import { AdminJobLink } from "../../components/AdminEntityLink.js"
import {
  Badge,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Panel,
} from "../../components/ui.js"
import {
  listBatches,
  listCompanies,
  listJobs,
  listJobsByCompany,
  getCompany,
  type CompanyRow,
  type JobRow,
} from "../../lib/external-supply-client.js"
import { deriveJobLifecycleDisplay } from "./Jobs.helpers.js"

export function Jobs() {
  const params = useParams<{ companyId?: string }>()
  if (params.companyId) {
    return <CompanyJobs companyId={params.companyId} />
  }
  return <AllCompanies />
}

function AllCompanies() {
  const [companies, setCompanies] = useState<CompanyRow[]>([])
  const [jobsByCompany, setJobsByCompany] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const [cos, jobs] = await Promise.all([
          listCompanies(200, { collabOnly: true }),
          listJobs(500, { collabOnly: true }),
        ])
        if (cancelled) return
        const counts: Record<string, number> = {}
        for (const j of jobs) {
          if (!j.companyId) continue
          counts[j.companyId] = (counts[j.companyId] ?? 0) + 1
        }
        setCompanies(cos)
        setJobsByCompany(counts)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div>
      <PageHeader
        title="Companies & open jobs"
        description="Pick a company to view its open jobs and source candidates per job."
        actions={
          <Link to="/admin/companies?create=1">Create company</Link>
        }
      />
      <Panel>
        {loading ? (
          <LoadingState label="Loading companies..." />
        ) : error ? (
          <ErrorState message={error} />
        ) : companies.length === 0 ? (
          <EmptyState
            title="No companies yet"
            body="Seed a company doc to pa-companies (see apps/functions/scripts/seed-rain-xyz.ts as a template)."
            action={<Link to="/admin/companies?create=1">Create company</Link>}
          />
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
                <th style={{ padding: "8px 6px" }}>Company</th>
                <th style={{ padding: "8px 6px", textAlign: "center", width: 90 }}>Collab</th>
                <th style={{ padding: "8px 6px" }}>Domain</th>
                <th style={{ padding: "8px 6px" }}>Industry</th>
                <th style={{ padding: "8px 6px", textAlign: "right" }}>Open jobs</th>
                <th style={{ padding: "8px 6px" }}></th>
              </tr>
            </thead>
            <tbody>
              {companies.map((c) => {
                const isCollab = c.wekruitCollab === true
                return (
                  <tr
                    key={c.companyId}
                    style={{
                      borderBottom: "1px solid #f0f0f0",
                      background: isCollab ? "#f0fdf4" : "transparent",
                    }}
                  >
                    <td style={{ padding: "8px 6px" }}>
                      <strong>{c.displayName ?? c.name ?? c.companyId}</strong>
                      <div style={{ fontSize: 12, color: "#666" }}>{c.companyId}</div>
                    </td>
                    <td style={{ padding: "8px 6px", textAlign: "center" }}>
                      {isCollab ? (
                        <Badge tone="ok">✓ Collab</Badge>
                      ) : (
                        <span style={{ color: "#cbd5e1", fontSize: 12 }}>—</span>
                      )}
                    </td>
                    <td style={{ padding: "8px 6px" }}>{c.domain ?? "—"}</td>
                    <td style={{ padding: "8px 6px" }}>
                      {(c.industrySector ?? []).map((s) => (
                        <Badge key={s} tone="info">
                          {s}
                        </Badge>
                      ))}
                    </td>
                    <td style={{ padding: "8px 6px", textAlign: "right" }}>
                      {jobsByCompany[c.companyId] ?? 0}
                    </td>
                    <td style={{ padding: "8px 6px" }}>
                      <Link to={`/admin/external-supply/jobs/${c.companyId}`}>View jobs →</Link>
                      {" · "}
                      <Link to={`/admin/jobs/new?companyId=${encodeURIComponent(c.companyId)}`}>Create job</Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  )
}

function CompanyJobs({ companyId }: { companyId: string }) {
  const [company, setCompany] = useState<CompanyRow | null>(null)
  const [jobs, setJobs] = useState<JobRow[]>([])
  // Map jobId → latest batch summary so we can render "Browse N candidates →"
  // when a job already has a sourced batch, instead of pushing every click to
  // the new-batch wizard.
  const [batchesByJob, setBatchesByJob] = useState<Map<string, { batchId: string; rowCount: number }>>(
    new Map(),
  )
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const [co, js, batchPage] = await Promise.all([
          getCompany(companyId),
          listJobsByCompany(companyId, 500, { collabOnly: true }),
          listBatches({ limit: 200 }),
        ])
        if (cancelled) return
        setCompany(co)
        setJobs(js)
        // Pick the most-recent batch per jobId (listBatches already orders by
        // createdAt desc).
        const byJob = new Map<string, { batchId: string; rowCount: number }>()
        for (const b of batchPage.rows) {
          if (!b.jobId) continue
          if (byJob.has(b.jobId)) continue
          byJob.set(b.jobId, { batchId: b.batchId, rowCount: b.rowCount ?? 0 })
        }
        setBatchesByJob(byJob)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [companyId])

  const sortedJobs = useMemo(
    () =>
      [...jobs].sort((a, b) => (a.department ?? "").localeCompare(b.department ?? "") || (a.title ?? "").localeCompare(b.title ?? "")),
    [jobs],
  )

  return (
    <div>
      <PageHeader
        title={company?.name ?? companyId}
        description={`${jobs.length} job${jobs.length === 1 ? "" : "s"} indexed on pa-jobs · companyId=${companyId}`}
        actions={
          <Link to={`/admin/jobs/new?companyId=${encodeURIComponent(companyId)}`}>Create job</Link>
        }
      />
      <Panel>
        <div style={{ marginBottom: 12 }}>
          <Link to="/admin/external-supply/jobs">← All companies</Link>
        </div>
        {loading ? (
          <LoadingState label="Loading jobs..." />
        ) : error ? (
          <ErrorState message={error} />
        ) : !company ? (
          <ErrorState message={`Company "${companyId}" not found in pa-companies.`} />
        ) : sortedJobs.length === 0 ? (
          <EmptyState
            title="No jobs yet"
            body="Seed jobs to pa-jobs with companyId pointing to this company."
            action={
              <Link to={`/admin/jobs/new?companyId=${encodeURIComponent(companyId)}`}>
                Create the first job
              </Link>
            }
          />
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
                <th style={{ padding: "8px 6px" }}>Department</th>
                <th style={{ padding: "8px 6px" }}>Title</th>
                <th style={{ padding: "8px 6px" }}>Location</th>
                <th style={{ padding: "8px 6px" }}>Seniority</th>
                <th style={{ padding: "8px 6px" }}>Salary</th>
                <th style={{ padding: "8px 6px" }}>Candidate page</th>
                <th style={{ padding: "8px 6px" }}></th>
              </tr>
            </thead>
            <tbody>
              {sortedJobs.map((j) => {
                const lifecycle = deriveJobLifecycleDisplay(j)
                return (
                  <tr key={j.jobId} style={{ borderBottom: "1px solid #f0f0f0" }}>
                    <td style={{ padding: "8px 6px" }}>{j.department ?? "—"}</td>
                    <td style={{ padding: "8px 6px" }}>
                      <AdminJobLink jobId={j.jobId}>
                        <strong>{j.title ?? j.jobId}</strong>
                      </AdminJobLink>
                      <div style={{ fontSize: 12, color: "#666" }}>
                        <AdminJobLink jobId={j.jobId}>{j.jobId}</AdminJobLink>
                      </div>
                      <div style={{ fontSize: 11, marginTop: 2, display: "flex", gap: 4 }}>
                        <span style={pageToneStyle(lifecycle.pageTone)}>
                          {lifecycle.pageLabel}
                        </span>
                        {lifecycle.collaborationLabel ? (
                          <span style={{ background: "#dbeafe", color: "#1e3a8a", padding: "0 6px", borderRadius: 3, fontWeight: 600 }}>
                            collab
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td style={{ padding: "8px 6px" }}>
                      {j.rawLocation ?? ((j.locationBuckets ?? []).join(", ") || "—")}
                    </td>
                    <td style={{ padding: "8px 6px" }}>{j.seniorityLevel ?? "—"}</td>
                    <td style={{ padding: "8px 6px" }}>
                      {j.salaryMin && j.salaryMax
                        ? `$${Math.round(j.salaryMin / 1000)}K – $${Math.round(j.salaryMax / 1000)}K`
                        : "—"}
                    </td>
                    <td style={{ padding: "8px 6px", whiteSpace: "nowrap" }}>
                      {lifecycle.candidateHref ? (
                        <a href={lifecycle.candidateHref} target="_blank" rel="noopener noreferrer">
                          Open candidate page →
                        </a>
                      ) : (
                        <AdminJobLink jobId={j.jobId}>Publish in job workspace</AdminJobLink>
                      )}
                    </td>
                    <td style={{ padding: "8px 6px", whiteSpace: "nowrap" }}>
                      {(() => {
                      const existing = batchesByJob.get(j.jobId)
                      if (existing) {
                        return (
                          <>
                            <Link
                              to={`/admin/external-supply/batches/${encodeURIComponent(
                                existing.batchId,
                              )}/candidates`}
                            >
                              Browse {existing.rowCount} candidates →
                            </Link>
                            {" · "}
                            <Link
                              to={`/admin/external-supply/batches/new?companyId=${encodeURIComponent(
                                companyId,
                              )}&jobId=${encodeURIComponent(j.jobId)}`}
                              style={{ color: "#64748b" }}
                            >
                              +upload more
                            </Link>
                          </>
                        )
                      }
                      return (
                        <Link
                          to={`/admin/external-supply/batches/new?companyId=${encodeURIComponent(
                            companyId,
                          )}&jobId=${encodeURIComponent(j.jobId)}`}
                        >
                          Source candidates →
                        </Link>
                      )
                      })()}
                      {j.atsApplyUrl ? (
                        <>
                          {" · "}
                          <a href={j.atsApplyUrl} target="_blank" rel="noopener noreferrer">
                            JD
                          </a>
                        </>
                      ) : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  )
}

function pageToneStyle(tone: "public" | "review" | "draft") {
  if (tone === "public") {
    return { background: "#dcfce7", color: "#166534", padding: "0 6px", borderRadius: 3, fontWeight: 600 }
  }
  if (tone === "review") {
    return { background: "#e0f2fe", color: "#075985", padding: "0 6px", borderRadius: 3, fontWeight: 600 }
  }
  return { background: "#fef3c7", color: "#92400e", padding: "0 6px", borderRadius: 3, fontWeight: 600 }
}
