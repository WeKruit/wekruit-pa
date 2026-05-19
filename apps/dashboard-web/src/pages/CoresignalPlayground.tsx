/**
 * `/admin/coresignal-playground` — interactive Coresignal Agentic Search.
 *
 * Calls `paAdminCoresignalAgenticSearch` (admin-only CF) which proxies to
 * Coresignal's /v2/agentic_search/reasoning endpoint. Results render the
 * reasoning trace + the data array (when return_data=true) + raw JSON.
 *
 * Local prompt history persists to localStorage so the operator can replay
 * recent queries without losing the working set on refresh.
 */
import { useEffect, useMemo, useState } from "react"
import { httpsCallable } from "firebase/functions"

import { functions } from "../lib/firebase.js"
import {
  EmptyState,
  ErrorState,
  PageHeader,
  Panel,
} from "../components/ui.js"

const CALLABLE = "paAdminCoresignalAgenticSearch"
const HISTORY_KEY = "coresignal-playground-history-v1"
const MAX_HISTORY = 15

interface CoresignalInput {
  prompt: string
  returnData: boolean
  allowClarification: boolean
  sessionId?: string
  limit: number
}

interface CoresignalRow {
  id?: string | number
  _score?: number
  full_name?: string
  linkedin_url?: string
  professional_network_url?: string
  headline?: string
  location_full?: string
  location_country?: string
  connections_count?: number
  followers_count?: number
  active_experience_title?: string
  company_name?: string
  company_industry?: string
  [key: string]: unknown
}

interface CoresignalResponseShape {
  reason?: string
  data?: CoresignalRow[]
  session_id?: string
  [key: string]: unknown
}

interface CoresignalCallResult {
  ok: true
  sessionId: string
  latencyMs: number
  runId: string
  request: CoresignalInput
  response: CoresignalResponseShape
}

interface HistoryEntry {
  runId: string
  prompt: string
  returnData: boolean
  limit: number
  ranAt: string
  latencyMs: number
  rowCount: number
}

function loadHistory(): HistoryEntry[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as HistoryEntry[]) : []
  } catch {
    return []
  }
}

function saveHistory(entries: HistoryEntry[]) {
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, MAX_HISTORY)))
  } catch {
    /* quota — ignore */
  }
}

const SAMPLE_PROMPTS = [
  "Find software engineers in San Francisco who recently left Stripe",
  "Find founders or co-founders who previously held engineering roles at Google, Meta, or Apple",
  "Show me senior PMs at YC-backed AI startups in NYC",
  "Find designers who worked at Figma or Linear and now lead design at smaller companies",
]

export default function CoresignalPlayground() {
  const [prompt, setPrompt] = useState("")
  const [returnData, setReturnData] = useState(true)
  const [allowClarification, setAllowClarification] = useState(false)
  const [sessionId, setSessionId] = useState("")
  const [limit, setLimit] = useState(5)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<CoresignalCallResult | null>(null)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [showRaw, setShowRaw] = useState(false)

  useEffect(() => {
    setHistory(loadHistory())
  }, [])

  async function run() {
    if (loading) return
    const trimmed = prompt.trim()
    if (!trimmed) {
      setError("Prompt is required")
      return
    }
    setError(null)
    setLoading(true)
    try {
      const fn = httpsCallable<CoresignalInput, CoresignalCallResult>(functions(), CALLABLE)
      const payload: CoresignalInput = {
        prompt: trimmed,
        returnData,
        allowClarification,
        limit,
      }
      if (sessionId.trim()) payload.sessionId = sessionId.trim()
      const res = await fn(payload)
      const data = res.data
      setResult(data)
      setSessionId(data.sessionId)
      const entry: HistoryEntry = {
        runId: data.runId,
        prompt: trimmed,
        returnData,
        limit,
        ranAt: new Date().toISOString(),
        latencyMs: data.latencyMs,
        rowCount: Array.isArray(data.response.data) ? data.response.data.length : 0,
      }
      const next = [entry, ...history.filter((h) => h.runId !== entry.runId)].slice(0, MAX_HISTORY)
      setHistory(next)
      saveHistory(next)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
    } finally {
      setLoading(false)
    }
  }

  const rows = useMemo<CoresignalRow[]>(() => {
    if (!result?.response?.data || !Array.isArray(result.response.data)) return []
    return result.response.data
  }, [result])

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: 16 }}>
      <PageHeader
        title="Coresignal · Agentic Search"
        description="Live playground for Coresignal's /v2/agentic_search/reasoning endpoint. Ask in natural language; the engine returns its reasoning trace plus matched profiles."
      />

      <Panel>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-2, #555)" }}>
            Prompt
          </label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. Find staff engineers in NYC who left Google in the last 6 months"
            rows={4}
            style={{
              width: "100%",
              padding: 12,
              fontFamily: "inherit",
              fontSize: 14,
              border: "1.5px solid var(--border, #ccc)",
              borderRadius: 8,
              boxSizing: "border-box",
              resize: "vertical",
            }}
          />

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {SAMPLE_PROMPTS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPrompt(p)}
                style={{
                  fontSize: 11,
                  padding: "4px 10px",
                  borderRadius: 999,
                  border: "1px solid var(--border, #ddd)",
                  background: "#fff",
                  cursor: "pointer",
                  color: "var(--ink-2, #555)",
                }}
              >
                {p.length > 70 ? `${p.slice(0, 70)}…` : p}
              </button>
            ))}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
            <Field label="return_data">
              <Toggle
                checked={returnData}
                onChange={setReturnData}
                onLabel="profiles"
                offLabel="Elasticsearch DSL"
              />
            </Field>
            <Field label="allow_clarification">
              <Toggle
                checked={allowClarification}
                onChange={setAllowClarification}
                onLabel="ask follow-up"
                offLabel="execute"
              />
            </Field>
            <Field label="limit">
              <input
                type="number"
                min={1}
                max={100}
                value={limit}
                onChange={(e) => setLimit(Math.max(1, Math.min(100, Number(e.target.value) || 1)))}
                style={inputStyle}
              />
            </Field>
            <Field label="session_id (continue session)">
              <input
                type="text"
                value={sessionId}
                onChange={(e) => setSessionId(e.target.value)}
                placeholder="auto-generated when empty"
                style={inputStyle}
              />
            </Field>
          </div>

          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              type="button"
              onClick={run}
              disabled={loading || !prompt.trim()}
              style={{
                padding: "10px 18px",
                background: loading ? "#888" : "var(--ink-1, #222)",
                color: "#fff",
                border: "none",
                borderRadius: 8,
                cursor: loading ? "wait" : "pointer",
                fontWeight: 600,
                fontSize: 14,
              }}
            >
              {loading ? "Searching… (10-60s)" : "Run search"}
            </button>
            <button
              type="button"
              onClick={() => {
                setPrompt("")
                setResult(null)
                setError(null)
                setSessionId("")
              }}
              disabled={loading}
              style={{
                padding: "10px 14px",
                background: "transparent",
                color: "var(--ink-2, #555)",
                border: "1px solid var(--border, #ddd)",
                borderRadius: 8,
                cursor: "pointer",
              }}
            >
              Reset
            </button>
            {result && (
              <span style={{ fontSize: 12, color: "var(--ink-3, #888)" }}>
                {result.latencyMs}ms · session {result.sessionId.slice(0, 8)}…
              </span>
            )}
          </div>
        </div>
      </Panel>

      {error && <ErrorState message={error} />}

      {result?.response.reason && (
        <Panel>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-2, #555)", textTransform: "uppercase", letterSpacing: 0.5 }}>
              Reasoning
            </div>
            <div style={{ fontSize: 14, lineHeight: 1.6, color: "var(--ink-1, #222)" }}>
              {result.response.reason}
            </div>
          </div>
        </Panel>
      )}

      {result && rows.length > 0 && (
        <Panel>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-1, #222)" }}>
                {rows.length} profile{rows.length === 1 ? "" : "s"}
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {rows.map((row, idx) => (
                <ProfileCard key={`${row.id ?? idx}`} row={row} />
              ))}
            </div>
          </div>
        </Panel>
      )}

      {result && rows.length === 0 && returnData && (
        <EmptyState title="No profiles returned" body="The reasoning above explains how the engine interpreted the query — try widening the criteria." />
      )}

      {result && !returnData && (
        <Panel>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-2, #555)", textTransform: "uppercase", letterSpacing: 0.5 }}>
              Elasticsearch DSL (return_data = false)
            </div>
            <pre style={preStyle}>{JSON.stringify(result.response, null, 2)}</pre>
          </div>
        </Panel>
      )}

      {result && (
        <Panel>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-2, #555)", textTransform: "uppercase", letterSpacing: 0.5 }}>
              Raw response
            </div>
            <button
              type="button"
              onClick={() => setShowRaw((v) => !v)}
              style={{
                fontSize: 11,
                padding: "4px 10px",
                borderRadius: 6,
                border: "1px solid var(--border, #ddd)",
                background: "#fff",
                cursor: "pointer",
              }}
            >
              {showRaw ? "Hide" : "Show"}
            </button>
          </div>
          {showRaw && <pre style={preStyle}>{JSON.stringify(result, null, 2)}</pre>}
        </Panel>
      )}

      {history.length > 0 && (
        <Panel>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-2, #555)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>
            Recent prompts
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {history.map((h) => (
              <button
                key={h.runId}
                type="button"
                onClick={() => {
                  setPrompt(h.prompt)
                  setReturnData(h.returnData)
                  setLimit(h.limit)
                }}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  padding: "8px 12px",
                  background: "#fff",
                  border: "1px solid var(--border, #eee)",
                  borderRadius: 6,
                  cursor: "pointer",
                  textAlign: "left",
                  fontFamily: "inherit",
                  fontSize: 13,
                }}
              >
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--ink-1, #222)" }}>
                  {h.prompt}
                </span>
                <span style={{ color: "var(--ink-3, #888)", fontSize: 11, whiteSpace: "nowrap" }}>
                  {h.rowCount} rows · {h.latencyMs}ms · {h.ranAt.slice(11, 16)}
                </span>
              </button>
            ))}
          </div>
        </Panel>
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-2, #555)", textTransform: "uppercase", letterSpacing: 0.5 }}>
        {label}
      </label>
      {children}
    </div>
  )
}

function Toggle({
  checked,
  onChange,
  onLabel,
  offLabel,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  onLabel: string
  offLabel: string
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      style={{
        padding: "8px 12px",
        background: checked ? "var(--ink-1, #222)" : "#fff",
        color: checked ? "#fff" : "var(--ink-2, #555)",
        border: "1.5px solid var(--border, #ccc)",
        borderRadius: 8,
        cursor: "pointer",
        fontWeight: 500,
        fontSize: 13,
        textAlign: "left",
      }}
    >
      {checked ? `✓ ${onLabel}` : offLabel}
    </button>
  )
}

function ProfileCard({ row }: { row: CoresignalRow }) {
  const url = row.linkedin_url ?? row.professional_network_url
  const name = row.full_name ?? "Unknown"
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: 12,
        border: "1px solid var(--border, #eee)",
        borderRadius: 8,
        background: "#fff",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 15, fontWeight: 600, color: "var(--ink-1, #222)", textDecoration: "underline" }}
            >
              {name}
            </a>
          ) : (
            <span style={{ fontSize: 15, fontWeight: 600, color: "var(--ink-1, #222)" }}>{name}</span>
          )}
          {typeof row._score === "number" && (
            <span style={{ fontSize: 11, color: "var(--ink-3, #888)" }}>score {row._score.toFixed(2)}</span>
          )}
        </div>
        <span style={{ fontSize: 11, color: "var(--ink-3, #888)" }}>{row.location_full ?? row.location_country ?? ""}</span>
      </div>
      {row.headline && (
        <div style={{ fontSize: 13, color: "var(--ink-2, #555)" }}>{row.headline}</div>
      )}
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12, color: "var(--ink-3, #888)" }}>
        {row.active_experience_title && row.company_name && (
          <span>
            <strong style={{ color: "var(--ink-2, #555)" }}>{row.active_experience_title}</strong> at {row.company_name}
          </span>
        )}
        {row.company_industry && <span>{row.company_industry}</span>}
        {typeof row.followers_count === "number" && row.followers_count > 0 && (
          <span>{row.followers_count.toLocaleString()} followers</span>
        )}
        {typeof row.connections_count === "number" && row.connections_count > 0 && (
          <span>{row.connections_count.toLocaleString()}+ connections</span>
        )}
      </div>
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  fontFamily: "inherit",
  fontSize: 13,
  border: "1.5px solid var(--border, #ccc)",
  borderRadius: 6,
  boxSizing: "border-box",
}

const preStyle: React.CSSProperties = {
  background: "#0d1117",
  color: "#c9d1d9",
  padding: 12,
  borderRadius: 6,
  fontSize: 12,
  overflow: "auto",
  maxHeight: 480,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
}
