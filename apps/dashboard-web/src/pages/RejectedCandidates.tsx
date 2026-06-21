import { useCallback, useEffect, useState, type CSSProperties } from "react"
import { Link } from "react-router-dom"
import { Badge, ErrorState, LoadingState, PageHeader, Panel } from "../components/ui.js"
import {
  getRejectedCandidates,
  reevaluateCandidateTier,
  TIER_BLURB,
  TIER_LABELS,
  type CandidateTier,
  type RejectedCandidateRow,
  type RejectedCandidatesSnapshot,
  type ReevaluateResult,
} from "../lib/rejected-candidates-api.js"

type TierFilter = CandidateTier | "all"

const TIER_TONE: Record<CandidateTier, "ok" | "warn" | "muted"> = {
  tier_1: "ok",
  tier_2: "warn",
  tier_3: "muted",
}

function TierBadge({ tier }: { tier: CandidateTier }) {
  return (
    <span title={TIER_BLURB[tier]}>
      <Badge tone={TIER_TONE[tier]}>{TIER_LABELS[tier]}</Badge>
    </span>
  )
}

export default function RejectedCandidates({
  load = getRejectedCandidates,
  reeval = reevaluateCandidateTier,
}: {
  load?: typeof getRejectedCandidates
  reeval?: typeof reevaluateCandidateTier
}) {
  const [tier, setTier] = useState<TierFilter>("all")
  const [reusableOnly, setReusableOnly] = useState(false)
  const [snap, setSnap] = useState<RejectedCandidatesSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reevalById, setReevalById] = useState<Record<string, ReevaluateResult | "loading">>({})

  const refresh = useCallback(() => {
    setLoading(true)
    setError(null)
    void load({ tier: tier === "all" ? undefined : tier, reusableOnly, limit: 300 })
      .then(setSnap)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [tier, reusableOnly, load])

  useEffect(refresh, [refresh])

  const runReeval = useCallback(
    async (candidateId: string, apply?: { tier: CandidateTier }) => {
      setReevalById((m) => ({ ...m, [candidateId]: "loading" }))
      try {
        const res = await reeval({ candidateId, apply: Boolean(apply), tier: apply?.tier })
        setReevalById((m) => ({ ...m, [candidateId]: res }))
        if (apply) refresh()
      } catch (e) {
        setReevalById((m) => {
          const n = { ...m }
          delete n[candidateId]
          return n
        })
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [reeval, refresh],
  )

  const counts = snap?.counts
  const chips: { key: TierFilter; label: string }[] = [
    { key: "all", label: `All${counts ? ` (${counts.total})` : ""}` },
    { key: "tier_1", label: `Tier 1${counts ? ` (${counts.tier_1})` : ""}` },
    { key: "tier_2", label: `Tier 2${counts ? ` (${counts.tier_2})` : ""}` },
    { key: "tier_3", label: `Tier 3${counts ? ` (${counts.tier_3})` : ""}` },
  ]

  return (
    <div>
      <PageHeader
        eyebrow="Candidates"
        title="Rejected candidates"
        description="Rejected for one role, kept in the pool. Tier 1 = strong, re-review for new roles. Stamped at every prescreen + recruiter rejection."
        actions={
          <label style={checkboxLabel}>
            <input type="checkbox" checked={reusableOnly} onChange={(e) => setReusableOnly(e.target.checked)} />
            Reusable only (tier 1–2)
          </label>
        }
      />

      <div style={chipRow}>
        {chips.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => setTier(c.key)}
            style={{ ...chip, ...(tier === c.key ? chipActive : null) }}
          >
            {c.label}
          </button>
        ))}
      </div>

      {error ? <ErrorState message={error} /> : null}
      {loading && !snap ? <LoadingState label="Loading rejected candidates…" /> : null}

      {snap ? (
        <Panel title={`${snap.rows.length} candidate${snap.rows.length === 1 ? "" : "s"}`}>
          {snap.truncated ? (
            <div style={warn}>Scan cap hit — showing the most recent. Narrow by tier to see older rejections.</div>
          ) : null}
          {snap.rows.length === 0 ? (
            <div style={{ padding: 16, color: "#6b7280", fontSize: 14 }}>No rejected candidates in this filter.</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={table}>
                <thead>
                  <tr>
                    <th style={th}>Candidate</th>
                    <th style={th}>Tier</th>
                    <th style={th}>Source</th>
                    <th style={th}>Rejections</th>
                    <th style={th}>Last reason</th>
                    <th style={th}>Re-evaluate for new roles</th>
                  </tr>
                </thead>
                <tbody>
                  {snap.rows.map((row) => (
                    <Row key={row.candidateId} row={row} reeval={reevalById[row.candidateId]} onReeval={runReeval} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      ) : null}
    </div>
  )
}

function Row({
  row,
  reeval,
  onReeval,
}: {
  row: RejectedCandidateRow
  reeval: ReevaluateResult | "loading" | undefined
  onReeval: (candidateId: string, apply?: { tier: CandidateTier }) => void
}) {
  return (
    <tr style={tr}>
      <td style={td}>
        <Link to={`/admin/candidates/${row.candidateId}/profile`} style={{ color: "#1d4ed8", fontWeight: 600 }}>
          {row.displayName || row.candidateId}
        </Link>
        {!row.humanConfirmed ? <span style={aiTag} title="Tier from AI suggestion, not yet human-confirmed">AI</span> : null}
      </td>
      <td style={td}>
        <TierBadge tier={row.tier} />
      </td>
      <td style={td}>{row.source}</td>
      <td style={td}>{row.rejectionCount}</td>
      <td style={{ ...td, maxWidth: 280, color: "#475569" }}>{row.lastReason || "—"}</td>
      <td style={td}>
        {reeval === "loading" ? (
          <span style={{ color: "#6b7280", fontSize: 12 }}>evaluating…</span>
        ) : reeval ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 12, color: "#334155" }}>
              AI suggests: {reeval.suggestedTier ? <TierBadge tier={reeval.suggestedTier} /> : "—"}{" "}
              <span style={{ color: "#94a3b8" }}>({reeval.eventsConsidered} signals)</span>
            </span>
            <div style={{ display: "flex", gap: 4 }}>
              {(["tier_1", "tier_2", "tier_3"] as CandidateTier[]).map((t) => (
                <button key={t} type="button" style={applyBtn} onClick={() => onReeval(row.candidateId, { tier: t })}>
                  set {TIER_LABELS[t]}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <button type="button" style={reevalBtn} onClick={() => onReeval(row.candidateId)}>
            Re-evaluate
          </button>
        )}
      </td>
    </tr>
  )
}

const chipRow: CSSProperties = { display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }
const chip: CSSProperties = {
  padding: "6px 12px",
  fontSize: 13,
  border: "1px solid var(--line, #e5e7eb)",
  borderRadius: 999,
  background: "var(--surface, #fff)",
  color: "var(--ink-2, #374151)",
  cursor: "pointer",
}
const chipActive: CSSProperties = { background: "var(--ink-1, #111827)", color: "#fff", borderColor: "var(--ink-1, #111827)" }
const checkboxLabel: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "#374151" }
const table: CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: 13 }
const th: CSSProperties = { textAlign: "left", padding: "8px 10px", borderBottom: "1px solid #e5e7eb", color: "#6b7280", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em" }
const tr: CSSProperties = { borderBottom: "1px solid #f1f5f9" }
const td: CSSProperties = { padding: "10px", verticalAlign: "top" }
const aiTag: CSSProperties = { marginLeft: 6, fontSize: 10, fontWeight: 700, color: "#92400e", background: "#fef3c7", borderRadius: 4, padding: "1px 4px" }
const reevalBtn: CSSProperties = { padding: "4px 10px", fontSize: 12, border: "1px solid #bfdbfe", color: "#1d4ed8", background: "#fff", borderRadius: 6, cursor: "pointer" }
const applyBtn: CSSProperties = { padding: "2px 8px", fontSize: 11, border: "1px solid #e5e7eb", color: "#374151", background: "#fff", borderRadius: 6, cursor: "pointer" }
const warn: CSSProperties = { border: "1px solid #fcd34d", background: "#fffbeb", color: "#92400e", borderRadius: 8, padding: "8px 12px", fontSize: 13, marginBottom: 12 }
