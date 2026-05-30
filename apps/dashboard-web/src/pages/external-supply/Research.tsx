/**
 * v2.0 External Supply V1 — Wave D — `/admin/external-supply/research`.
 *
 * Agent research workbench. Three states per task:
 *   draft_prompt -> prompt_copied -> result_imported -> approved/rejected.
 *
 * UI:
 *  - Left column: list of `pa-agent-research-tasks` filtered by status.
 *  - Right column: selected task — show prompt + copy button + paste-back
 *    textarea + parse preview + per-finding approve/reject buttons.
 */
import { useEffect, useMemo, useState } from "react"
import { useSearchParams } from "react-router-dom"
import type { AgentResearchTask } from "@pa/core-types"
import { AdminUserLink } from "../../components/AdminEntityLink.js"
import { EmptyState, ErrorState, LoadingState, PageHeader, Panel } from "../../components/ui.js"
import {
  approveAgentResearchFinding,
  getAgentResearchTask,
  importAgentResearchResult,
  listAgentResearchTasks,
} from "../../lib/external-supply-client.js"

const STATUS_FILTERS: Array<{ key: "all" | AgentResearchTask["reviewStatus"]; label: string }> = [
  { key: "all", label: "All" },
  { key: "draft_prompt", label: "Draft" },
  { key: "prompt_copied", label: "Prompt copied" },
  { key: "result_imported", label: "Result imported" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
]

export function Research() {
  const [searchParams] = useSearchParams()
  const [tasks, setTasks] = useState<AgentResearchTask[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<"all" | AgentResearchTask["reviewStatus"]>("all")
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [selectedTask, setSelectedTask] = useState<AgentResearchTask | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [importDraft, setImportDraft] = useState("")
  const [importBusy, setImportBusy] = useState(false)
  const [findingBusyId, setFindingBusyId] = useState<string | null>(null)
  const [actionMsg, setActionMsg] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    listAgentResearchTasks({
      reviewStatus: filter === "all" ? undefined : filter,
      limit: 100,
    })
      .then((res) => {
        if (!cancelled) setTasks(res.rows)
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
  }, [filter, refreshKey])

  // Honor ?taskId=… deep link.
  useEffect(() => {
    const fromUrl = searchParams.get("taskId")
    if (fromUrl) setSelectedTaskId(fromUrl)
  }, [searchParams])

  useEffect(() => {
    if (!selectedTaskId) {
      setSelectedTask(null)
      setImportDraft("")
      return
    }
    let cancelled = false
    getAgentResearchTask(selectedTaskId)
      .then((t) => {
        if (cancelled) return
        setSelectedTask(t)
        setImportDraft(t?.rawResult ?? "")
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [selectedTaskId, refreshKey])

  async function copyPrompt() {
    if (!selectedTask) return
    try {
      await navigator.clipboard.writeText(selectedTask.prompt)
      setActionMsg("Prompt copied to clipboard.")
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : String(e))
    }
  }

  async function doImport() {
    if (!selectedTask) return
    if (!importDraft.trim()) {
      setActionMsg("Paste the agent's result first.")
      return
    }
    setImportBusy(true)
    setActionMsg(null)
    try {
      const res = await importAgentResearchResult({
        taskId: selectedTask.taskId,
        rawResult: importDraft,
      })
      setActionMsg(
        `Imported · parsed=${res.parsedCount} errors=${res.parseErrorCount}${res.schemaVersionMismatch ? " · schema mismatch" : ""}`,
      )
      setRefreshKey((n) => n + 1)
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setImportBusy(false)
    }
  }

  async function decideFinding(findingId: string, approved: boolean) {
    if (!selectedTask) return
    setFindingBusyId(findingId)
    setActionMsg(null)
    try {
      const res = await approveAgentResearchFinding({
        taskId: selectedTask.taskId,
        findingId,
        approved,
      })
      setActionMsg(
        `Finding ${approved ? "approved" : "rejected"} · task status=${res.reviewStatus}`,
      )
      setRefreshKey((n) => n + 1)
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setFindingBusyId(null)
    }
  }

  const filteredTasks = useMemo(() => tasks, [tasks])

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="v2.0 External Supply V1 / Admin"
        title="Agent research"
        description="Copy-paste flow with ChatGPT Agent Mode. Generate the prompt from an evaluation, paste back the JSON result, then approve findings. Approvals attach to the task as audit evidence."
        actions={
          <button type="button" onClick={() => setRefreshKey((n) => n + 1)} style={secondaryBtnStyle}>
            Refresh
          </button>
        }
      />

      <Panel title="Filter" eyebrow="reviewStatus">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {STATUS_FILTERS.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setFilter(s.key)}
              style={s.key === filter ? activeFilterBtn : inactiveFilterBtn}
            >
              {s.label}
            </button>
          ))}
        </div>
      </Panel>

      {error && <ErrorState message={error} />}
      {actionMsg && <div className="notice notice-bad" style={{ fontSize: "0.85em" }}>{actionMsg}</div>}

      <div style={twoColStyle}>
        <Panel title="Tasks" eyebrow="pa-agent-research-tasks">
          {loading && filteredTasks.length === 0 ? (
            <LoadingState label="Loading tasks…" />
          ) : filteredTasks.length === 0 ? (
            <EmptyState
              title="No tasks"
              body="Generate a prompt from an evaluation run to seed the first task."
            />
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 4 }}>
              {filteredTasks.map((t) => (
                <li key={t.taskId}>
                  <button
                    type="button"
                    onClick={() => setSelectedTaskId(t.taskId)}
                    style={t.taskId === selectedTaskId ? activeTaskBtn : inactiveTaskBtn}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <strong style={{ fontSize: "0.85em" }}>
                        {t.taskId.slice(0, 8)}…
                      </strong>
                      <span className={`status-badge ${statusTone(t.reviewStatus)}`}>{t.reviewStatus}</span>
                    </div>
                    <div style={{ fontSize: "0.75em", color: "#64748b" }}>
                      {t.candidateIds.length} candidates · {t.createdAt.slice(0, 16).replace("T", " ")}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title={selectedTask ? `Task ${selectedTask.taskId.slice(0, 8)}…` : "Select a task"}
          eyebrow={selectedTask?.promptVersion ?? ""}
        >
          {!selectedTask ? (
            <EmptyState
              title="No task selected"
              body="Pick a task from the list on the left."
            />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <details>
                <summary style={{ cursor: "pointer", fontWeight: 600 }}>
                  Prompt (paste into ChatGPT Agent Mode)
                </summary>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                  <button type="button" onClick={copyPrompt} style={secondaryBtnStyle}>
                    Copy prompt
                  </button>
                  <span style={{ fontSize: "0.75em", color: "#64748b" }}>
                    expected schema: {selectedTask.expectedJsonSchemaVersion}
                  </span>
                </div>
                <pre style={preStyle}>{selectedTask.prompt}</pre>
              </details>

              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: "0.85em", fontWeight: 600 }}>Paste agent result (raw JSON)</span>
                <textarea
                  value={importDraft}
                  onChange={(e) => setImportDraft(e.target.value)}
                  rows={10}
                  style={textareaStyle}
                />
                <div>
                  <button
                    type="button"
                    onClick={doImport}
                    disabled={importBusy}
                    style={primaryBtnStyle}
                  >
                    {importBusy ? "Importing…" : "Import + parse"}
                  </button>
                </div>
              </label>

              {selectedTask.parseErrors && selectedTask.parseErrors.length > 0 && (
                <div style={{ background: "#fee2e2", border: "1px solid #fca5a5", padding: 8, borderRadius: 4 }}>
                  <strong style={{ fontSize: "0.85em" }}>Parse errors ({selectedTask.parseErrors.length})</strong>
                  <ul style={{ fontSize: "0.8em", margin: "4px 0", paddingLeft: 16 }}>
                    {selectedTask.parseErrors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </div>
              )}

              {selectedTask.parsedFindings && selectedTask.parsedFindings.length > 0 && (
                <Panel title={`Findings (${selectedTask.parsedFindings.length})`} eyebrow="parsed agent output">
                  <table style={tableStyle}>
                    <thead>
                      <tr style={{ borderBottom: "1px solid #e2e8f0", textAlign: "left" }}>
                        <th style={thStyle}>Candidate</th>
                        <th style={thStyle}>Field</th>
                        <th style={thStyle}>Value</th>
                        <th style={thStyle}>Confidence</th>
                        <th style={thStyle}>Approved</th>
                        <th style={thStyle} />
                      </tr>
                    </thead>
                    <tbody>
                      {selectedTask.parsedFindings.map((f) => (
                        <tr key={f.findingId} style={{ borderBottom: "1px solid #f1f5f9" }}>
                          <td style={{ ...tdStyle, fontFamily: "monospace", fontSize: "0.8em" }}>
                            <AdminUserLink userId={f.candidateId}>{f.candidateId.slice(0, 8)}…</AdminUserLink>
                          </td>
                          <td style={tdStyle}>{f.field}</td>
                          <td style={{ ...tdStyle, fontSize: "0.8em", maxWidth: 240 }}>
                            {stringifyValue(f.value)}
                          </td>
                          <td style={tdStyle}>{f.confidence.toFixed(2)}</td>
                          <td style={tdStyle}>
                            {f.approvedBy ? (
                              <span className={`status-badge ${f.approved ? "good" : "bad"}`}>
                                {f.approved ? "approved" : "rejected"}
                              </span>
                            ) : (
                              <span style={{ color: "#94a3b8" }}>pending</span>
                            )}
                          </td>
                          <td style={tdStyle}>
                            <div style={{ display: "flex", gap: 4 }}>
                              <button
                                type="button"
                                disabled={findingBusyId === f.findingId}
                                onClick={() => decideFinding(f.findingId, true)}
                                style={smallGreenBtn}
                              >
                                Approve
                              </button>
                              <button
                                type="button"
                                disabled={findingBusyId === f.findingId}
                                onClick={() => decideFinding(f.findingId, false)}
                                style={smallRedBtn}
                              >
                                Reject
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Panel>
              )}
            </div>
          )}
        </Panel>
      </div>
    </div>
  )
}

function statusTone(s: AgentResearchTask["reviewStatus"]): string {
  if (s === "approved") return "good"
  if (s === "rejected") return "bad"
  if (s === "result_imported") return "warn"
  return "muted"
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return "—"
  if (typeof value === "string") return value
  try {
    const s = JSON.stringify(value)
    return s.length > 120 ? `${s.slice(0, 119)}…` : s
  } catch {
    return String(value)
  }
}

const twoColStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "300px 1fr",
  gap: 12,
}

const tableStyle: React.CSSProperties = {
  width: "100%",
  fontSize: "0.85em",
  borderCollapse: "collapse",
}
const thStyle: React.CSSProperties = { padding: "0.5rem 0" }
const tdStyle: React.CSSProperties = { padding: "0.4rem 0" }

const preStyle: React.CSSProperties = {
  background: "#f8fafc",
  padding: "0.75rem",
  borderRadius: 4,
  fontSize: "0.75em",
  overflowX: "auto",
  maxHeight: 360,
  whiteSpace: "pre-wrap",
  marginTop: 8,
}

const textareaStyle: React.CSSProperties = {
  padding: "0.5rem 0.75rem",
  border: "1px solid #cbd5e1",
  borderRadius: 4,
  fontSize: "0.85em",
  fontFamily: "ui-monospace, SFMono-Regular, monospace",
  resize: "vertical",
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
  padding: "0.4rem 0.85rem",
  borderRadius: 4,
  fontSize: "0.85em",
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

const activeTaskBtn: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  background: "#eff6ff",
  border: "2px solid #1a73e8",
  borderRadius: 4,
  padding: "0.5rem 0.75rem",
  cursor: "pointer",
}

const inactiveTaskBtn: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 4,
  padding: "0.5rem 0.75rem",
  cursor: "pointer",
}

const smallGreenBtn: React.CSSProperties = {
  background: "#16a34a",
  color: "white",
  border: "none",
  padding: "2px 8px",
  borderRadius: 4,
  fontSize: "0.75em",
  cursor: "pointer",
}

const smallRedBtn: React.CSSProperties = {
  background: "#dc2626",
  color: "white",
  border: "none",
  padding: "2px 8px",
  borderRadius: 4,
  fontSize: "0.75em",
  cursor: "pointer",
}
