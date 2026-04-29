/**
 * Phase 32 W3 — /agent/personas page.
 *
 * Soul.md three-file pattern: each persona doc holds three markdown
 * fields (SOUL / STYLE / EXAMPLES). Editor exposes them as 3 tabs.
 * "Preview compose" button shows the exact concat string sent to the
 * persona-LLM by simulateConversation.
 */
import { useEffect, useMemo, useState } from "react"
import {
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Panel,
  StatusBadge,
  type DataTableColumn,
} from "../components/ui.js"
import {
  composePersonaPreview,
  listAuditForPersona,
  listPersonas,
  revertPersona,
  savePersona,
  type Persona,
  type PersonaAuditEvent,
} from "../lib/personas-api.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function previewBody(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim()
  if (flat.length <= 80) return flat
  return `${flat.slice(0, 80)}…`
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

type DraftState = {
  name: string
  description: string
  soul: string
  style: string
  examples: string
  enabled: boolean
  reason: string
}

function makeDraft(p: Persona): DraftState {
  return {
    name: p.name,
    description: p.description,
    soul: p.soul,
    style: p.style,
    examples: p.examples,
    enabled: p.enabled,
    reason: "",
  }
}

type Tab = "soul" | "style" | "examples"

function PersonaEditor({
  persona,
  onSaved,
  onCancel,
}: {
  persona: Persona
  onSaved: () => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<DraftState>(() => makeDraft(persona))
  const [tab, setTab] = useState<Tab>("soul")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [showPreview, setShowPreview] = useState(false)

  async function handleSave() {
    setErr(null)
    if (!draft.reason.trim()) {
      setErr("Reason is required (audit log).")
      return
    }
    setBusy(true)
    try {
      await savePersona({
        personaKey: persona.personaKey,
        name: draft.name,
        description: draft.description,
        soul: draft.soul,
        style: draft.style,
        examples: draft.examples,
        enabled: draft.enabled,
        reason: draft.reason.trim(),
      })
      onSaved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // Live preview uses the in-progress draft (so editors see their changes).
  const previewText = useMemo(
    () =>
      composePersonaPreview({
        ...persona,
        soul: draft.soul,
        style: draft.style,
        examples: draft.examples,
      }),
    [draft.soul, draft.style, draft.examples, persona]
  )

  const activeBody =
    tab === "soul" ? draft.soul : tab === "style" ? draft.style : draft.examples

  function setActiveBody(v: string) {
    if (tab === "soul") setDraft({ ...draft, soul: v })
    else if (tab === "style") setDraft({ ...draft, style: v })
    else setDraft({ ...draft, examples: v })
  }

  return (
    <div style={{ padding: "0.75rem", background: "#f8fafc", borderRadius: 6 }}>
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "0.75rem" }}>
        <label style={{ fontSize: "0.85em" }}>
          Name
          <input
            type="text"
            value={draft.name}
            disabled={busy}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            style={{ display: "block", width: "100%", marginTop: 4, padding: "4px 6px" }}
          />
        </label>
        <label
          style={{
            fontSize: "0.85em",
            display: "flex",
            alignItems: "flex-end",
            gap: 6,
          }}
        >
          <input
            type="checkbox"
            checked={draft.enabled}
            disabled={busy}
            onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
          />
          Enabled
        </label>
      </div>

      <div style={{ marginTop: "0.75rem" }}>
        <label style={{ fontSize: "0.85em" }}>
          Description
          <input
            type="text"
            value={draft.description}
            disabled={busy}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            placeholder="Short tagline"
            style={{ display: "block", width: "100%", marginTop: 4, padding: "4px 6px" }}
          />
        </label>
      </div>

      {/* Three-file tab strip */}
      <div style={{ marginTop: "0.75rem", display: "flex", gap: 6 }}>
        {(["soul", "style", "examples"] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            style={{
              fontSize: "0.85em",
              fontWeight: tab === t ? 700 : 400,
              background: tab === t ? "#0f172a" : "transparent",
              color: tab === t ? "#fff" : "inherit",
              borderRadius: 6,
              padding: "4px 10px",
              border: "1px solid #cbd5e1",
            }}
          >
            {t.toUpperCase()}
          </button>
        ))}
      </div>

      <div style={{ marginTop: "0.5rem" }}>
        <textarea
          value={activeBody}
          disabled={busy}
          onChange={(e) => setActiveBody(e.target.value)}
          rows={Math.min(24, Math.max(10, activeBody.split("\n").length + 2))}
          placeholder={
            tab === "soul"
              ? "Worldview / voice / what they care about"
              : tab === "style"
                ? "Register, sentence shape, vocabulary, length caps"
                : "3-5 dialogue examples — opening, follow-ups, refusals"
          }
          style={{
            width: "100%",
            fontFamily: "monospace",
            fontSize: "0.85em",
            padding: 8,
          }}
        />
      </div>

      <div style={{ marginTop: "0.75rem" }}>
        <label style={{ fontSize: "0.85em" }}>
          Reason (required, audited)
          <input
            type="text"
            value={draft.reason}
            disabled={busy}
            onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
            placeholder="Why is this changing?"
            style={{ display: "block", width: "100%", padding: "4px 6px", marginTop: 4 }}
          />
        </label>
      </div>

      {err ? <ErrorState message={err} /> : null}

      <div style={{ marginTop: "0.75rem", display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" disabled={busy} onClick={() => void handleSave()}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          onClick={() => setShowPreview(!showPreview)}
          style={{ marginLeft: "auto" }}
        >
          {showPreview ? "Hide compose preview" : "Preview compose"}
        </button>
      </div>

      {showPreview ? (
        <div style={{ marginTop: "0.75rem" }}>
          <div style={{ fontSize: "0.85em", color: "#64748b", marginBottom: 4 }}>
            This is the exact systemPrompt the persona-LLM receives:
          </div>
          <pre
            style={{
              background: "#0f172a",
              color: "#e2e8f0",
              padding: 12,
              borderRadius: 6,
              fontSize: "0.8em",
              overflow: "auto",
              maxHeight: 320,
              whiteSpace: "pre-wrap",
            }}
          >
            {previewText || "(empty)"}
          </pre>
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Audit drawer
// ---------------------------------------------------------------------------

function AuditDrawer({ personaKey }: { personaKey: string }) {
  const [events, setEvents] = useState<PersonaAuditEvent[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setEvents(null)
    setErr(null)
    listAuditForPersona(personaKey, 20)
      .then((rows) => {
        if (!cancelled) setEvents(rows)
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [personaKey])

  if (err) return <ErrorState message={err} />
  if (events === null) return <LoadingState label="Loading audit history…" />
  if (events.length === 0) {
    return (
      <EmptyState
        title="No audit events"
        body={`No history recorded for ${personaKey} yet.`}
      />
    )
  }

  return (
    <div style={{ padding: "0.5rem 0" }}>
      <ol style={{ margin: 0, paddingLeft: "1.2rem", fontSize: "0.85em" }}>
        {events.map((e) => (
          <li key={e.id} style={{ marginBottom: "0.6rem" }}>
            <div>
              <strong>{e.action}</strong>{" "}
              <span style={{ color: "#64748b" }}>
                by {e.actor} —{" "}
                {e.ts ? e.ts.slice(0, 19).replace("T", " ") : "(no ts)"}
              </span>
            </div>
            <div style={{ fontFamily: "monospace", fontSize: "0.8em", color: "#475569" }}>
              {e.oldValue?.soul !== undefined ? (
                <span>old soul: {previewBody(e.oldValue.soul ?? "")}</span>
              ) : (
                <span>(no oldValue)</span>
              )}
            </div>
            {e.reason ? (
              <div style={{ color: "#475569", fontStyle: "italic" }}>"{e.reason}"</div>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function Personas() {
  const [personas, setPersonas] = useState<Persona[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [drawerKey, setDrawerKey] = useState<string | null>(null)
  const [reverting, setReverting] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setErr(null)
    try {
      const rows = await listPersonas()
      setPersonas(rows)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function handleRevert(p: Persona) {
    const reason = window.prompt(`Revert ${p.personaKey} to previous version — reason?`)
    if (!reason || !reason.trim()) return
    setReverting(p.personaKey)
    try {
      await revertPersona(p.personaKey, reason.trim())
      await load()
    } catch (e) {
      alert(`Revert failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setReverting(null)
    }
  }

  type Row = Persona & { id: string }
  const tableRows: Row[] = useMemo(
    () => personas.map((p) => ({ ...p, id: p.personaKey })),
    [personas]
  )
  const columns: DataTableColumn<Row>[] = useMemo(
    () => [
      {
        key: "personaKey",
        header: "Key",
        render: (r) => (
          <span style={{ fontFamily: "monospace", fontSize: "0.85em" }}>
            {r.personaKey}
          </span>
        ),
      },
      {
        key: "name",
        header: "Name",
        render: (r) => <span style={{ fontSize: "0.85em" }}>{r.name}</span>,
      },
      {
        key: "description",
        header: "Description",
        render: (r) => (
          <span style={{ fontSize: "0.8em", color: "#475569" }}>
            {previewBody(r.description)}
          </span>
        ),
      },
      {
        key: "enabled",
        header: "Enabled",
        render: (r) => <StatusBadge value={r.enabled ? "enabled" : "disabled"} />,
      },
      {
        key: "version",
        header: "v",
        render: (r) => <span style={{ fontSize: "0.8em" }}>{r.version}</span>,
      },
      {
        key: "updated",
        header: "Updated",
        render: (r) => (
          <span style={{ fontSize: "0.8em", color: "#64748b" }}>
            {r.updatedAt ? r.updatedAt.slice(0, 19).replace("T", " ") : "—"}
            {r.updatedBy ? <> by {r.updatedBy.split("@")[0]}</> : null}
          </span>
        ),
      },
      {
        key: "actions",
        header: "Actions",
        render: (r) => (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => setEditing(editing === r.personaKey ? null : r.personaKey)}
              style={{ fontSize: "0.8em" }}
            >
              {editing === r.personaKey ? "Close" : "Edit"}
            </button>
            <button
              type="button"
              onClick={() =>
                setDrawerKey(drawerKey === r.personaKey ? null : r.personaKey)
              }
              style={{ fontSize: "0.8em" }}
            >
              {drawerKey === r.personaKey ? "Hide history" : "History"}
            </button>
            <button
              type="button"
              disabled={reverting === r.personaKey}
              onClick={() => void handleRevert(r)}
              style={{ fontSize: "0.8em" }}
            >
              {reverting === r.personaKey ? "Reverting…" : "Revert"}
            </button>
          </div>
        ),
      },
    ],
    [editing, drawerKey, reverting]
  )

  if (loading) return <LoadingState label="Loading personas…" />
  if (err) return <ErrorState message={err} />

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Agent"
        title="Personas"
        description="pa-personas — soul.md three-file pattern (SOUL / STYLE / EXAMPLES). Used by simulateConversation to drive the persona-LLM during N-round sims. If empty, simulateConversation falls back to inline strings."
        actions={
          <button type="button" onClick={() => void load()}>
            Refresh
          </button>
        }
      />

      <Panel title={`${personas.length} persona${personas.length === 1 ? "" : "s"}`}>
        <DataTable
          rows={tableRows}
          columns={columns}
          empty={
            <EmptyState
              title="No personas"
              body="pa-personas is empty. Run the seedPersonas admin action to seed the 3 default personas (anxious_grad, formal_em, vent_seeker)."
            />
          }
        />
      </Panel>

      {editing
        ? (() => {
            const p = personas.find((x) => x.personaKey === editing)
            if (!p) return null
            return (
              <Panel title={`Edit: ${p.personaKey}`}>
                <PersonaEditor
                  persona={p}
                  onSaved={() => {
                    setEditing(null)
                    void load()
                  }}
                  onCancel={() => setEditing(null)}
                />
              </Panel>
            )
          })()
        : null}

      {drawerKey ? (
        <Panel title={`Audit history: ${drawerKey}`}>
          <AuditDrawer personaKey={drawerKey} />
        </Panel>
      ) : null}
    </div>
  )
}
