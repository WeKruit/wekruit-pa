/**
 * v2.0 External Supply V2 — Wave D dashboard UX —
 * `/admin/external-supply/evaluations/:runId/agent-ranking`.
 *
 * Operator-facing surface for the V2 agent-ranking layer (Wave C
 * `paExternalSupplyRunAgentRanking` + `paExternalSupplyApproveAgentTier` +
 * `paExternalSupplyOverrideAgentTier`).
 *
 * Page sections:
 *   1. Run header — companyId · jobId · rankedCount · model · cost (per
 *      latest run summary returned by the callable).
 *   2. Actions — Run agent ranking · Dry-run toggle · optional budget USD
 *      input. Dry-run flips `dryRun=true` so the callable returns prompts
 *      without writing any `pa-agent-ranking-results` rows.
 *   3. RankingTable — bulk-select + bulk-approve + per-row approve/override.
 *
 * Per L-E2: NO optimistic updates — we refetch after every mutation. Bulk
 * approve uses a concurrency cap of 5 (PromiseQueue-style fan-out below).
 */
import { useCallback, useEffect, useMemo, useState } from "react"
import { Link, useParams } from "react-router-dom"
import type { EvaluationTier } from "@pa/core-types"
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Panel,
} from "../../components/ui.js"
import { RankingTable } from "../../components/external-supply/RankingTable.js"
import {
  approveAgentTier,
  getEvaluationRun,
  listAgentRankingResults,
  overrideAgentTier,
  runAgentRanking,
  type AgentRankingResult,
  type RunAgentRankingResult,
} from "../../lib/external-supply-client.js"
import type { CandidateEvaluationRun } from "@pa/core-types"

const BULK_APPROVE_CONCURRENCY = 5

export function EvaluationAgentRanking() {
  const { runId } = useParams<{ runId: string }>()
  const [run, setRun] = useState<CandidateEvaluationRun | null>(null)
  const [results, setResults] = useState<AgentRankingResult[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busyResultIds, setBusyResultIds] = useState<Set<string>>(new Set())
  const [actionMsg, setActionMsg] = useState<string | null>(null)
  const [runBusy, setRunBusy] = useState(false)
  const [dryRun, setDryRun] = useState(true)
  const [budgetUsd, setBudgetUsd] = useState<string>("")
  const [lastRunSummary, setLastRunSummary] = useState<RunAgentRankingResult | null>(null)

  useEffect(() => {
    if (!runId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([
      getEvaluationRun(runId),
      listAgentRankingResults({ evaluationRunId: runId, limit: 500 }),
    ])
      .then(([r, rk]) => {
        if (cancelled) return
        setRun(r)
        setResults(rk.rows)
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

  const summary = useMemo(() => {
    const total = results.length
    const approved = results.filter((r) => r.status === "approved").length
    const overridden = results.filter((r) => r.status === "overridden").length
    const proposed = results.filter((r) => r.status === "proposed").length
    const totalCost = results.reduce((s, r) => s + r.totalCostUsd, 0)
    return { total, approved, overridden, proposed, totalCost }
  }, [results])

  const onToggleSelect = useCallback((resultId: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(resultId)) next.delete(resultId)
      else next.add(resultId)
      return next
    })
  }, [])

  const onToggleSelectAll = useCallback(
    (next: boolean) => {
      if (!next) {
        setSelected(new Set())
        return
      }
      setSelected(new Set(results.map((r) => r.resultId)))
    },
    [results],
  )

  function markBusy(id: string, on: boolean) {
    setBusyResultIds((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }

  async function handleApprove(resultId: string) {
    setActionMsg(null)
    markBusy(resultId, true)
    try {
      await approveAgentTier({ resultId })
      setActionMsg(`Approved ${resultId.slice(0, 12)}…`)
      setRefreshKey((n) => n + 1)
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : String(e))
    } finally {
      markBusy(resultId, false)
    }
  }

  async function handleOverride(
    resultId: string,
    newTier: EvaluationTier,
    reason: string,
  ) {
    setActionMsg(null)
    markBusy(resultId, true)
    try {
      const res = await overrideAgentTier({ resultId, newTier, reason })
      setActionMsg(
        `Overridden ${resultId.slice(0, 12)}… → ${newTier} · correction ${res.correctionEventId.slice(0, 8)}…`,
      )
      setRefreshKey((n) => n + 1)
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : String(e))
    } finally {
      markBusy(resultId, false)
    }
  }

  async function handleBulkApprove() {
    const ids = Array.from(selected)
    if (ids.length === 0) {
      setActionMsg("Select at least one row to bulk-approve.")
      return
    }
    setActionMsg(null)
    // Concurrency-capped fan-out (L-E2: cap = 5).
    let i = 0
    let approved = 0
    let failed = 0
    async function worker() {
      while (i < ids.length) {
        const id = ids[i++]
        if (!id) continue
        markBusy(id, true)
        try {
          await approveAgentTier({ resultId: id })
          approved += 1
        } catch {
          failed += 1
        } finally {
          markBusy(id, false)
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(BULK_APPROVE_CONCURRENCY, ids.length) }, () => worker()),
    )
    setActionMsg(`Bulk approve done · approved=${approved} failed=${failed}`)
    setSelected(new Set())
    setRefreshKey((n) => n + 1)
  }

  async function handleRunAgentRanking() {
    if (!runId) return
    setRunBusy(true)
    setActionMsg(null)
    try {
      const budget = budgetUsd.trim() ? Number.parseFloat(budgetUsd.trim()) : undefined
      const res = await runAgentRanking({
        evaluationRunId: runId,
        dryRun,
        ...(typeof budget === "number" && Number.isFinite(budget) && budget > 0
          ? { budgetUsd: budget }
          : {}),
      })
      setLastRunSummary(res)
      setActionMsg(
        `Run agent ranking · processed=${res.processedCount} ranked=${res.rankedCount} skipped=${res.skippedCount} cost=$${res.totalCostUsd.toFixed(4)}${res.abortedReason ? ` aborted=${res.abortedReason}` : ""}`,
      )
      setRefreshKey((n) => n + 1)
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setRunBusy(false)
    }
  }

  if (!runId) return <ErrorState message="Missing runId param." />

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="v2.0 External Supply V2 / Admin"
        title={`Agent ranking · run ${runId.slice(0, 8)}…`}
        description={
          run
            ? `${run.jobId} @ ${run.companyId} · ${summary.total} ranked · model=${lastRunSummary?.promptVersion ?? "—"} · cost=$${summary.totalCost.toFixed(4)}`
            : "Loading run…"
        }
        actions={
          <Link to={`/admin/external-supply/evaluations/${runId}`}>
            <button type="button" style={secondaryBtnStyle}>
              ← Back to run
            </button>
          </Link>
        }
      />

      {error && <ErrorState message={error} />}
      {actionMsg && (
        <div className="notice notice-bad" style={{ fontSize: "0.85em" }}>
          {actionMsg}
        </div>
      )}

      <Panel title="Actions" eyebrow="run agent ranking · dry-run · budget">
        <div style={actionRowStyle}>
          <label style={inlineLabelStyle}>
            <input
              type="checkbox"
              checked={dryRun}
              onChange={(e) => setDryRun(e.target.checked)}
            />
            <span>Dry run (no writes, returns prompts)</span>
          </label>
          <label style={inlineLabelStyle}>
            <span>Budget USD</span>
            <input
              type="number"
              min="0"
              step="0.1"
              value={budgetUsd}
              onChange={(e) => setBudgetUsd(e.target.value)}
              placeholder="(default 10)"
              style={{ ...inputStyle, width: 100 }}
            />
          </label>
          <button
            type="button"
            onClick={handleRunAgentRanking}
            disabled={runBusy}
            style={primaryBtnStyle}
          >
            {runBusy ? "Running…" : "Run agent ranking"}
          </button>
        </div>
        {lastRunSummary && (
          <div style={{ marginTop: 8, fontSize: "0.8em", color: "#64748b" }}>
            Last run · promptVersion=<code>{lastRunSummary.promptVersion}</code> · costTable=
            <code>{lastRunSummary.costTableVersion}</code> · projected=$
            {lastRunSummary.projectedCostUsd.toFixed(4)} · actual=$
            {lastRunSummary.totalCostUsd.toFixed(4)}
          </div>
        )}
      </Panel>

      <Panel
        title={`Ranking results (${summary.total})`}
        eyebrow={`proposed=${summary.proposed} · approved=${summary.approved} · overridden=${summary.overridden}`}
        actions={
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ fontSize: "0.85em", color: "#64748b" }}>
              {selected.size} selected
            </span>
            <button
              type="button"
              onClick={handleBulkApprove}
              disabled={selected.size === 0}
              style={primaryBtnStyle}
            >
              Bulk approve
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
        {loading && results.length === 0 ? (
          <LoadingState label="Loading agent ranking results…" />
        ) : results.length === 0 ? (
          <EmptyState
            title="No agent ranking yet"
            body="Run agent ranking from the actions above. Dry-run is safe and writes nothing."
          />
        ) : (
          <RankingTable
            results={results}
            selected={selected}
            onToggleSelect={onToggleSelect}
            onToggleSelectAll={onToggleSelectAll}
            onApprove={handleApprove}
            onOverride={handleOverride}
            busyResultIds={busyResultIds}
          />
        )}
      </Panel>
    </div>
  )
}

const actionRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 16,
  flexWrap: "wrap",
}
const inlineLabelStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: "0.85em",
}
const inputStyle: React.CSSProperties = {
  padding: "0.35rem 0.5rem",
  border: "1px solid #cbd5e1",
  borderRadius: 4,
  fontSize: "0.85em",
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
