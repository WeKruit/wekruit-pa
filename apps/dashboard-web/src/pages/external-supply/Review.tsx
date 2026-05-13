/**
 * v2.0 External Supply V1 — Wave D — `/admin/external-supply/review`.
 *
 * Needs-review queue. Surfaces:
 *   - `pa-external-candidate-records?identityResolutionStatus == needs_review`
 *   - `pa-candidate-identity-conflicts` filtered to the kinds added in S2/V2
 *     (`linkedin_email_candidate_mismatch`, `external_fuzzy_match`).
 *
 * V1 V2 wraps decisions in the existing /admin/identity-conflicts surface
 * for now; here we just present + link out so the operator can confirm
 * the scope before opening that conflict resolver. A future iteration will
 * add inline approve/reject actions that write merge_decision_recorded.
 */
import { useEffect, useMemo, useState } from "react"
import { Link } from "react-router-dom"
import type { ExternalCandidateRecord } from "@pa/core-types"
import { EmptyState, ErrorState, LoadingState, PageHeader, Panel } from "../../components/ui.js"
import {
  listIdentityConflicts,
  listNeedsReviewRecords,
  type IdentityConflictKind,
  type IdentityConflictRow,
} from "../../lib/external-supply-client.js"
import { IdentityStatusBadge } from "../../components/external-supply/IdentityStatusBadge.js"
import { RedactedField } from "../../components/external-supply/RedactedField.js"

const KIND_FILTERS: { key: "all" | IdentityConflictKind; label: string }[] = [
  { key: "all", label: "All review items" },
  { key: "linkedin_email_candidate_mismatch", label: "LinkedIn vs. email mismatch" },
  { key: "external_fuzzy_match", label: "External fuzzy match" },
  { key: "pdf_email_employer_email_mismatch", label: "PDF / employer mismatch" },
]

export function Review() {
  const [kindFilter, setKindFilter] = useState<"all" | IdentityConflictKind>("all")
  const [records, setRecords] = useState<ExternalCandidateRecord[]>([])
  const [conflicts, setConflicts] = useState<IdentityConflictRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([
      listNeedsReviewRecords({ limit: 200 }),
      listIdentityConflicts({
        kinds:
          kindFilter === "all"
            ? ["linkedin_email_candidate_mismatch", "external_fuzzy_match", "pdf_email_employer_email_mismatch"]
            : [kindFilter],
        status: "open",
        limit: 200,
      }),
    ])
      .then(([recs, conf]) => {
        if (cancelled) return
        setRecords(recs.rows)
        setConflicts(conf.rows)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [kindFilter])

  const recordsByReason = useMemo(() => {
    const map: Record<string, ExternalCandidateRecord[]> = {}
    for (const r of records) {
      for (const reason of r.reviewReasons ?? ["unspecified"]) {
        map[reason] = map[reason] ?? []
        map[reason].push(r)
      }
    }
    return map
  }, [records])

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="v2.0 External Supply V1 / Admin"
        title="Needs review"
        description="LinkedIn-vs-email conflicts, fuzzy matches, and email-only rows that did not auto-resolve. Confirm-merge or reject in the identity-conflicts queue."
        actions={
          <Link to="/admin/identity-conflicts">
            <button type="button" style={secondaryBtnStyle}>
              Open identity conflicts
            </button>
          </Link>
        }
      />

      <Panel title="Filters" eyebrow="conflict kind">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {KIND_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setKindFilter(f.key)}
              style={f.key === kindFilter ? activeFilterBtn : inactiveFilterBtn}
            >
              {f.label}
            </button>
          ))}
        </div>
      </Panel>

      {error && <ErrorState message={error} />}

      <Panel
        title={`Conflicts (${conflicts.length})`}
        eyebrow="pa-candidate-identity-conflicts · open"
      >
        {loading && conflicts.length === 0 ? (
          <LoadingState label="Loading conflicts…" />
        ) : conflicts.length === 0 ? (
          <EmptyState
            title="No open conflicts"
            body="Nothing to review for the selected filter."
          />
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #e2e8f0" }}>
                <th style={thStyle}>Created</th>
                <th style={thStyle}>Kind</th>
                <th style={thStyle}>Primary candidate</th>
                <th style={thStyle}>Competing</th>
                <th style={thStyle}>Summary</th>
                <th style={thStyle} />
              </tr>
            </thead>
            <tbody>
              {conflicts.map((c) => (
                <tr key={c.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                  <td style={tdStyle}>{c.createdAt?.slice(0, 19).replace("T", " ") ?? "—"}</td>
                  <td style={tdStyle}>
                    <span className="status-badge warn">{c.kind}</span>
                  </td>
                  <td style={tdStyle}>
                    {c.primaryCandidateId ? (
                      <Link to={`/admin/candidates/${encodeURIComponent(c.primaryCandidateId)}/profile`}>
                        {c.primaryCandidateId.slice(0, 8)}…
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td style={tdStyle}>
                    {c.competingCandidateId ? (
                      <Link to={`/admin/candidates/${encodeURIComponent(c.competingCandidateId)}/profile`}>
                        {c.competingCandidateId.slice(0, 8)}…
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td style={{ ...tdStyle, fontSize: "0.8em", maxWidth: 360 }}>
                    {compactValue(c.payloadRedacted ?? c.evidence, 240)}
                  </td>
                  <td style={tdStyle}>
                    <Link to="/admin/identity-conflicts" style={{ fontSize: "0.85em" }}>
                      Resolve →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel
        title={`Email-only / needs-review records (${records.length})`}
        eyebrow="pa-external-candidate-records · needs_review"
      >
        {loading && records.length === 0 ? (
          <LoadingState label="Loading needs-review records…" />
        ) : records.length === 0 ? (
          <EmptyState
            title="No needs-review records"
            body="Every imported record either auto-merged or auto-created."
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {Object.entries(recordsByReason).map(([reason, recs]) => (
              <div key={reason}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>
                  {reason} <span style={{ color: "#64748b", fontWeight: 400 }}>({recs.length})</span>
                </div>
                <table style={tableStyle}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid #e2e8f0", textAlign: "left" }}>
                      <th style={thStyle}>Record</th>
                      <th style={thStyle}>Email</th>
                      <th style={thStyle}>LinkedIn</th>
                      <th style={thStyle}>Source / batch</th>
                      <th style={thStyle}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recs.map((r) => (
                      <tr key={r.recordId} style={{ borderBottom: "1px solid #f1f5f9" }}>
                        <td style={{ ...tdStyle, fontFamily: "monospace", fontSize: "0.75em" }}>
                          {r.recordId.slice(0, 8)}…
                        </td>
                        <td style={tdStyle}>
                          <RedactedField value={r.emails[0]?.value} kind="email" context={r.recordId} />
                        </td>
                        <td style={tdStyle}>
                          {r.canonicalLinkedInUrl ? (
                            <a
                              href={r.canonicalLinkedInUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ fontSize: "0.85em" }}
                            >
                              {r.canonicalLinkedInUrl.replace(/^https?:\/\/(www\.)?/, "")}
                            </a>
                          ) : (
                            <span style={{ color: "#94a3b8" }}>—</span>
                          )}
                        </td>
                        <td style={tdStyle}>
                          <Link to={`/admin/external-supply/batches/${r.batchId}`}>
                            {r.source} · {r.batchId.slice(0, 8)}…
                          </Link>
                        </td>
                        <td style={tdStyle}>
                          <IdentityStatusBadge status={r.identityResolutionStatus} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  )
}

function compactValue(value: unknown, max: number): string {
  if (value === null || value === undefined) return "—"
  const s = typeof value === "string" ? value : JSON.stringify(value)
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

const tableStyle: React.CSSProperties = {
  width: "100%",
  fontSize: "0.85em",
  borderCollapse: "collapse",
}

const thStyle: React.CSSProperties = {
  padding: "0.5rem 0",
}

const tdStyle: React.CSSProperties = {
  padding: "0.4rem 0",
}

const secondaryBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "1px solid #cbd5e1",
  color: "#1f2937",
  padding: "0.5rem 1rem",
  borderRadius: 4,
  cursor: "pointer",
}

const activeFilterBtn: React.CSSProperties = {
  background: "#1a73e8",
  color: "white",
  border: "none",
  padding: "0.4rem 0.85rem",
  borderRadius: 6,
  fontSize: "0.85em",
  cursor: "pointer",
}

const inactiveFilterBtn: React.CSSProperties = {
  background: "#fff",
  color: "#475569",
  border: "1px solid #cbd5e1",
  padding: "0.4rem 0.85rem",
  borderRadius: 6,
  fontSize: "0.85em",
  cursor: "pointer",
}
