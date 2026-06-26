/**
 * `EnrichWithClaire` — advisory, non-destructive JD enrichment affordance shown
 * beside the descriptionMd textarea on the admin create-job / job-edit surface.
 *
 * Calls `paAdminIntakeJob` (which wraps the SAME runIntakeJob runner the Slack
 * agent's intake_job tool uses) and renders the canonical tags + draft prescreen
 * questions + clarifying questions inline. It persists NOTHING — the operator
 * reviews, can fold answers to the clarifying questions, and re-run to refine.
 */
import { useState, type CSSProperties } from "react"

import {
  runIntakeJobCallable,
  type IntakeJobResult,
  type IntakePrescreenQuestion,
} from "../lib/job-enrich-api.js"

export function EnrichWithClaire({
  title,
  descriptionMd,
  companyName,
  locationRaw,
}: {
  title?: string
  descriptionMd: string
  companyName?: string
  locationRaw?: string
}) {
  const [result, setResult] = useState<IntakeJobResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [answers, setAnswers] = useState("")

  const canRun = (descriptionMd ?? "").trim().length > 0

  async function run(): Promise<void> {
    setLoading(true)
    setError(null)
    try {
      const res = await runIntakeJobCallable({
        jobDescription: descriptionMd,
        title,
        companyName,
        locationRaw,
        answers,
      })
      setResult(res)
      if (res.error) setError(res.error)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={wrapStyle}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" onClick={() => void run()} disabled={loading || !canRun} style={enrichBtnStyle(loading || !canRun)}>
          {loading ? "Enriching…" : result ? "Re-enrich with Claire" : "Enrich with Claire"}
        </button>
        <span style={{ fontSize: "0.75em", color: "#64748b" }}>
          Advisory only — reuses the same enrichment the Slack agent runs. Nothing is saved.
        </span>
      </div>
      {!canRun ? (
        <div style={{ fontSize: "0.75em", color: "#94a3b8", marginTop: 6 }}>
          Add a job description above to enable enrichment.
        </div>
      ) : null}

      {error ? <div style={errorStyle}>{error}</div> : null}

      {result && !result.error ? (
        <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
          <div style={metaRowStyle}>
            <Pill>confidence {fmtPct(result.confidence)}</Pill>
            <Pill tone={result.approvalReady ? "ok" : "warn"}>
              {result.approvalReady ? "approval-ready" : "needs review"}
            </Pill>
            {result.modelUsed ? <Pill tone="muted">{result.modelUsed}</Pill> : null}
          </div>

          {result.clarifyingQuestions && result.clarifyingQuestions.length > 0 ? (
            <Section title={`Clarifying questions (${result.clarifyingQuestions.length})`}>
              <ul style={listStyle}>
                {result.clarifyingQuestions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
              <label style={{ display: "block", marginTop: 8 }}>
                <span style={{ fontSize: "0.75em", fontWeight: 600, color: "#475569" }}>
                  Fold the hiring team's answers here, then re-enrich:
                </span>
                <textarea
                  value={answers}
                  onChange={(e) => setAnswers(e.target.value)}
                  rows={3}
                  placeholder="e.g. Must-haves are React + TypeScript; senior level; remote-US; visa sponsorship not available."
                  style={answerStyle}
                />
              </label>
            </Section>
          ) : (
            <Section title="Clarifying questions">
              <div style={{ fontSize: "0.85em", color: "#16a34a" }}>
                High-confidence enrichment — no clarifying questions.
              </div>
            </Section>
          )}

          <Section title="Canonical tags">
            <TagsView tags={result.enrichedTags} />
          </Section>

          {result.prescreenQuestions && result.prescreenQuestions.length > 0 ? (
            <Section title={`Draft prescreen questions (${result.prescreenQuestions.length})`}>
              <ol style={{ ...listStyle, paddingLeft: 18 }}>
                {result.prescreenQuestions.map((q, i) => (
                  <li key={q.id ?? i} style={{ marginBottom: 6 }}>
                    {prescreenLabel(q)}
                  </li>
                ))}
              </ol>
            </Section>
          ) : null}

          {result.hardFilters ? (
            <Section title="Hard filters">
              <pre style={preStyle}>{JSON.stringify(result.hardFilters, null, 2)}</pre>
            </Section>
          ) : null}

          {result.note ? <div style={{ fontSize: "0.78em", color: "#64748b" }}>{result.note}</div> : null}
        </div>
      ) : null}
    </div>
  )
}

function prescreenLabel(q: IntakePrescreenQuestion): string {
  const prompt = typeof q.prompt === "string" ? q.prompt : typeof q.id === "string" ? q.id : "(question)"
  const bits: string[] = []
  if (q.type) bits.push(String(q.type))
  if (typeof q.weight === "number") bits.push(`w=${q.weight}`)
  if (q.gating) bits.push("gating")
  return bits.length > 0 ? `${prompt}  [${bits.join(" · ")}]` : prompt
}

function TagsView({ tags }: { tags?: Record<string, unknown> }) {
  if (!tags || Object.keys(tags).length === 0) {
    return <div style={{ fontSize: "0.85em", color: "#94a3b8" }}>No tags returned.</div>
  }
  const entries = Object.entries(tags).filter(([, v]) => {
    if (v == null) return false
    if (Array.isArray(v)) return v.length > 0
    return true
  })
  return (
    <dl style={tagsDl}>
      {entries.map(([k, v]) => (
        <div key={k} style={{ display: "contents" }}>
          <dt style={tagsDt}>{k}</dt>
          <dd style={tagsDd}>{Array.isArray(v) ? v.join(", ") : String(v)}</dd>
        </div>
      ))}
    </dl>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: "0.78em", fontWeight: 700, color: "#334155", marginBottom: 4 }}>{title}</div>
      {children}
    </div>
  )
}

function Pill({ children, tone = "info" }: { children: React.ReactNode; tone?: "info" | "ok" | "warn" | "muted" }) {
  const map: Record<string, CSSProperties> = {
    info: { background: "#e8f0fe", color: "#174ea6" },
    ok: { background: "#dcfce7", color: "#166534" },
    warn: { background: "#fef3c7", color: "#92400e" },
    muted: { background: "#f1f5f9", color: "#475569" },
  }
  return <span style={{ ...pillBase, ...map[tone] }}>{children}</span>
}

function fmtPct(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—"
  return `${Math.round(value * 100)}%`
}

const wrapStyle: CSSProperties = {
  marginTop: 8,
  padding: 12,
  border: "1px dashed #cbd5e1",
  borderRadius: 6,
  background: "#f8fafc",
}
const enrichBtnStyle = (disabled: boolean): CSSProperties => ({
  background: disabled ? "#94a3b8" : "#7c3aed",
  color: "white",
  border: "none",
  padding: "0.45rem 1rem",
  borderRadius: 4,
  cursor: disabled ? "not-allowed" : "pointer",
  fontWeight: 600,
  fontSize: "0.85em",
})
const errorStyle: CSSProperties = {
  marginTop: 8,
  color: "#b91c1c",
  fontSize: "0.82em",
  background: "#fef2f2",
  border: "1px solid #fecaca",
  borderRadius: 4,
  padding: "6px 8px",
}
const metaRowStyle: CSSProperties = { display: "flex", gap: 6, flexWrap: "wrap" }
const pillBase: CSSProperties = { borderRadius: 999, padding: "0.15rem 0.5rem", fontSize: 11, fontWeight: 700 }
const listStyle: CSSProperties = { margin: 0, paddingLeft: 18, fontSize: "0.85em", color: "#334155" }
const answerStyle: CSSProperties = {
  width: "100%",
  marginTop: 4,
  padding: "0.4rem 0.6rem",
  border: "1px solid #cbd5e1",
  borderRadius: 4,
  fontSize: "0.82em",
}
const tagsDl: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "180px 1fr",
  gap: "4px 12px",
  fontSize: "0.82em",
  margin: 0,
}
const tagsDt: CSSProperties = { fontWeight: 600, color: "#475569" }
const tagsDd: CSSProperties = { margin: 0, color: "#0f172a" }
const preStyle: CSSProperties = {
  background: "#0f172a",
  color: "#e2e8f0",
  borderRadius: 6,
  padding: 10,
  overflowX: "auto",
  fontSize: "0.75em",
  margin: 0,
}
