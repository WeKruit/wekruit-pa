import { useEffect, useState, type CSSProperties } from "react"
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { ErrorState, LoadingState, PageHeader, Panel } from "../components/ui.js"
import {
  INTERVIEW_TRACK_STATES,
  OFF_LADDER_STATES,
  STATE_LABELS,
  getFunnelSnapshot,
  getPassedNotVisible,
  type AdminFunnelSnapshotResult,
  type AdminPassedNotVisibleResult,
} from "../lib/funnel-api.js"

const LADDER_COLOR = "#2563eb"
const PASSED_COLOR = "#16a34a"
const VISIBLE_COLOR = "#7c3aed"
const LEAK_COLOR = "#dc2626"

type SnapshotLoader = (input: { includeTest: boolean }) => Promise<AdminFunnelSnapshotResult>
type LeakLoader = (input: { includeTest: boolean }) => Promise<AdminPassedNotVisibleResult>

function StatCard({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div style={statCard}>
      <div style={{ ...statLabel, ...(color ? { color } : null) }}>{label}</div>
      <div style={statValue}>{value.toLocaleString()}</div>
    </div>
  )
}

function barColor(state: string): string {
  if (state === "employer_visible" || state === "intro_accepted") return VISIBLE_COLOR
  if (state === "passed") return PASSED_COLOR
  return LADDER_COLOR
}

export default function FunnelOverview({
  loadSnapshot = getFunnelSnapshot,
  loadLeak = getPassedNotVisible,
}: {
  loadSnapshot?: SnapshotLoader
  loadLeak?: LeakLoader
} = {}) {
  const [includeTest, setIncludeTest] = useState(false)
  const [data, setData] = useState<AdminFunnelSnapshotResult | null>(null)
  const [leak, setLeak] = useState<AdminPassedNotVisibleResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void Promise.all([loadSnapshot({ includeTest }), loadLeak({ includeTest })])
      .then(([snap, lk]) => {
        if (cancelled) return
        setData(snap)
        setLeak(lk)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [includeTest, loadSnapshot, loadLeak])

  const truncatedHit = (data?.truncated ?? false) || (leak?.truncated ?? false)

  const chartData = data
    ? data.stages.map((s) => ({
        state: s.state,
        label: STATE_LABELS[s.state] ?? s.state,
        count: s.count,
        pctOfPrev: s.pctOfPrev,
        pctOfTop: s.pctOfTop,
      }))
    : []

  return (
    <div>
      <PageHeader
        eyebrow="Operations"
        title="Candidate × job funnel"
        description="Point-in-time stage counts across the marketplace ladder (pa-candidate-job-states). The gap between prescreens and employer-visible is the measurable leak."
        actions={
          <label style={checkboxLabel}>
            <input type="checkbox" checked={includeTest} onChange={(e) => setIncludeTest(e.target.checked)} />
            Include test accounts
          </label>
        }
      />

      {error ? <ErrorState message={error} /> : null}
      {loading && !data ? <LoadingState label="Loading funnel…" /> : null}

      {data ? (
        <>
          {truncatedHit ? (
            <div style={warnBanner}>
              The state scan hit its cap — counts may undercount the oldest part of the collection.
            </div>
          ) : null}

          <div style={statsRow}>
            <StatCard label="Total (candidate × job)" value={data.total} />
            <StatCard
              label="Prescreen started"
              value={data.stages.find((s) => s.state === "prescreen_started")?.count ?? 0}
              color={LADDER_COLOR}
            />
            <StatCard
              label="Passed"
              value={data.stages.find((s) => s.state === "passed")?.count ?? 0}
              color={PASSED_COLOR}
            />
            <StatCard
              label="Employer-visible"
              value={data.stages.find((s) => s.state === "employer_visible")?.count ?? 0}
              color={VISIBLE_COLOR}
            />
            <StatCard label="Passed · no snapshot (leak)" value={data.passedNotVisible} color={LEAK_COLOR} />
          </div>

          <Panel
            title="Stage ladder"
            eyebrow="candidate_matched → … → employer_visible · counts + conversion %"
          >
            <div style={{ width: "100%", height: 420 }}>
              <ResponsiveContainer>
                <BarChart
                  layout="vertical"
                  data={chartData}
                  margin={{ top: 8, right: 56, bottom: 8, left: 8 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--line, #e5e7eb)" horizontal={false} />
                  <XAxis type="number" tick={axisTick} allowDecimals={false} />
                  <YAxis
                    type="category"
                    dataKey="label"
                    tick={axisTick}
                    width={130}
                    interval={0}
                  />
                  <Tooltip
                    formatter={(value: unknown, _name, item) => {
                      const row = item?.payload as { pctOfPrev?: number | null; pctOfTop?: number | null } | undefined
                      const parts = [`${Number(value).toLocaleString()} records`]
                      if (row?.pctOfPrev != null) parts.push(`${row.pctOfPrev}% of prev`)
                      if (row?.pctOfTop != null) parts.push(`${row.pctOfTop}% of top`)
                      return [parts.join(" · "), "Stage"]
                    }}
                  />
                  <Bar dataKey="count" radius={[0, 3, 3, 0]}>
                    {chartData.map((row) => (
                      <Cell key={row.state} fill={barColor(row.state)} />
                    ))}
                    <LabelList dataKey="count" position="right" style={{ fontSize: 11, fill: "var(--ink-2, #374151)" }} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div style={ladderTableWrap}>
              <table style={ladderTable}>
                <thead>
                  <tr>
                    <th style={thLeft}>Stage</th>
                    <th style={thRight}>Count</th>
                    <th style={thRight}>% of prev</th>
                    <th style={thRight}>% of top</th>
                  </tr>
                </thead>
                <tbody>
                  {data.stages.map((s) => (
                    <tr key={s.state}>
                      <td style={tdLeft}>{STATE_LABELS[s.state] ?? s.state}</td>
                      <td style={tdRight}>{s.count.toLocaleString()}</td>
                      <td style={tdRight}>{s.pctOfPrev == null ? "—" : `${s.pctOfPrev}%`}</td>
                      <td style={tdRight}>{s.pctOfTop == null ? "—" : `${s.pctOfTop}%`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel title="Interview sub-track" eyebrow="Orthogonal to the pass/fail spine — interviewState on the same docs">
            <div style={statsRow}>
              {INTERVIEW_TRACK_STATES.map((s) => (
                <StatCard key={s} label={STATE_LABELS[s] ?? s} value={data.interview[s] ?? 0} />
              ))}
            </div>
          </Panel>

          <Panel title="Off-ladder states" eyebrow="Terminal-aside — retained in the marketplace pool, not part of the spine flow">
            <div style={statsRow}>
              {OFF_LADDER_STATES.map((s) => (
                <StatCard key={s} label={STATE_LABELS[s] ?? s} value={data.offLadder[s] ?? 0} />
              ))}
            </div>
          </Panel>

          <Panel
            title="Passed but not employer-visible"
            eyebrow={
              leak
                ? `${leak.total.toLocaleString()} stuck PASS records — no employer-visible snapshot${leak.rows.length < leak.total ? ` (showing ${leak.rows.length})` : ""}`
                : "Stuck PASS records — no employer-visible snapshot"
            }
          >
            {leak && leak.rows.length > 0 ? (
              <div style={ladderTableWrap}>
                <table style={ladderTable}>
                  <thead>
                    <tr>
                      <th style={thLeft}>User</th>
                      <th style={thLeft}>Job</th>
                      <th style={thLeft}>State</th>
                      <th style={thLeft}>Prescreen session</th>
                      <th style={thRight}>Passed at</th>
                    </tr>
                  </thead>
                  <tbody>
                    {leak.rows.map((r) => (
                      <tr key={`${r.userId}__${r.jobId}`}>
                        <td style={tdMono}>{r.userId}</td>
                        <td style={tdMono}>{r.jobId}</td>
                        <td style={tdLeft}>{STATE_LABELS[r.state] ?? r.state}</td>
                        <td style={tdMono}>{r.prescreenSessionId ?? "—"}</td>
                        <td style={tdRight}>{r.passedAt ? r.passedAt.slice(0, 10) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p style={emptyNote}>No stuck PASS records — every passed candidate has an employer-visible snapshot.</p>
            )}
          </Panel>
        </>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Inline styles (match the dashboard's neutral token palette)
// ---------------------------------------------------------------------------

const axisTick = { fontSize: 11, fill: "var(--ink-3, #6b7280)" }

const checkboxLabel: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontSize: 13,
  color: "var(--ink-2, #374151)",
}
const statsRow: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
  gap: 12,
  marginBottom: 4,
}
const statCard: CSSProperties = {
  border: "1px solid var(--line, #e5e7eb)",
  borderRadius: 10,
  padding: "12px 14px",
  background: "var(--surface, #fff)",
}
const statLabel: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--ink-3, #6b7280)",
  marginBottom: 6,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
}
const statValue: CSSProperties = { fontSize: 24, fontWeight: 700, color: "var(--ink-1, #111827)" }
const warnBanner: CSSProperties = {
  border: "1px solid #fcd34d",
  background: "#fffbeb",
  color: "#92400e",
  borderRadius: 8,
  padding: "8px 12px",
  fontSize: 13,
  marginBottom: 16,
}
const ladderTableWrap: CSSProperties = { marginTop: 16, overflowX: "auto" }
const ladderTable: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 13,
}
const thBase: CSSProperties = {
  padding: "8px 10px",
  borderBottom: "1px solid var(--line, #e5e7eb)",
  fontSize: 11,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--ink-3, #6b7280)",
  fontWeight: 600,
}
const thLeft: CSSProperties = { ...thBase, textAlign: "left" }
const thRight: CSSProperties = { ...thBase, textAlign: "right" }
const tdBase: CSSProperties = {
  padding: "8px 10px",
  borderBottom: "1px solid var(--line, #f3f4f6)",
  color: "var(--ink-1, #111827)",
}
const tdLeft: CSSProperties = { ...tdBase, textAlign: "left" }
const tdRight: CSSProperties = { ...tdBase, textAlign: "right", fontVariantNumeric: "tabular-nums" }
const tdMono: CSSProperties = {
  ...tdBase,
  textAlign: "left",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 12,
}
const emptyNote: CSSProperties = { fontSize: 13, color: "var(--ink-3, #6b7280)", margin: 0 }
