/**
 * Phase 24.5 T3 — /admin/flags page.
 *
 * Lists pa_feature_flags, supports type-aware inline edit (bool/string/number/json),
 * allowlist/blocklist chip editing for perUser scope, "Revert to previous" via last
 * audit row, and a per-flag audit drawer (last 20 events from pa_audit_events).
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
  listAuditForKey,
  listFlags,
  revertFlag,
  saveFlag,
  type AuditEvent,
  type FeatureFlag,
  type FlagScope,
  type FlagType,
  type FlagValue,
} from "../lib/flags-api.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stringifyValue(value: FlagValue, type: FlagType): string {
  if (type === "bool") return value ? "true" : "false"
  if (type === "json") return JSON.stringify(value, null, 2)
  return String(value ?? "")
}

function parseValue(text: string, type: FlagType): FlagValue {
  if (type === "bool") return text === "true"
  if (type === "number") {
    const n = Number(text)
    if (!Number.isFinite(n)) throw new Error("Invalid number")
    return n
  }
  if (type === "json") {
    return JSON.parse(text) as FlagValue
  }
  return text
}

function previewValue(value: FlagValue, type: FlagType): string {
  const s = stringifyValue(value, type)
  if (s.length > 60) return `${s.slice(0, 60)}…`
  return s
}

// ---------------------------------------------------------------------------
// Chip input (allowlist / blocklist)
// ---------------------------------------------------------------------------

function ChipInput({
  label,
  values,
  onChange,
  disabled,
}: {
  label: string
  values: string[]
  onChange: (next: string[]) => void
  disabled?: boolean
}) {
  const [draft, setDraft] = useState("")
  function add() {
    const v = draft.trim()
    if (!v) return
    if (values.includes(v)) {
      setDraft("")
      return
    }
    onChange([...values, v])
    setDraft("")
  }
  return (
    <div style={{ marginBottom: "0.5rem" }}>
      <div style={{ fontSize: "0.8em", color: "#64748b", marginBottom: 4 }}>{label}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
        {values.map((v) => (
          <span
            key={v}
            className="status-badge muted"
            style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
          >
            {v}
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange(values.filter((x) => x !== v))}
              style={{
                background: "transparent",
                border: "none",
                cursor: "pointer",
                padding: 0,
                color: "inherit",
              }}
              aria-label={`Remove ${v}`}
            >
              ×
            </button>
          </span>
        ))}
        {values.length === 0 ? (
          <span style={{ fontSize: "0.8em", color: "#94a3b8" }}>(empty)</span>
        ) : null}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          type="text"
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              add()
            }
          }}
          placeholder="userId, then Enter"
          style={{ flex: 1, fontSize: "0.85em", padding: "4px 6px" }}
        />
        <button type="button" disabled={disabled} onClick={add} style={{ fontSize: "0.8em" }}>
          Add
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Flag editor row (expand-on-edit)
// ---------------------------------------------------------------------------

type DraftState = {
  type: FlagType
  scope: FlagScope
  text: string
  allowlist: string[]
  blocklist: string[]
  reason: string
  parseError: string | null
}

function makeDraft(flag: FeatureFlag): DraftState {
  return {
    type: flag.type,
    scope: flag.scope,
    text: stringifyValue(flag.value, flag.type),
    allowlist: [...flag.allowlist],
    blocklist: [...flag.blocklist],
    reason: "",
    parseError: null,
  }
}

function FlagEditor({
  flag,
  onSaved,
  onCancel,
}: {
  flag: FeatureFlag
  onSaved: () => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<DraftState>(() => makeDraft(flag))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function handleSave() {
    setErr(null)
    let parsed: FlagValue
    try {
      parsed = parseValue(draft.text, draft.type)
    } catch (e) {
      setDraft({ ...draft, parseError: e instanceof Error ? e.message : String(e) })
      return
    }
    if (!draft.reason.trim()) {
      setErr("Reason is required (audit log).")
      return
    }
    setBusy(true)
    try {
      await saveFlag({
        key: flag.key,
        value: parsed,
        type: draft.type,
        scope: draft.scope,
        allowlist: draft.allowlist,
        blocklist: draft.blocklist,
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
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
        <label style={{ fontSize: "0.85em" }}>
          Type
          <select
            value={draft.type}
            disabled={busy}
            onChange={(e) =>
              setDraft({ ...draft, type: e.target.value as FlagType, parseError: null })
            }
            style={{ display: "block", width: "100%", marginTop: 4 }}
          >
            <option value="bool">bool</option>
            <option value="string">string</option>
            <option value="number">number</option>
            <option value="json">json</option>
          </select>
        </label>
        <label style={{ fontSize: "0.85em" }}>
          Scope
          <select
            value={draft.scope}
            disabled={busy}
            onChange={(e) => setDraft({ ...draft, scope: e.target.value as FlagScope })}
            style={{ display: "block", width: "100%", marginTop: 4 }}
          >
            <option value="global">global</option>
            <option value="perEnv">perEnv</option>
            <option value="perUser">perUser</option>
          </select>
        </label>
      </div>

      <div style={{ marginTop: "0.75rem" }}>
        <div style={{ fontSize: "0.85em", marginBottom: 4 }}>Value</div>
        {draft.type === "bool" ? (
          <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={draft.text === "true"}
              disabled={busy}
              onChange={(e) =>
                setDraft({ ...draft, text: e.target.checked ? "true" : "false" })
              }
            />
            {draft.text === "true" ? "true" : "false"}
          </label>
        ) : draft.type === "json" ? (
          <textarea
            value={draft.text}
            disabled={busy}
            onChange={(e) => setDraft({ ...draft, text: e.target.value, parseError: null })}
            rows={6}
            style={{ width: "100%", fontFamily: "monospace", fontSize: "0.8em" }}
          />
        ) : (
          <input
            type={draft.type === "number" ? "number" : "text"}
            value={draft.text}
            disabled={busy}
            onChange={(e) => setDraft({ ...draft, text: e.target.value, parseError: null })}
            style={{ width: "100%", padding: "4px 6px" }}
          />
        )}
        {draft.parseError ? (
          <div style={{ fontSize: "0.8em", color: "#dc2626", marginTop: 4 }}>
            Parse error: {draft.parseError}
          </div>
        ) : null}
      </div>

      {draft.scope === "perUser" ? (
        <div style={{ marginTop: "0.75rem" }}>
          <ChipInput
            label="Allowlist (userIds — flag returns true)"
            values={draft.allowlist}
            onChange={(next) => setDraft({ ...draft, allowlist: next })}
            disabled={busy}
          />
          <ChipInput
            label="Blocklist (userIds — flag returns false; precedence over allowlist)"
            values={draft.blocklist}
            onChange={(next) => setDraft({ ...draft, blocklist: next })}
            disabled={busy}
          />
        </div>
      ) : null}

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

function AuditDrawer({ flagKey }: { flagKey: string }) {
  const [events, setEvents] = useState<AuditEvent[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setEvents(null)
    setErr(null)
    listAuditForKey(flagKey, 20)
      .then((rows) => {
        if (!cancelled) setEvents(rows)
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [flagKey])

  if (err) return <ErrorState message={err} />
  if (events === null) return <LoadingState label="Loading audit history…" />
  if (events.length === 0) {
    return <EmptyState title="No audit events" body={`No history recorded for ${flagKey} yet.`} />
  }

  return (
    <div style={{ padding: "0.5rem 0" }}>
      <ol style={{ margin: 0, paddingLeft: "1.2rem", fontSize: "0.85em" }}>
        {events.map((e) => (
          <li key={e.id} style={{ marginBottom: "0.6rem" }}>
            <div>
              <strong>{e.action}</strong>{" "}
              <span style={{ color: "#64748b" }}>
                by {e.actor} — {e.ts ? e.ts.slice(0, 19).replace("T", " ") : "(no ts)"}
              </span>
            </div>
            <div style={{ fontFamily: "monospace", fontSize: "0.85em" }}>
              {JSON.stringify(e.oldValue)} → {JSON.stringify(e.newValue)}
            </div>
            {e.reason ? (
              <div style={{ color: "#475569", fontStyle: "italic" }}>“{e.reason}”</div>
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

export function Flags() {
  const [flags, setFlags] = useState<FeatureFlag[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [drawerKey, setDrawerKey] = useState<string | null>(null)
  const [reverting, setReverting] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setErr(null)
    try {
      const rows = await listFlags()
      rows.sort((a, b) => a.key.localeCompare(b.key))
      setFlags(rows)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function handleRevert(flag: FeatureFlag) {
    const reason = window.prompt(`Revert ${flag.key} to previous value — reason?`)
    if (!reason || !reason.trim()) return
    setReverting(flag.key)
    try {
      await revertFlag(flag.key, reason.trim())
      await load()
    } catch (e) {
      alert(`Revert failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setReverting(null)
    }
  }

  type FlagRow = FeatureFlag & { id: string }
  const tableRows: FlagRow[] = useMemo(
    () => flags.map((f) => ({ ...f, id: f.key })),
    [flags]
  )
  const columns: DataTableColumn<FlagRow>[] = useMemo(
    () => [
      {
        key: "key",
        header: "Key",
        render: (r) => (
          <span style={{ fontFamily: "monospace", fontSize: "0.85em" }}>{r.key}</span>
        ),
      },
      {
        key: "type",
        header: "Type",
        render: (r) => <StatusBadge value={r.type} />,
      },
      {
        key: "scope",
        header: "Scope",
        render: (r) => <StatusBadge value={r.scope} />,
      },
      {
        key: "value",
        header: "Value",
        render: (r) => (
          <span style={{ fontFamily: "monospace", fontSize: "0.85em" }}>
            {previewValue(r.value, r.type)}
          </span>
        ),
      },
      {
        key: "lists",
        header: "Allow / Block",
        render: (r) =>
          r.scope === "perUser" ? (
            <span style={{ fontSize: "0.8em", color: "#64748b" }}>
              {r.allowlist.length} / {r.blocklist.length}
            </span>
          ) : (
            <span style={{ fontSize: "0.8em", color: "#94a3b8" }}>—</span>
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
              onClick={() => setEditing(editing === r.key ? null : r.key)}
              style={{ fontSize: "0.8em" }}
            >
              {editing === r.key ? "Close" : "Edit"}
            </button>
            <button
              type="button"
              onClick={() => setDrawerKey(drawerKey === r.key ? null : r.key)}
              style={{ fontSize: "0.8em" }}
            >
              {drawerKey === r.key ? "Hide history" : "History"}
            </button>
            <button
              type="button"
              disabled={reverting === r.key}
              onClick={() => void handleRevert(r)}
              style={{ fontSize: "0.8em" }}
            >
              {reverting === r.key ? "Reverting…" : "Revert"}
            </button>
          </div>
        ),
      },
    ],
    [editing, drawerKey, reverting]
  )

  if (loading) return <LoadingState label="Loading feature flags…" />
  if (err) return <ErrorState message={err} />

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Admin"
        title="Feature Flags"
        description="pa_feature_flags — type-aware editor with audit trail. Reverts read the most recent non-revert audit row and write its oldValue back. ≤30s propagation via 30s TTL cache."
        actions={
          <button type="button" onClick={() => void load()}>
            Refresh
          </button>
        }
      />

      <Panel title={`${flags.length} flag${flags.length === 1 ? "" : "s"}`}>
        <DataTable
          rows={tableRows}
          columns={columns}
          empty={
            <EmptyState
              title="No flags"
              body="pa_feature_flags is empty. Run the seed script (24.5/T4) to populate the initial set."
            />
          }
        />
      </Panel>

      {editing ? (
        (() => {
          const flag = flags.find((f) => f.key === editing)
          if (!flag) return null
          return (
            <Panel title={`Edit: ${flag.key}`}>
              <FlagEditor
                flag={flag}
                onSaved={() => {
                  setEditing(null)
                  void load()
                }}
                onCancel={() => setEditing(null)}
              />
            </Panel>
          )
        })()
      ) : null}

      {drawerKey ? (
        <Panel title={`Audit history: ${drawerKey}`}>
          <AuditDrawer flagKey={drawerKey} />
        </Panel>
      ) : null}
    </div>
  )
}
