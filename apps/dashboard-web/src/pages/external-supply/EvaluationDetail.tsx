/**
 * v2.0 External Supply V1 — Wave D — `/admin/external-supply/evaluations/:runId`.
 *
 * Per-candidate Tier 1/2/3/retain-only/blocked table. Operator can override
 * the proposed tier on a row through the canonical `pa-evaluation-attempts`
 * review callable. The dashboard does not directly mutate downstream
 * employment-impacting state.
 *
 * Also supports a bulk "Generate research prompt for missing-info rows"
 * action that routes to `/admin/external-supply/research`.
 */
import { Fragment, useEffect, useMemo, useState } from "react"
import { useNavigate, useParams, Link } from "react-router-dom"
import {
  type CandidateCompanyJobEvaluation,
  type CandidateEvaluationRun,
  type EvaluationTier,
} from "@pa/core-types"
import { AdminJobLink, AdminUserLink } from "../../components/AdminEntityLink.js"
import { EmptyState, ErrorState, LoadingState, PageHeader, Panel } from "../../components/ui.js"
import { EvalLabelForm } from "../../components/prescreen/EvalLabelForm.js"
import { EvaluationTierBadge } from "../../components/external-supply/EvaluationTierBadge.js"
import {
  findEvaluationAttemptByExternalEvaluationId,
  generateAgentResearchPrompt,
  getEvaluationRun,
  listEvaluations,
  reviewEvaluationAttempt,
} from "../../lib/external-supply-client.js"

const TIER_OPTIONS: EvaluationTier[] = [
  "tier_1_personal_linkedin_and_email",
  "tier_2_personal_email",
  "tier_3_general_email",
  "retain_only",
  "blocked",
]

export function EvaluationDetail() {
  const { runId } = useParams<{ runId: string }>()
  const navigate = useNavigate()
  const [run, setRun] = useState<CandidateEvaluationRun | null>(null)
  const [evaluations, setEvaluations] = useState<CandidateCompanyJobEvaluation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [actionMsg, setActionMsg] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [genBusy, setGenBusy] = useState(false)
  // Data-labeling: the expanded row's evaluationId, plus the lazily-resolved
  // canonical attemptId for that row (keyed by evaluationId).
  const [labelRowId, setLabelRowId] = useState<string | null>(null)
  const [labelAttemptIds, setLabelAttemptIds] = useState<Record<string, string | null>>({})
  const [labelResolving, setLabelResolving] = useState(false)

  useEffect(() => {
    if (!runId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([getEvaluationRun(runId), listEvaluations(runId, 500)])
      .then(([r, evs]) => {
        if (cancelled) return
        setRun(r)
        setEvaluations(evs.rows)
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
  }, [runId, refreshKey])

  const tierBreakdown = useMemo(() => {
    const out: Record<string, number> = {}
    for (const e of evaluations) {
      const tier = e.reviewerDecision?.finalTier ?? e.proposedTier
      out[tier] = (out[tier] ?? 0) + 1
    }
    return out
  }, [evaluations])

  const missingInfoRows = useMemo(
    () => evaluations.filter((e) => e.missingInfo && e.missingInfo.length > 0),
    [evaluations],
  )

  async function overrideTier(evaluation: CandidateCompanyJobEvaluation, finalTier: EvaluationTier) {
    setBusyId(evaluation.evaluationId)
    setActionMsg(null)
    try {
      const attempt = await findEvaluationAttemptByExternalEvaluationId(evaluation.evaluationId)
      if (!attempt) {
        throw new Error("No canonical evaluation attempt found for this row. Re-run evaluation before review.")
      }
      const isApproval = finalTier === evaluation.proposedTier
      await reviewEvaluationAttempt({
        attemptId: attempt.attemptId,
        status: isApproval ? "approved" : "overridden",
        finalOutcome: isApproval
          ? undefined
          : {
              kind: externalTierOutcomeKind(finalTier),
              supplyTier: finalTier,
            },
        correctionReason: isApproval ? undefined : "external_supply_evaluation_tier_override",
      })
      setActionMsg(`Tier override saved · ${evaluation.candidateId.slice(0, 8)}… → ${finalTier}`)
      setRefreshKey((n) => n + 1)
    } catch (err) {
      setActionMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  // Reuse the SAME attempt resolution as overrideTier (findEvaluationAttemptByExternalEvaluationId)
  // so the label form grades the canonical attempt the tier-override writes to.
  async function toggleLabelRow(evaluation: CandidateCompanyJobEvaluation) {
    if (labelRowId === evaluation.evaluationId) {
      setLabelRowId(null)
      return
    }
    setLabelRowId(evaluation.evaluationId)
    if (labelAttemptIds[evaluation.evaluationId] !== undefined) return
    setLabelResolving(true)
    try {
      const attempt = await findEvaluationAttemptByExternalEvaluationId(evaluation.evaluationId)
      setLabelAttemptIds((prev) => ({ ...prev, [evaluation.evaluationId]: attempt?.attemptId ?? null }))
    } catch {
      setLabelAttemptIds((prev) => ({ ...prev, [evaluation.evaluationId]: null }))
    } finally {
      setLabelResolving(false)
    }
  }

  async function startResearchForSelected() {
    if (selected.size === 0) {
      setActionMsg("Pick at least one row first.")
      return
    }
    if (!runId) return
    setGenBusy(true)
    setActionMsg(null)
    try {
      const recordIds: string[] = []
      const candidateIds: string[] = []
      const missingByCandidate: Record<string, string[]> = {}
      for (const e of evaluations) {
        if (!selected.has(e.evaluationId)) continue
        candidateIds.push(e.candidateId)
        if (e.missingInfo && e.missingInfo.length > 0) {
          missingByCandidate[e.candidateId] = e.missingInfo
        }
      }
      const result = await generateAgentResearchPrompt({
        evaluationRunId: runId,
        candidateIds: candidateIds.length > 0 ? candidateIds : undefined,
        recordIds: recordIds.length > 0 ? recordIds : undefined,
        missingInfoOverride: Object.keys(missingByCandidate).length > 0 ? missingByCandidate : undefined,
        companyId: run?.companyId,
        jobId: run?.jobId,
      })
      navigate(`/admin/external-supply/research?taskId=${result.taskId}`)
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setGenBusy(false)
    }
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (!runId) return <ErrorState message="Missing runId param." />

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="v2.0 External Supply V1 / Admin"
        title={`Run ${runId.slice(0, 8)}…`}
        description={
          run
            ? `${run.jobId} @ ${run.companyId} · ${run.completedCount}/${run.candidateCount} evaluated · rubric=${run.rubricVersion}`
            : ""
        }
        actions={
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {run?.jobId ? <AdminJobLink jobId={run.jobId}>Open job</AdminJobLink> : null}
            <Link to={`/admin/external-supply/evaluations/${runId}/agent-ranking`}>
              <button type="button" style={primaryBtnStyle}>
                Run agent ranking
              </button>
            </Link>
            <Link to="/admin/external-supply/evaluations">
              <button type="button" style={secondaryBtnStyle}>
                All runs
              </button>
            </Link>
          </div>
        }
      />

      {error && <ErrorState message={error} />}
      {actionMsg && <div className="notice notice-bad" style={{ fontSize: "0.85em" }}>{actionMsg}</div>}

      {run && (
        <Panel title="Tier breakdown" eyebrow="proposed + reviewer-final">
          <div style={breakdownStyle}>
            {Object.entries(tierBreakdown).map(([tier, n]) => (
              <div key={tier} style={breakdownCardStyle}>
                <div style={{ fontSize: "1.4em", fontWeight: 600 }}>{n}</div>
                <EvaluationTierBadge tier={tier as EvaluationTier} />
              </div>
            ))}
          </div>
        </Panel>
      )}

      <Panel
        title={`Evaluations (${evaluations.length})`}
        eyebrow="pa-candidate-company-job-evaluations"
        actions={
          <div style={{ display: "flex", gap: 8 }}>
            <span style={{ fontSize: "0.85em", color: "#64748b" }}>
              {selected.size} selected · {missingInfoRows.length} have missingInfo
            </span>
            <button
              type="button"
              onClick={startResearchForSelected}
              disabled={selected.size === 0 || genBusy}
              style={primaryBtnStyle}
            >
              {genBusy ? "Generating prompt…" : "Research selected"}
            </button>
            <button
              type="button"
              onClick={() => setRefreshKey((n) => n + 1)}
              style={secondaryBtnStyle}
            >
              Refresh
            </button>
          </div>
        }
      >
        {loading && evaluations.length === 0 ? (
          <LoadingState label="Loading evaluations…" />
        ) : evaluations.length === 0 ? (
          <EmptyState
            title="No evaluations yet"
            body="The run may still be processing. Refresh in a moment."
          />
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #e2e8f0" }}>
                <th style={thStyle} />
                <th style={thStyle}>Candidate</th>
                <th style={thStyle}>Proposed tier</th>
                <th style={thStyle}>Final tier</th>
                <th style={thStyle}>Soft score</th>
                <th style={thStyle}>Hard gate</th>
                <th style={thStyle}>Missing</th>
                <th style={thStyle}>Risks</th>
                <th style={thStyle}>Explanation</th>
                <th style={thStyle}>Override</th>
                <th style={thStyle}>Label</th>
              </tr>
            </thead>
            <tbody>
              {evaluations.map((e) => (
                <Fragment key={e.evaluationId}>
                <tr style={{ borderBottom: "1px solid #f1f5f9" }}>
                  <td style={tdStyle}>
                    <input
                      type="checkbox"
                      checked={selected.has(e.evaluationId)}
                      onChange={() => toggle(e.evaluationId)}
                    />
                  </td>
                  <td style={{ ...tdStyle, fontFamily: "monospace", fontSize: "0.8em" }}>
                    <AdminUserLink userId={e.candidateId}>{e.candidateId.slice(0, 8)}…</AdminUserLink>
                  </td>
                  <td style={tdStyle}>
                    <EvaluationTierBadge tier={e.proposedTier} />
                  </td>
                  <td style={tdStyle}>
                    {e.reviewerDecision ? (
                      <EvaluationTierBadge tier={e.reviewerDecision.finalTier} />
                    ) : (
                      <span style={{ color: "#94a3b8" }}>—</span>
                    )}
                  </td>
                  <td style={tdStyle}>{e.softScore.toFixed(3)}</td>
                  <td style={tdStyle}>
                    <span className={`status-badge ${gateTone(e.hardGateResult)}`}>
                      {e.hardGateResult}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    {e.missingInfo.length > 0 ? (
                      <span title={e.missingInfo.join("\n")}>{e.missingInfo.length}</span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td style={tdStyle}>
                    {e.risks.length > 0 ? (
                      <span title={e.risks.join("\n")}>{e.risks.length}</span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td style={{ ...tdStyle, fontSize: "0.8em", maxWidth: 240 }}>
                    {e.explanation.length > 180
                      ? `${e.explanation.slice(0, 179)}…`
                      : e.explanation}
                  </td>
                  <td style={tdStyle}>
                    <select
                      value={e.reviewerDecision?.finalTier ?? ""}
                      disabled={busyId === e.evaluationId}
                      onChange={(ev) => {
                        const next = ev.target.value as EvaluationTier
                        if (next) void overrideTier(e, next)
                      }}
                      style={selectStyle}
                    >
                      <option value="">Set tier…</option>
                      {TIER_OPTIONS.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td style={tdStyle}>
                    <button
                      type="button"
                      onClick={() => void toggleLabelRow(e)}
                      style={{
                        padding: "4px 8px",
                        border: "1px solid #cbd5e1",
                        borderRadius: 6,
                        background: labelRowId === e.evaluationId ? "#e2e8f0" : "#fff",
                        cursor: "pointer",
                        fontSize: "0.85em",
                      }}
                      aria-expanded={labelRowId === e.evaluationId}
                    >
                      {labelRowId === e.evaluationId ? "Hide" : "Label"}
                    </button>
                  </td>
                </tr>
                {labelRowId === e.evaluationId && (
                  <tr>
                    <td colSpan={11} style={{ padding: "0.6rem 0.4rem", background: "#f8fafc" }}>
                      {(() => {
                        const attemptId = labelAttemptIds[e.evaluationId]
                        if (attemptId === undefined) {
                          return <span style={{ fontSize: "0.85em", color: "#64748b" }}>{labelResolving ? "Resolving evaluation attempt…" : "Loading…"}</span>
                        }
                        if (attemptId === null) {
                          return (
                            <span style={{ fontSize: "0.85em", color: "#b45309" }}>
                              No canonical evaluation attempt found for this row. Re-run evaluation before labeling.
                            </span>
                          )
                        }
                        return (
                          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
                            {/* LEFT — read-only AI evaluation. */}
                            <div style={{ border: "1px solid #e2e8f0", borderRadius: 8, background: "#fff", padding: 12 }}>
                              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                                <span style={{ fontSize: "0.75em", textTransform: "uppercase", color: "#94a3b8" }}>Proposed tier</span>
                                <EvaluationTierBadge tier={e.proposedTier} />
                                <span style={{ fontSize: "0.8em", color: "#64748b" }}>soft {e.softScore.toFixed(3)} · gate {e.hardGateResult}</span>
                              </div>
                              <p style={{ margin: 0, fontSize: "0.85em", color: "#334155", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
                                {e.explanation}
                              </p>
                              {e.risks.length > 0 && (
                                <p style={{ margin: "8px 0 0", fontSize: "0.8em", color: "#b45309" }}>Risks: {e.risks.join("; ")}</p>
                              )}
                            </div>
                            {/* RIGHT — shared label form (label-only, never messages). */}
                            <EvalLabelForm
                              attemptId={attemptId}
                              aiProposedOutcomeKind={externalTierOutcomeKind(e.proposedTier)}
                            />
                          </div>
                        )
                      })()}
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  )
}

function gateTone(g: "pass" | "soft_block" | "hard_block"): string {
  if (g === "pass") return "good"
  if (g === "hard_block") return "bad"
  return "warn"
}

function externalTierOutcomeKind(tier: EvaluationTier): "pass" | "hold" | "reject" {
  if (tier === "blocked") return "reject"
  if (tier === "retain_only") return "hold"
  return "pass"
}

const tableStyle: React.CSSProperties = {
  width: "100%",
  fontSize: "0.85em",
  borderCollapse: "collapse",
}

const thStyle: React.CSSProperties = { padding: "0.5rem 0" }
const tdStyle: React.CSSProperties = { padding: "0.4rem 0" }

const breakdownStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
  gap: 8,
}

const breakdownCardStyle: React.CSSProperties = {
  padding: "0.5rem 0.75rem",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  background: "#fff",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 4,
}

const primaryBtnStyle: React.CSSProperties = {
  background: "#1a73e8",
  color: "white",
  border: "none",
  padding: "0.5rem 1rem",
  borderRadius: 4,
  fontWeight: 500,
  cursor: "pointer",
}

const secondaryBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "1px solid #cbd5e1",
  color: "#1f2937",
  padding: "0.5rem 1rem",
  borderRadius: 4,
  cursor: "pointer",
}

const selectStyle: React.CSSProperties = {
  padding: "0.3rem 0.5rem",
  border: "1px solid #cbd5e1",
  borderRadius: 4,
  fontSize: "0.8em",
}
