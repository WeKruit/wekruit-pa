/**
 * Phase 32 Wave 2c — NRoundSim page (split out of Voice.tsx).
 *
 * Pure LLM-vs-LLM N-round simulator. Persona dropdown + turns slider +
 * Run button. Live progress bar while running. History list reads from
 * `pa-sim-runs` collection (read-only); if the collection doesn't exist
 * yet the page renders an empty-state explaining it'll populate after
 * the first successful run.
 *
 * Wave 3 will swap the hardcoded persona list for `pa-personas` lookups.
 */
import { collection, getDocs, limit, orderBy, query } from "firebase/firestore"
import { useEffect, useState } from "react"
import { EmptyState, ErrorState, PageHeader, Panel } from "../components/ui.js"
import { db } from "../lib/firebase.js"

// Wave 3 will replace this with a dynamic load from `pa-personas`.
const FALLBACK_PERSONAS = [
  { key: "anxious_grad", label: "anxious grad (vent / spiral)" },
  { key: "formal_em", label: "formal EM (career update)" },
  { key: "vent_seeker", label: "vent seeker (ride-or-die)" },
] as const

type PersonaKey = string

const TURN_OPTIONS = [4, 8, 16] as const

type SimRun = {
  id: string
  persona?: string
  turns?: number
  startedAt?: string
  finishedAt?: string
  ok?: boolean
  error?: string
  transcript?: { role: string; body: string }[]
}

const SIM_RUNS_COLLECTION = "pa-sim-runs"

export function NRoundSim() {
  const [persona, setPersona] = useState<PersonaKey>(FALLBACK_PERSONAS[0].key)
  const [turns, setTurns] = useState<number>(8)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null)
  const [transcript, setTranscript] = useState<{ role: string; body: string }[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [history, setHistory] = useState<SimRun[] | null>(null)
  const [historyErr, setHistoryErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const snap = await getDocs(
          query(collection(db(), SIM_RUNS_COLLECTION), orderBy("startedAt", "desc"), limit(20))
        )
        if (cancelled) return
        setHistory(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as SimRun))
      } catch (e) {
        if (cancelled) return
        // Collection-missing → leave history null and show empty state with hint.
        setHistory([])
        setHistoryErr(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  async function runSim() {
    const token = window.prompt(
      `Run N-round simulation for persona "${persona}" (${turns} turns)?\n\nPaste PA_ADMIN_TOKEN (one-time, not stored):`
    )
    if (!token || !token.trim()) return
    setRunning(true)
    setErr(null)
    setTranscript([])
    setProgress({ current: 0, total: turns })
    try {
      const resp = await fetch(
        "https://paadminbootstrap-evm6xq7jyq-uc.a.run.app",
        {
          method: "POST",
          headers: {
            "x-admin-token": token.trim(),
            "content-type": "application/json",
          },
          body: JSON.stringify({ action: "simulateConversation", persona, turns }),
        }
      )
      const json = (await resp.json()) as {
        ok?: boolean
        processed?: number
        error?: string
        transcript?: { role: string; body: string }[]
      }
      if (!resp.ok || !json.ok) {
        setErr(json.error ?? `HTTP ${resp.status}`)
        setRunning(false)
        setProgress(null)
        return
      }
      setProgress({ current: json.processed ?? turns, total: turns })
      if (Array.isArray(json.transcript)) {
        setTranscript(json.transcript)
      }
      // Refresh history.
      try {
        const snap = await getDocs(
          query(collection(db(), SIM_RUNS_COLLECTION), orderBy("startedAt", "desc"), limit(20))
        )
        setHistory(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as SimRun))
      } catch {
        // Best-effort.
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
      // Leave progress at completed state for visibility.
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Eval"
        title="N-round simulation"
        description="Trigger LLM-vs-LLM rehearsals. Persona-LLM plays the user, the live agent replies. Transcripts append to pa-messages and pa-sim-runs."
      />

      <Panel title="Configure run">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, alignItems: "end" }}>
          <label style={{ fontSize: "0.85em", display: "block" }}>
            Persona
            <select
              value={persona}
              disabled={running}
              onChange={(e) => setPersona(e.target.value)}
              style={{ display: "block", width: "100%", marginTop: 4, padding: "6px 8px" }}
            >
              {FALLBACK_PERSONAS.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: "0.85em", display: "block" }}>
            Turns
            <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
              {TURN_OPTIONS.map((n) => (
                <button
                  key={n}
                  type="button"
                  disabled={running}
                  onClick={() => setTurns(n)}
                  style={{
                    flex: 1,
                    padding: "6px 8px",
                    fontSize: "0.9em",
                    background: turns === n ? "#0f172a" : "transparent",
                    color: turns === n ? "#fff" : "#0f172a",
                    border: "1px solid #cbd5e1",
                    borderRadius: 6,
                    cursor: "pointer",
                  }}
                >
                  {n}
                </button>
              ))}
            </div>
          </label>
        </div>
        <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 12 }}>
          <button type="button" disabled={running} onClick={() => void runSim()}>
            {running ? "Running…" : `▶ Run ${turns}-turn simulation`}
          </button>
          {progress ? (
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: "0.8em", color: "#64748b", marginBottom: 4 }}>
                Turn {progress.current}/{progress.total}
              </div>
              <div
                style={{
                  width: "100%",
                  height: 6,
                  background: "#e2e8f0",
                  borderRadius: 3,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${Math.min(100, (progress.current / Math.max(1, progress.total)) * 100)}%`,
                    height: "100%",
                    background: "#3b82f6",
                    transition: "width 200ms linear",
                  }}
                />
              </div>
            </div>
          ) : null}
        </div>
        {err ? <ErrorState message={err} /> : null}
      </Panel>

      <Panel title="Live transcript">
        {transcript.length === 0 ? (
          <EmptyState
            title="No transcript yet"
            body="Transcript appears here once a run completes. Past runs are listed below."
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {transcript.map((m, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  justifyContent: m.role === "user" ? "flex-end" : "flex-start",
                }}
              >
                <div
                  style={{
                    maxWidth: "78%",
                    background: m.role === "user" ? "#dbeafe" : "#f1f5f9",
                    border: "1px solid #cbd5e1",
                    borderRadius: 8,
                    padding: "0.45rem 0.7rem",
                    fontSize: "0.9em",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  <div
                    style={{
                      fontSize: "0.7em",
                      color: "#64748b",
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                      marginBottom: 2,
                    }}
                  >
                    {m.role}
                  </div>
                  {m.body}
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Past runs" eyebrow={SIM_RUNS_COLLECTION}>
        {history === null ? (
          <div style={{ color: "#64748b" }}>Loading…</div>
        ) : history.length === 0 ? (
          <EmptyState
            title="No simulation runs yet"
            body={
              historyErr
                ? `The pa-sim-runs collection has no documents yet (or the index is missing). It will populate after the first successful run.`
                : "Run a simulation above — the run record will appear here."
            }
          />
        ) : (
          <ul style={{ margin: 0, paddingLeft: "1.2rem", fontSize: "0.85em" }}>
            {history.map((r) => (
              <li key={r.id} style={{ marginBottom: 6 }}>
                <code>{r.persona ?? "?"}</code> · {r.turns ?? "?"} turns ·{" "}
                <span style={{ color: r.ok === false ? "#dc2626" : "#16a34a" }}>
                  {r.ok === false ? "failed" : "ok"}
                </span>
                {r.startedAt ? (
                  <> · <span style={{ color: "#64748b" }}>{r.startedAt.slice(0, 19).replace("T", " ")}</span></>
                ) : null}
                {r.error ? (
                  <div style={{ color: "#dc2626", fontSize: "0.8em", marginLeft: 8 }}>{r.error}</div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  )
}
