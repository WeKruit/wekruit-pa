import { useEffect, useMemo, useState, type CSSProperties } from "react"
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { ErrorState, LoadingState, PageHeader, Panel } from "../components/ui.js"
import {
  GRANULARITY_OPTIONS,
  RANGE_OPTIONS,
  getOpsMetrics,
  rollup,
  type AdminOpsMetricsResult,
  type Granularity,
} from "../lib/operations-overview-api.js"

const COLORS = {
  authenticated: "#2563eb",
  recruiterSubmitted: "#7c3aed",
  direct: "#0d9488",
  conducted: "#2563eb",
  prescreens: "#0891b2",
  movedToClient: "#d97706",
}

type Loader = (input: { rangeDays: number; includeTest: boolean }) => Promise<AdminOpsMetricsResult>

function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div style={segWrap}>
      {options.map((opt) => {
        const active = opt.value === value
        return (
          <button
            key={String(opt.value)}
            type="button"
            onClick={() => onChange(opt.value)}
            style={{ ...segBtn, ...(active ? segBtnActive : null) }}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

function StatCard({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div style={statCard}>
      <div style={{ ...statLabel, ...(color ? { color } : null) }}>{label}</div>
      <div style={statValue}>{value.toLocaleString()}</div>
    </div>
  )
}

export default function OperationsOverview({ loadMetrics = getOpsMetrics }: { loadMetrics?: Loader }) {
  const [rangeDays, setRangeDays] = useState<number>(90)
  const [granularity, setGranularity] = useState<Granularity>("weekly")
  const [includeTest, setIncludeTest] = useState(false)
  const [data, setData] = useState<AdminOpsMetricsResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void loadMetrics({ rangeDays, includeTest })
      .then((res) => {
        if (!cancelled) setData(res)
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
  }, [rangeDays, includeTest, loadMetrics])

  const rolled = useMemo(() => (data ? rollup(data.days, granularity) : []), [data, granularity])
  const truncatedHit = data ? Object.values(data.truncated).some(Boolean) : false

  return (
    <div>
      <PageHeader
        eyebrow="Operations"
        title="Operations overview"
        description="New users (by channel), interviews conducted, and candidates moved to client — over time."
        actions={
          <label style={checkboxLabel}>
            <input type="checkbox" checked={includeTest} onChange={(e) => setIncludeTest(e.target.checked)} />
            Include test accounts
          </label>
        }
      />

      <div style={controlsRow}>
        <div style={controlGroup}>
          <span style={controlLabel}>Range</span>
          <Segmented value={rangeDays} options={RANGE_OPTIONS} onChange={setRangeDays} />
        </div>
        <div style={controlGroup}>
          <span style={controlLabel}>Granularity</span>
          <Segmented value={granularity} options={GRANULARITY_OPTIONS} onChange={setGranularity} />
        </div>
      </div>

      {error ? <ErrorState message={error} /> : null}
      {loading && !data ? <LoadingState label="Loading metrics…" /> : null}

      {data ? (
        <>
          {truncatedHit ? (
            <div style={warnBanner}>
              Some sources hit the per-collection scan cap — counts may undercount the oldest part of the range.
            </div>
          ) : null}

          <div style={statsRow}>
            <StatCard label="New users" value={data.totals.newUsersTotal} />
            <StatCard label="· Authenticated" value={data.totals.newUsersAuthenticated} color={COLORS.authenticated} />
            <StatCard label="· Recruiter-submitted" value={data.totals.newUsersRecruiterSubmitted} color={COLORS.recruiterSubmitted} />
            <StatCard label="· Direct" value={data.totals.newUsersDirect} color={COLORS.direct} />
            <StatCard label="WeKruit interviews" value={data.totals.interviewsConducted} color={COLORS.conducted} />
            <StatCard label="Prescreens conducted" value={data.totals.prescreensConducted} color={COLORS.prescreens} />
            <StatCard label="Moved to client" value={data.totals.movedToClient} color={COLORS.movedToClient} />
          </div>

          <Panel title="New users by channel" eyebrow="Authenticated + recruiter-submitted + direct, deduped by person">
            <div style={{ width: "100%", height: 320 }}>
              <ResponsiveContainer>
                <BarChart data={rolled} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--line, #e5e7eb)" />
                  <XAxis dataKey="label" tick={axisTick} interval="preserveStartEnd" minTickGap={24} />
                  <YAxis tick={axisTick} allowDecimals={false} width={36} />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="newUsersAuthenticated" name="Authenticated" stackId="u" fill={COLORS.authenticated} />
                  <Bar dataKey="newUsersRecruiterSubmitted" name="Recruiter-submitted" stackId="u" fill={COLORS.recruiterSubmitted} />
                  <Bar dataKey="newUsersDirect" name="Direct" stackId="u" fill={COLORS.direct} radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Panel>

          <Panel title="Interviews" eyebrow="Prescreens · WeKruit interviews · candidates moved to client">
            <div style={{ width: "100%", height: 320 }}>
              <ResponsiveContainer>
                <LineChart data={rolled} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--line, #e5e7eb)" />
                  <XAxis dataKey="label" tick={axisTick} interval="preserveStartEnd" minTickGap={24} />
                  <YAxis tick={axisTick} allowDecimals={false} width={36} />
                  <Tooltip />
                  <Legend />
                  <Line type="monotone" dataKey="prescreensConducted" name="Prescreens conducted" stroke={COLORS.prescreens} strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="interviewsConducted" name="WeKruit interviews" stroke={COLORS.conducted} strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="movedToClient" name="Moved to client" stroke={COLORS.movedToClient} strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
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

const controlsRow: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 24,
  marginBottom: 16,
}
const controlGroup: CSSProperties = { display: "flex", alignItems: "center", gap: 10 }
const controlLabel: CSSProperties = {
  fontSize: 11,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  fontWeight: 600,
  color: "var(--ink-3, #6b7280)",
}
const segWrap: CSSProperties = {
  display: "inline-flex",
  border: "1px solid var(--line, #e5e7eb)",
  borderRadius: 8,
  overflow: "hidden",
  background: "var(--surface, #fff)",
}
const segBtn: CSSProperties = {
  padding: "6px 12px",
  fontSize: 13,
  border: "none",
  background: "transparent",
  cursor: "pointer",
  color: "var(--ink-2, #374151)",
}
const segBtnActive: CSSProperties = {
  background: "var(--ink-1, #111827)",
  color: "#fff",
}
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
  marginBottom: 20,
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
