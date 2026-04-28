/**
 * Phase 29 T3 — /admin/handbook page.
 *
 * Lists pa-handbook-sections rows (order column, enabled toggle, body
 * preview), supports inline edit (title/body/order/enabled) with required
 * audit reason, per-section audit drawer, and a revert button that reads
 * the most recent non-revert handbook audit row and restores its
 * oldValue. Mirrors the Phase 24.5 /admin/flags pattern.
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
  listAuditForSection,
  listSections,
  revertSection,
  saveSection,
  type HandbookAuditEvent,
  type HandbookSection,
} from "../lib/handbook-api.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function previewBody(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim()
  if (flat.length <= 80) return flat
  return `${flat.slice(0, 80)}…`
}

// ---------------------------------------------------------------------------
// Section editor (expand-on-edit)
// ---------------------------------------------------------------------------

type DraftState = {
  title: string
  body: string
  order: number
  enabled: boolean
  reason: string
}

function makeDraft(s: HandbookSection): DraftState {
  return {
    title: s.title,
    body: s.body,
    order: s.order,
    enabled: s.enabled,
    reason: "",
  }
}

function SectionEditor({
  section,
  onSaved,
  onCancel,
}: {
  section: HandbookSection
  onSaved: () => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<DraftState>(() => makeDraft(section))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function handleSave() {
    setErr(null)
    if (!draft.reason.trim()) {
      setErr("Reason is required (audit log).")
      return
    }
    setBusy(true)
    try {
      await saveSection({
        sectionKey: section.sectionKey,
        title: draft.title,
        body: draft.body,
        order: draft.order,
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

  return (
    <div style={{ padding: "0.75rem", background: "#f8fafc", borderRadius: 6 }}>
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: "0.75rem" }}>
        <label style={{ fontSize: "0.85em" }}>
          Title
          <input
            type="text"
            value={draft.title}
            disabled={busy}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            style={{ display: "block", width: "100%", marginTop: 4, padding: "4px 6px" }}
          />
        </label>
        <label style={{ fontSize: "0.85em" }}>
          Order
          <input
            type="number"
            value={draft.order}
            disabled={busy}
            onChange={(e) =>
              setDraft({ ...draft, order: Number(e.target.value) || 0 })
            }
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
        <div style={{ fontSize: "0.85em", marginBottom: 4 }}>
          Body (markdown — composed verbatim under <code># {draft.title}</code>)
        </div>
        <textarea
          value={draft.body}
          disabled={busy}
          onChange={(e) => setDraft({ ...draft, body: e.target.value })}
          rows={Math.min(24, Math.max(8, draft.body.split("\n").length + 2))}
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

      <div style={{ marginTop: "0.75rem", display: "flex", gap: 8 }}>
        <button type="button" disabled={busy} onClick={() => void handleSave()}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Audit drawer
// ---------------------------------------------------------------------------

function AuditDrawer({ sectionKey }: { sectionKey: string }) {
  const [events, setEvents] = useState<HandbookAuditEvent[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setEvents(null)
    setErr(null)
    listAuditForSection(sectionKey, 20)
      .then((rows) => {
        if (!cancelled) setEvents(rows)
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [sectionKey])

  if (err) return <ErrorState message={err} />
  if (events === null) return <LoadingState label="Loading audit history…" />
  if (events.length === 0) {
    return (
      <EmptyState
        title="No audit events"
        body={`No history recorded for ${sectionKey} yet.`}
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
              {e.oldValue?.body !== undefined ? (
                <span>old body: {previewBody(e.oldValue.body ?? "")}</span>
              ) : (
                <span>(no oldValue)</span>
              )}
              {" → "}
              {e.newValue?.body !== undefined ? (
                <span>new body: {previewBody(e.newValue.body ?? "")}</span>
              ) : null}
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

export function Handbook() {
  const [sections, setSections] = useState<HandbookSection[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [drawerKey, setDrawerKey] = useState<string | null>(null)
  const [reverting, setReverting] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setErr(null)
    try {
      const rows = await listSections()
      setSections(rows)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function handleRevert(section: HandbookSection) {
    const reason = window.prompt(
      `Revert ${section.sectionKey} to previous body — reason?`
    )
    if (!reason || !reason.trim()) return
    setReverting(section.sectionKey)
    try {
      await revertSection(section.sectionKey, reason.trim())
      await load()
    } catch (e) {
      alert(`Revert failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setReverting(null)
    }
  }

  type Row = HandbookSection & { id: string }
  const tableRows: Row[] = useMemo(
    () => sections.map((s) => ({ ...s, id: s.sectionKey })),
    [sections]
  )
  const columns: DataTableColumn<Row>[] = useMemo(
    () => [
      {
        key: "order",
        header: "Order",
        render: (r) => <span style={{ fontSize: "0.85em" }}>{r.order}</span>,
      },
      {
        key: "sectionKey",
        header: "Section",
        render: (r) => (
          <span style={{ fontFamily: "monospace", fontSize: "0.85em" }}>
            {r.sectionKey}
          </span>
        ),
      },
      {
        key: "title",
        header: "Title",
        render: (r) => <span style={{ fontSize: "0.85em" }}>{r.title}</span>,
      },
      {
        key: "enabled",
        header: "Enabled",
        render: (r) => (
          <StatusBadge value={r.enabled ? "enabled" : "disabled"} />
        ),
      },
      {
        key: "preview",
        header: "Body preview",
        render: (r) => (
          <span style={{ fontSize: "0.8em", color: "#475569" }}>
            {previewBody(r.body)}
          </span>
        ),
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
              onClick={() => setEditing(editing === r.sectionKey ? null : r.sectionKey)}
              style={{ fontSize: "0.8em" }}
            >
              {editing === r.sectionKey ? "Close" : "Edit"}
            </button>
            <button
              type="button"
              onClick={() =>
                setDrawerKey(drawerKey === r.sectionKey ? null : r.sectionKey)
              }
              style={{ fontSize: "0.8em" }}
            >
              {drawerKey === r.sectionKey ? "Hide history" : "History"}
            </button>
            <button
              type="button"
              disabled={reverting === r.sectionKey}
              onClick={() => void handleRevert(r)}
              style={{ fontSize: "0.8em" }}
            >
              {reverting === r.sectionKey ? "Reverting…" : "Revert"}
            </button>
          </div>
        ),
      },
    ],
    [editing, drawerKey, reverting]
  )

  if (loading) return <LoadingState label="Loading handbook sections…" />
  if (err) return <ErrorState message={err} />

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Admin"
        title="Agent Handbook"
        description="pa-handbook-sections — Bible-as-data. Sections are composed at runtime in `order` ascending into the systemPrompt for the default agent. Disabled sections are excluded. Reverts read the most recent non-revert handbook audit row and restore its oldValue."
        actions={
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={() => void load()}>
              Refresh
            </button>
          </div>
        }
      />

      <Panel title={`${sections.length} section${sections.length === 1 ? "" : "s"}`}>
        <DataTable
          rows={tableRows}
          columns={columns}
          empty={
            <EmptyState
              title="No handbook sections"
              body="pa-handbook-sections is empty. Run the `migrateHandbookFromBible` admin action to seed sections from the inline Bible."
            />
          }
        />
      </Panel>

      {editing
        ? (() => {
            const section = sections.find((s) => s.sectionKey === editing)
            if (!section) return null
            return (
              <Panel title={`Edit: ${section.sectionKey}`}>
                <SectionEditor
                  section={section}
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
          <AuditDrawer sectionKey={drawerKey} />
        </Panel>
      ) : null}
    </div>
  )
}
