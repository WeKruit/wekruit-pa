/**
 * Phase 32 W3 — /agent/playbooks page.
 *
 * Lists pa-playbooks rows with name, regex triggers (multi-input), addendum
 * markdown body, enabled toggle, audit drawer, revert button. Plus a
 * "test trigger" panel: paste a sample message → see which playbooks match.
 *
 * Mirrors Phase 29 Handbook.tsx shape so operators don't relearn the UI.
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
  listAuditForPlaybook,
  listPlaybooks,
  revertPlaybook,
  savePlaybook,
  testTriggers,
  type Playbook,
  type PlaybookAuditEvent,
} from "../lib/playbooks-api.js"

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
  triggersText: string // newline-separated regex sources
  addendum: string
  enabled: boolean
  routingHint: "no_chain" | "role_chain" | "none"
  reason: string
}

function makeDraft(p: Playbook): DraftState {
  return {
    name: p.name,
    description: p.description,
    triggersText: p.regexTriggers.join("\n"),
    addendum: p.addendum,
    enabled: p.enabled,
    routingHint: p.routingHint ?? "none",
    reason: "",
  }
}

function validateRegexes(text: string): { regexes: string[]; invalid: string[] } {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  const invalid: string[] = []
  for (const l of lines) {
    try {
      new RegExp(l, "i")
    } catch {
      invalid.push(l)
    }
  }
  return { regexes: lines, invalid }
}

function PlaybookEditor({
  playbook,
  onSaved,
  onCancel,
}: {
  playbook: Playbook
  onSaved: () => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<DraftState>(() => makeDraft(playbook))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const validation = useMemo(() => validateRegexes(draft.triggersText), [draft.triggersText])

  async function handleSave() {
    setErr(null)
    if (!draft.reason.trim()) {
      setErr("Reason is required (audit log).")
      return
    }
    if (validation.invalid.length > 0) {
      setErr(`Invalid regex(es): ${validation.invalid.join(", ")}`)
      return
    }
    setBusy(true)
    try {
      await savePlaybook({
        playbookKey: playbook.playbookKey,
        name: draft.name,
        description: draft.description,
        regexTriggers: validation.regexes,
        addendum: draft.addendum,
        enabled: draft.enabled,
        routingHint: draft.routingHint === "none" ? null : draft.routingHint,
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
            placeholder="What this playbook is for"
            style={{ display: "block", width: "100%", marginTop: 4, padding: "4px 6px" }}
          />
        </label>
      </div>

      <div style={{ marginTop: "0.75rem" }}>
        <label style={{ fontSize: "0.85em" }}>
          Routing hint (iter27) — controls onboarding behavior on first-turn match
          <select
            value={draft.routingHint}
            disabled={busy}
            onChange={(e) =>
              setDraft({
                ...draft,
                routingHint: e.target.value as DraftState["routingHint"],
              })
            }
            style={{ display: "block", width: "100%", marginTop: 4, padding: "4px 6px" }}
          >
            <option value="none">none — no special routing (addendum only)</option>
            <option value="no_chain">
              no_chain — distress / qualifier (vent / interview / negotiation / motivation): suspend onboarding, addendum is the ack
            </option>
            <option value="role_chain">
              role_chain — explicit job intent (headhunter / jd_roast): ack + chain ask_q_role
            </option>
          </select>
        </label>
      </div>

      <div style={{ marginTop: "0.75rem" }}>
        <div style={{ fontSize: "0.85em", marginBottom: 4 }}>
          Regex triggers (one per line; case-insensitive)
        </div>
        <textarea
          value={draft.triggersText}
          disabled={busy}
          onChange={(e) => setDraft({ ...draft, triggersText: e.target.value })}
          rows={6}
          placeholder={"想换\noffer\n在面"}
          style={{
            width: "100%",
            fontFamily: "monospace",
            fontSize: "0.85em",
            padding: 8,
          }}
        />
        {validation.invalid.length > 0 ? (
          <div style={{ color: "#b91c1c", fontSize: "0.8em" }}>
            Invalid regex: {validation.invalid.join(", ")}
          </div>
        ) : null}
      </div>

      <div style={{ marginTop: "0.75rem" }}>
        <div style={{ fontSize: "0.85em", marginBottom: 4 }}>
          Addendum body (markdown — concatenated into systemPrompt when matched)
        </div>
        <textarea
          value={draft.addendum}
          disabled={busy}
          onChange={(e) => setDraft({ ...draft, addendum: e.target.value })}
          rows={Math.min(24, Math.max(8, draft.addendum.split("\n").length + 2))}
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

function AuditDrawer({ playbookKey }: { playbookKey: string }) {
  const [events, setEvents] = useState<PlaybookAuditEvent[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setEvents(null)
    setErr(null)
    listAuditForPlaybook(playbookKey, 20)
      .then((rows) => {
        if (!cancelled) setEvents(rows)
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [playbookKey])

  if (err) return <ErrorState message={err} />
  if (events === null) return <LoadingState label="Loading audit history…" />
  if (events.length === 0) {
    return (
      <EmptyState
        title="No audit events"
        body={`No history recorded for ${playbookKey} yet.`}
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
              {e.oldValue?.addendum !== undefined ? (
                <span>old addendum: {previewBody(e.oldValue.addendum ?? "")}</span>
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
// Trigger tester
// ---------------------------------------------------------------------------

function TriggerTester({ playbooks }: { playbooks: Playbook[] }) {
  const [sample, setSample] = useState("")
  const matched = useMemo(() => testTriggers(sample, playbooks), [sample, playbooks])
  return (
    <div style={{ padding: "0.5rem 0" }}>
      <label style={{ fontSize: "0.85em", display: "block" }}>
        Sample message
        <input
          type="text"
          value={sample}
          onChange={(e) => setSample(e.target.value)}
          placeholder="Paste an inbound user message to see which playbooks fire"
          style={{ display: "block", width: "100%", padding: "4px 6px", marginTop: 4 }}
        />
      </label>
      <div style={{ marginTop: "0.5rem", fontSize: "0.85em" }}>
        {sample.trim() ? (
          matched.length > 0 ? (
            <div>
              <strong>{matched.length}</strong> playbook
              {matched.length === 1 ? "" : "s"} matched:
              <ul style={{ margin: "0.25rem 0 0 1rem" }}>
                {matched.map((p) => (
                  <li key={p.playbookKey}>
                    <code>{p.playbookKey}</code> — {p.name}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div style={{ color: "#64748b" }}>No playbooks matched this message.</div>
          )
        ) : (
          <div style={{ color: "#64748b" }}>Type something to test.</div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function Playbooks() {
  const [playbooks, setPlaybooks] = useState<Playbook[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [drawerKey, setDrawerKey] = useState<string | null>(null)
  const [reverting, setReverting] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setErr(null)
    try {
      const rows = await listPlaybooks()
      setPlaybooks(rows)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function handleRevert(p: Playbook) {
    const reason = window.prompt(`Revert ${p.playbookKey} to previous version — reason?`)
    if (!reason || !reason.trim()) return
    setReverting(p.playbookKey)
    try {
      await revertPlaybook(p.playbookKey, reason.trim())
      await load()
    } catch (e) {
      alert(`Revert failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setReverting(null)
    }
  }

  type Row = Playbook & { id: string }
  const tableRows: Row[] = useMemo(
    () => playbooks.map((p) => ({ ...p, id: p.playbookKey })),
    [playbooks]
  )
  const columns: DataTableColumn<Row>[] = useMemo(
    () => [
      {
        key: "playbookKey",
        header: "Key",
        render: (r) => (
          <span style={{ fontFamily: "monospace", fontSize: "0.85em" }}>
            {r.playbookKey}
          </span>
        ),
      },
      {
        key: "name",
        header: "Name",
        render: (r) => <span style={{ fontSize: "0.85em" }}>{r.name}</span>,
      },
      {
        key: "triggers",
        header: "Triggers",
        render: (r) => (
          <span style={{ fontSize: "0.8em", color: "#475569" }}>
            {r.regexTriggers.length === 0
              ? "—"
              : r.regexTriggers.slice(0, 3).join(" | ") +
                (r.regexTriggers.length > 3 ? ` (+${r.regexTriggers.length - 3})` : "")}
          </span>
        ),
      },
      {
        key: "enabled",
        header: "Enabled",
        render: (r) => <StatusBadge value={r.enabled ? "enabled" : "disabled"} />,
      },
      {
        key: "routingHint",
        header: "Routing",
        render: (r) => (
          <span
            style={{
              fontSize: "0.75em",
              padding: "2px 6px",
              borderRadius: 4,
              background:
                r.routingHint === "no_chain"
                  ? "#fef3c7"
                  : r.routingHint === "role_chain"
                  ? "#dbeafe"
                  : "#f1f5f9",
              color: "#475569",
            }}
          >
            {r.routingHint ?? "—"}
          </span>
        ),
      },
      {
        key: "addendum",
        header: "Addendum",
        render: (r) => (
          <span style={{ fontSize: "0.8em", color: "#475569" }}>
            {previewBody(r.addendum)}
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
              onClick={() => setEditing(editing === r.playbookKey ? null : r.playbookKey)}
              style={{ fontSize: "0.8em" }}
            >
              {editing === r.playbookKey ? "Close" : "Edit"}
            </button>
            <button
              type="button"
              onClick={() =>
                setDrawerKey(drawerKey === r.playbookKey ? null : r.playbookKey)
              }
              style={{ fontSize: "0.8em" }}
            >
              {drawerKey === r.playbookKey ? "Hide history" : "History"}
            </button>
            <button
              type="button"
              disabled={reverting === r.playbookKey}
              onClick={() => void handleRevert(r)}
              style={{ fontSize: "0.8em" }}
            >
              {reverting === r.playbookKey ? "Reverting…" : "Revert"}
            </button>
          </div>
        ),
      },
    ],
    [editing, drawerKey, reverting]
  )

  if (loading) return <LoadingState label="Loading playbooks…" />
  if (err) return <ErrorState message={err} />

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Agent"
        title="Playbooks"
        description="pa-playbooks — Firestore-backed playbook addenda. When an inbound message matches any of a playbook's regex triggers, its addendum body is concatenated into the systemPrompt for that turn. Cached 30s in the orchestrator. If empty, falls back to the inline HEADHUNTER regex."
        actions={
          <button type="button" onClick={() => void load()}>
            Refresh
          </button>
        }
      />

      <Panel title="Test trigger">
        <TriggerTester playbooks={playbooks} />
      </Panel>

      <Panel title={`${playbooks.length} playbook${playbooks.length === 1 ? "" : "s"}`}>
        <DataTable
          rows={tableRows}
          columns={columns}
          empty={
            <EmptyState
              title="No playbooks"
              body="pa-playbooks is empty. Run the seedPlaybooks admin action to seed the default headhunter playbook."
            />
          }
        />
      </Panel>

      {editing
        ? (() => {
            const p = playbooks.find((x) => x.playbookKey === editing)
            if (!p) return null
            return (
              <Panel title={`Edit: ${p.playbookKey}`}>
                <PlaybookEditor
                  playbook={p}
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
          <AuditDrawer playbookKey={drawerKey} />
        </Panel>
      ) : null}
    </div>
  )
}
