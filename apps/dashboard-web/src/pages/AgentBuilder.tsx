import { PA_COLLECTIONS } from "@pa/core-types"
import { addDoc, collection, deleteField, getDocs, updateDoc, doc, type Firestore } from "firebase/firestore"
import { FormEvent, useEffect, useState } from "react"
import { db } from "../lib/firebase.js"
import { fetchWorkerHealth, getWorkerHealthBaseUrl, type WorkerHealth } from "../lib/workerHealth.js"

type AgentRow = {
  id: string
  name: string
  systemPrompt: string
  provider: string
  model: string
  temperature: number
  memoryMode: string
  toolPolicy: string
  allowedConnectors: string
  toolBudgetPerTurn: number
  isDefault?: boolean
  status?: string
  personaTone?: string
  personaStyle?: string
  personaBoundaries?: string
  personaGoals?: string
}

const PROVIDERS = ["openai", "deepseek", "siliconflow", "azure_openai", "anthropic", "other"] as const
const MODES = ["firestore_only", "mem0", "both"] as const
const TOOL_POLICIES = ["none", "allowlist", "restricted"] as const

export function AgentBuilder() {
  const [rows, setRows] = useState<AgentRow[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [workerHealth, setWorkerHealth] = useState<WorkerHealth | null>(null)
  const [workerHealthErr, setWorkerHealthErr] = useState<string | null>(null)

  const fire = db() as Firestore
  const workerHealthUrl = getWorkerHealthBaseUrl()

  useEffect(() => {
    if (!workerHealthUrl) {
      setWorkerHealth(null)
      setWorkerHealthErr(null)
      return
    }
    let cancelled = false
    ;(async () => {
      const { health, err: he } = await fetchWorkerHealth()
      if (cancelled) return
      setWorkerHealth(health)
      setWorkerHealthErr(he)
    })()
    return () => {
      cancelled = true
    }
  }, [workerHealthUrl])

  async function load() {
    setErr(null)
    const snap = await getDocs(collection(fire, PA_COLLECTIONS.agents))
    setRows(
      snap.docs.map((d) => {
        const x = d.data() as Record<string, unknown>
        return {
          id: d.id,
          name: String(x.name || d.id),
          systemPrompt: String(x.systemPrompt || ""),
          provider: String(x.provider || "openai"),
          model: String(x.model || "gpt-4o-mini"),
          temperature: typeof x.temperature === "number" ? x.temperature : 0.7,
          memoryMode: String(x.memoryMode || "firestore_only"),
          toolPolicy: String(x.toolPolicy || "none"),
          allowedConnectors: Array.isArray(x.allowedConnectors)
            ? x.allowedConnectors.join(", ")
            : "",
          toolBudgetPerTurn: typeof x.toolBudgetPerTurn === "number" ? x.toolBudgetPerTurn : 1,
          isDefault: Boolean(x.isDefault),
          status: String(x.status || "published"),
          personaTone: String((x.persona as { tone?: string } | undefined)?.tone || ""),
          personaStyle: Array.isArray((x.persona as { style?: unknown[] } | undefined)?.style)
            ? ((x.persona as { style: string[] }).style).join(", ")
            : "",
          personaBoundaries: Array.isArray((x.persona as { boundaries?: unknown[] } | undefined)?.boundaries)
            ? ((x.persona as { boundaries: string[] }).boundaries).join("\n")
            : "",
          personaGoals: Array.isArray((x.persona as { goals?: unknown[] } | undefined)?.goals)
            ? ((x.persona as { goals: string[] }).goals).join("\n")
            : "",
        }
      })
    )
  }

  useEffect(() => {
    load().catch((e) => setErr(e instanceof Error ? e.message : String(e)))
  }, [])

  async function saveRow(r: AgentRow) {
    setSaving(true)
    try {
      // Build persona object: include only fields with values; for emptied
      // fields use deleteField() so re-saving an emptied input clears the
      // doc field instead of leaving stale data. Firestore rejects undefined.
      const tone = r.personaTone?.trim() || ""
      const style = (r.personaStyle ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
      const boundaries = (r.personaBoundaries ?? "")
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean)
      const goals = (r.personaGoals ?? "")
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean)
      const persona: Record<string, unknown> = {
        tone: tone ? tone : deleteField(),
        style: style.length > 0 ? style : deleteField(),
        boundaries: boundaries.length > 0 ? boundaries : deleteField(),
        goals: goals.length > 0 ? goals : deleteField(),
      }

      await updateDoc(doc(fire, PA_COLLECTIONS.agents, r.id), {
        name: r.name,
        systemPrompt: r.systemPrompt,
        provider: r.provider,
        model: r.model,
        temperature: r.temperature,
        memoryMode: r.memoryMode,
        toolPolicy: r.toolPolicy,
        allowedConnectors: r.allowedConnectors
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
        toolBudgetPerTurn: r.toolBudgetPerTurn,
        isDefault: r.isDefault === true,
        status: r.status || "draft",
        persona,
        updatedAt: new Date().toISOString(),
      })
      await load()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  async function createDraft(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      await addDoc(collection(fire, PA_COLLECTIONS.agents), {
        name: "New agent",
        systemPrompt: "You are a helpful assistant.",
        provider: "openai",
        model: "gpt-4o-mini",
        temperature: 0.7,
        memoryMode: "firestore_only",
        status: "draft",
        isDefault: false,
        version: "1",
        toolPolicy: "none",
        allowedConnectors: [],
        toolBudgetPerTurn: 1,
        updatedAt: new Date().toISOString(),
      })
      await load()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  if (err) return <div className="panel">Error: {err}</div>

  return (
    <div>
      <h1>Agent registry</h1>
      <p style={{ color: "#64748b", maxWidth: 640 }}>
        Each agent&apos;s <b>Memory</b> field is the source of truth for the iMessage worker:
        <code> firestore_only</code> uses recent <code>pa_messages</code> only; <code> mem0</code> and{" "}
        <code> both</code> also use Mem0 when <code>MEM0_API_KEY</code> is set on the worker machine.
        Runtime degradation (missing key, API errors) does not block replies; check worker logs for{" "}
        <code>[memory]</code> lines.
      </p>
      <div className="panel" style={{ marginBottom: "1rem" }}>
        <h3 style={{ marginTop: 0 }}>Worker Mem0 environment</h3>
        {workerHealthUrl ? (
          workerHealthErr ? (
            <p style={{ color: "#b91c1c" }}>Could not load {workerHealthUrl}/health: {workerHealthErr}</p>
          ) : workerHealth ? (
            <p>
              <code>{workerHealth.service || "worker"}</code>: Mem0 API key on worker —{" "}
              <b>{workerHealth.mem0ApiKeyPresent ? "present" : "absent"}</b>
            </p>
          ) : (
            <p>Loading health…</p>
          )
        ) : (
          <p style={{ fontSize: "0.9rem" }}>
            Set <code>VITE_WORKER_HEALTH_URL</code> (build-time) to your Mac worker&apos;s public base URL to
            show whether <code>MEM0_API_KEY</code> is configured there. Otherwise infer from worker{" "}
            <code>/health</code> or logs only.
          </p>
        )}
      </div>
      <form onSubmit={createDraft}>
        <button type="submit" disabled={saving}>
          New agent
        </button>
      </form>
      {rows.map((r) => (
        <div key={r.id} className="panel" style={{ marginTop: "1rem" }}>
          <h3>
            {r.name}{" "}
            <span
              title="memoryMode in Firestore (pa_agents)"
              style={{
                fontSize: "0.75rem",
                fontWeight: 600,
                marginLeft: 8,
                padding: "2px 8px",
                borderRadius: 6,
                background: "#f1f5f9",
                color: "#334155",
              }}
            >
              memory: {r.memoryMode}
            </span>
          </h3>
          <label>
            Name
            <br />
            <input
              style={{ width: "100%", maxWidth: 420 }}
              value={r.name}
              onChange={(e) =>
                setRows((x) => x.map((y) => (y.id === r.id ? { ...y, name: e.target.value } : y)))
              }
            />
          </label>
          <label>
            System prompt
            <br />
            <textarea
              style={{ width: "100%", minHeight: 100 }}
              value={r.systemPrompt}
              onChange={(e) =>
                setRows((x) => x.map((y) => (y.id === r.id ? { ...y, systemPrompt: e.target.value } : y)))
              }
            />
          </label>
          <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
            <label>
              Provider
              <br />
              <select
                value={r.provider}
                onChange={(e) =>
                  setRows((x) => x.map((y) => (y.id === r.id ? { ...y, provider: e.target.value } : y)))
                }
              >
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Model
              <br />
              <input
                value={r.model}
                onChange={(e) =>
                  setRows((x) => x.map((y) => (y.id === r.id ? { ...y, model: e.target.value } : y)))
                }
              />
            </label>
            <label>
              Temp
              <br />
              <input
                type="number"
                step="0.05"
                min={0}
                max={2}
                value={r.temperature}
                onChange={(e) =>
                  setRows((x) =>
                    x.map((y) => (y.id === r.id ? { ...y, temperature: Number(e.target.value) } : y))
                  )
                }
              />
            </label>
            <label>
              Memory
              <br />
              <select
                value={r.memoryMode}
                onChange={(e) =>
                  setRows((x) => x.map((y) => (y.id === r.id ? { ...y, memoryMode: e.target.value } : y)))
                }
              >
                {MODES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Tool policy
              <br />
              <select
                value={r.toolPolicy}
                onChange={(e) =>
                  setRows((x) => x.map((y) => (y.id === r.id ? { ...y, toolPolicy: e.target.value } : y)))
                }
              >
                {TOOL_POLICIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Tool budget
              <br />
              <input
                type="number"
                min={0}
                value={r.toolBudgetPerTurn}
                onChange={(e) =>
                  setRows((x) =>
                    x.map((y) => (y.id === r.id ? { ...y, toolBudgetPerTurn: Number(e.target.value) } : y))
                  )
                }
              />
            </label>
            <label>
              Status
              <br />
              <select
                value={r.status || "draft"}
                onChange={(e) =>
                  setRows((x) => x.map((y) => (y.id === r.id ? { ...y, status: e.target.value } : y)))
                }
              >
                <option value="draft">draft</option>
                <option value="published">published</option>
                <option value="archived">archived</option>
              </select>
            </label>
            <label>
              Allowed connectors
              <br />
              <input
                placeholder="fake-echo, wekruit-matching"
                value={r.allowedConnectors}
                onChange={(e) =>
                  setRows((x) =>
                    x.map((y) => (y.id === r.id ? { ...y, allowedConnectors: e.target.value } : y))
                  )
                }
              />
            </label>
            <label style={{ display: "flex", alignItems: "end", gap: 6 }}>
              <input
                type="checkbox"
                checked={r.isDefault === true}
                onChange={(e) =>
                  setRows((x) =>
                    x.map((y) => (y.id === r.id ? { ...y, isDefault: e.target.checked } : y))
                  )
                }
              />
              default
            </label>
          </div>
          <div className="persona-grid">
            <label>
              Persona tone
              <br />
              <input
                placeholder="warm, concise, direct"
                value={r.personaTone || ""}
                onChange={(e) =>
                  setRows((x) => x.map((y) => (y.id === r.id ? { ...y, personaTone: e.target.value } : y)))
                }
              />
            </label>
            <label>
              Persona style
              <br />
              <input
                placeholder="comma-separated: concise, operator-safe"
                value={r.personaStyle || ""}
                onChange={(e) =>
                  setRows((x) => x.map((y) => (y.id === r.id ? { ...y, personaStyle: e.target.value } : y)))
                }
              />
            </label>
            <label>
              Boundaries
              <br />
              <textarea
                placeholder="One boundary per line"
                value={r.personaBoundaries || ""}
                onChange={(e) =>
                  setRows((x) => x.map((y) => (y.id === r.id ? { ...y, personaBoundaries: e.target.value } : y)))
                }
              />
            </label>
            <label>
              Goals
              <br />
              <textarea
                placeholder="One goal per line"
                value={r.personaGoals || ""}
                onChange={(e) =>
                  setRows((x) => x.map((y) => (y.id === r.id ? { ...y, personaGoals: e.target.value } : y)))
                }
              />
            </label>
          </div>
          {r.model.includes("gpt-5.4-nano") ? (
            <p className="warning-text">
              Do not make this the live default until model probe status is passed; current direct OpenAI access returned 404.
            </p>
          ) : null}
          {workerHealth &&
            (r.memoryMode === "mem0" || r.memoryMode === "both") &&
            workerHealth.mem0ApiKeyPresent === false && (
              <p style={{ color: "#b45309", fontSize: "0.9rem", marginTop: 8 }}>
                This mode expects Mem0 on the worker, but <code>/health</code> reports no{" "}
                <code>MEM0_API_KEY</code> — runtime will be degraded (transcript only for Mem0 features).
              </p>
            )}
          <p>
            <button type="button" disabled={saving} onClick={() => saveRow(r)}>
              Save
            </button>
          </p>
        </div>
      ))}
    </div>
  )
}
