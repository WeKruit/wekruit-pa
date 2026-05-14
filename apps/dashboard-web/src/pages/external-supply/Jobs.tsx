/**
 * v2.0 External Supply (post-V2 hotfix 2026-05-14) —
 * `/admin/external-supply/jobs` and `/admin/external-supply/jobs/:companyId`.
 *
 * Operator entry point for **per-job candidate sourcing**:
 *   1. The bare `/jobs` route lists all known companies (from `pa-companies`)
 *      with the count of `pa-jobs` linked to each.
 *   2. Drilling into a company shows that company's open jobs and surfaces a
 *      "Source candidates for this job" action on each row that opens the
 *      drag-drop wizard prefilled with `?companyId=...&jobId=...` so the
 *      preview tier forecast + downstream evaluation pre-bind to the job.
 *
 * Read-only — no Firestore writes from this page. Mirrors V1 ui.tsx primitives.
 */
import { Link, useParams } from "react-router-dom"
import { useEffect, useMemo, useState } from "react"
import {
  Badge,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Panel,
} from "../../components/ui.js"
import {
  listCompanies,
  listJobs,
  listJobsByCompany,
  getCompany,
  type CompanyRow,
  type JobRow,
} from "../../lib/external-supply-client.js"

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
          listCompanies(200),
          listJobs(500),
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
          />
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
                <th style={{ padding: "8px 6px" }}>Company</th>
                <th style={{ padding: "8px 6px" }}>Domain</th>
                <th style={{ padding: "8px 6px" }}>Industry</th>
                <th style={{ padding: "8px 6px", textAlign: "right" }}>Open jobs</th>
                <th style={{ padding: "8px 6px" }}></th>
              </tr>
            </thead>
            <tbody>
              {companies.map((c) => (
                <tr key={c.companyId} style={{ borderBottom: "1px solid #f0f0f0" }}>
                  <td style={{ padding: "8px 6px" }}>
                    <strong>{c.name ?? c.companyId}</strong>
                    <div style={{ fontSize: 12, color: "#666" }}>{c.companyId}</div>
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
                  </td>
                </tr>
              ))}
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
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const [co, js] = await Promise.all([getCompany(companyId), listJobsByCompany(companyId, 500)])
        if (cancelled) return
        setCompany(co)
        setJobs(js)
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
                <th style={{ padding: "8px 6px" }}></th>
              </tr>
            </thead>
            <tbody>
              {sortedJobs.map((j) => (
                <tr key={j.jobId} style={{ borderBottom: "1px solid #f0f0f0" }}>
                  <td style={{ padding: "8px 6px" }}>{j.department ?? "—"}</td>
                  <td style={{ padding: "8px 6px" }}>
                    <strong>{j.title ?? j.jobId}</strong>
                    <div style={{ fontSize: 12, color: "#666" }}>{j.jobId}</div>
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
                    <Link
                      to={`/admin/external-supply/batches/new?companyId=${encodeURIComponent(
                        companyId,
                      )}&jobId=${encodeURIComponent(j.jobId)}`}
                    >
                      Source candidates →
                    </Link>
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
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  )
}
