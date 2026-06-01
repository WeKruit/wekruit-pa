/**
 * Phase 30 T3 — /admin/downstream-triggers page.
 *
 * Lists pa-downstream-triggers, supports inline edit (name / condition /
 * endpoint / payload template / cooldown), enable/disable toggle, and a
 * fire-history drawer per trigger (last 50 events from pa-trigger-fires).
 */
import { useEffect, useMemo, useState } from "react"
import { AdminUserLink } from "../components/AdminEntityLink.js"
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
  listDownstreamTriggers,
  listTriggerFires,
  saveDownstreamTrigger,
  setDownstreamTriggerEnabled,
  type Trigger,
  type TriggerConditionKind,
  type TriggerFireRow,
} from "../lib/downstream-triggers-api.js"

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

type DraftState = {
  name: string
  description: string
  conditionKind: TriggerConditionKind
  conditionConfig: string // JSON text
  endpointUrl: string
  endpointMethod: "POST"
  payloadTemplate: string
  cooldownSec: number
  reason: string
  parseError: string | null
}

function makeDraft(t: Trigger): DraftState {
  return {
    name: t.name,
    description: t.description ?? "",
    conditionKind: t.condition.kind,
    conditionConfig: JSON.stringify(t.condition.config, null, 2),
    endpointUrl: t.endpoint.url,
    endpointMethod: t.endpoint.method ?? "POST",
    payloadTemplate: t.payloadTemplate,
    cooldownSec: t.cooldownSec,
    reason: "",
    parseError: null,
  }
}

function TriggerEditor({
  trigger,
  onSaved,
  onCancel,
}: {
  trigger: Trigger
  onSaved: () => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<DraftState>(() => makeDraft(trigger))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function save() {
    setErr(null)
    if (!draft.reason.trim()) {
      setErr("Reason required for audit log")
      return
    }
    let conditionConfig: unknown
    try {
      conditionConfig = JSON.parse(draft.conditionConfig)
    } catch (e) {
      setErr(`Invalid condition JSON: ${e instanceof Error ? e.message : String(e)}`)
      return
    }
    setBusy(true)
    try {
      await saveDownstreamTrigger({
        ...trigger,
        name: draft.name.trim(),
        description: draft.description.trim(),
        condition: { kind: draft.conditionKind, config: conditionConfig as never },
        endpoint: {
          url: draft.endpointUrl.trim(),
          method: draft.endpointMethod,
          headers: trigger.endpoint.headers,
          hmacSecretRef: trigger.endpoint.hmacSecretRef,
        },
        payloadTemplate: draft.payloadTemplate,
        cooldownSec: Math.max(0, Math.floor(draft.cooldownSec)),
      })
      onSaved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <label style={{ fontSize: "0.85em" }}>
        Name
        <input
          type="text"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          style={{ width: "100%", marginTop: 4 }}
        />
      </label>
      <label style={{ fontSize: "0.85em" }}>
        Description
        <input
          type="text"
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          style={{ width: "100%", marginTop: 4 }}
        />
      </label>
      <div style={{ display: "flex", gap: 8 }}>
        <label style={{ fontSize: "0.85em", flex: 1 }}>
          Condition kind
          <select
            value={draft.conditionKind}
            onChange={(e) => setDraft({ ...draft, conditionKind: e.target.value as TriggerConditionKind })}
            style={{ width: "100%", marginTop: 4 }}
          >
            <option value="keyword">keyword</option>
            <option value="llm-judge">llm-judge</option>
          </select>
        </label>
        <label style={{ fontSize: "0.85em", flex: 1 }}>
          Cooldown (sec)
          <input
            type="number"
            value={draft.cooldownSec}
            onChange={(e) => setDraft({ ...draft, cooldownSec: Number(e.target.value) })}
            style={{ width: "100%", marginTop: 4 }}
          />
        </label>
      </div>
      <label style={{ fontSize: "0.85em" }}>
        Condition config (JSON — keyword: {`{pattern, flags}`}; llm-judge: {`{judgePrompt, judgeModel}`})
        <textarea
          value={draft.conditionConfig}
          onChange={(e) => setDraft({ ...draft, conditionConfig: e.target.value })}
          rows={4}
          style={{ width: "100%", marginTop: 4, fontFamily: "monospace", fontSize: "0.85em" }}
        />
      </label>
      <div style={{ display: "flex", gap: 8 }}>
        <label style={{ fontSize: "0.85em", flex: 3 }}>
          Endpoint URL
          <input
            type="text"
            value={draft.endpointUrl}
            onChange={(e) => setDraft({ ...draft, endpointUrl: e.target.value })}
            style={{ width: "100%", marginTop: 4 }}
          />
        </label>
        <label style={{ fontSize: "0.85em", flex: 1 }}>
          Method
          <input
            type="text"
            value={draft.endpointMethod}
            disabled
            style={{ width: "100%", marginTop: 4, color: "#94a3b8" }}
          />
        </label>
      </div>
      <label style={{ fontSize: "0.85em" }}>
        Payload template (Mustache-lite — {`{{userId}}`}, {`{{lastUserTurn}}`}, etc)
        <textarea
          value={draft.payloadTemplate}
          onChange={(e) => setDraft({ ...draft, payloadTemplate: e.target.value })}
          rows={5}
          style={{ width: "100%", marginTop: 4, fontFamily: "monospace", fontSize: "0.85em" }}
        />
      </label>
      <label style={{ fontSize: "0.85em" }}>
        Reason (audit)
        <input
          type="text"
          value={draft.reason}
          onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
          placeholder="why this change?"
          style={{ width: "100%", marginTop: 4 }}
        />
      </label>
      {err ? <div style={{ color: "#dc2626", fontSize: "0.85em" }}>{err}</div> : null}
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" disabled={busy} onClick={() => void save()}>
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
// Fire history drawer
// ---------------------------------------------------------------------------

function FireDrawer({ triggerId }: { triggerId: string }) {
  const [rows, setRows] = useState<TriggerFireRow[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    listTriggerFires(triggerId, 50)
      .then(setRows)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
  }, [triggerId])
  if (err) return <ErrorState message={err} />
  if (!rows) return <LoadingState label="Loading fire history…" />
  if (rows.length === 0) return <EmptyState title="No fires yet" body="This trigger has not fired." />
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.85em" }}>
      {rows.map((r, i) => (
        <div
          key={i}
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 0.5fr 1fr 2fr",
            gap: 8,
            padding: "4px 0",
            borderBottom: "1px solid #e2e8f0",
          }}
        >
          <span style={{ fontFamily: "monospace" }}>{r.firedAt.slice(0, 19).replace("T", " ")}</span>
          <span>
            <StatusBadge value={r.httpStatus !== null ? String(r.httpStatus) : "err"} />
          </span>
          <span style={{ fontFamily: "monospace" }}>
            <AdminUserLink userId={r.userId} />
          </span>
          <span style={{ color: r.errorMsg ? "#dc2626" : "#64748b" }}>
            {r.errorMsg ?? "ok"}
          </span>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function DownstreamTriggers() {
  const [triggers, setTriggers] = useState<Trigger[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [drawerKey, setDrawerKey] = useState<string | null>(null)
  const [toggling, setToggling] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setErr(null)
    try {
      const rows = await listDownstreamTriggers()
      rows.sort((a, b) => a.name.localeCompare(b.name))
      setTriggers(rows)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function toggleEnabled(t: Trigger) {
    setToggling(t.triggerId)
    try {
      await setDownstreamTriggerEnabled(t.triggerId, !t.enabled)
      await load()
    } catch (e) {
      alert(`Toggle failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setToggling(null)
    }
  }

  type Row = Trigger & { id: string }
  const tableRows: Row[] = useMemo(
    () => triggers.map((t) => ({ ...t, id: t.triggerId })),
    [triggers]
  )

  const columns: DataTableColumn<Row>[] = useMemo(
    () => [
      {
        key: "name",
        header: "Name",
        render: (r) => (
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontWeight: 600 }}>{r.name}</span>
            {r.description ? (
              <span style={{ fontSize: "0.8em", color: "#64748b" }}>{r.description}</span>
            ) : null}
          </div>
        ),
      },
      {
        key: "kind",
        header: "Condition",
        render: (r) => <StatusBadge value={r.condition.kind} />,
      },
      {
        key: "endpoint",
        header: "Endpoint",
        render: (r) => (
          <span style={{ fontFamily: "monospace", fontSize: "0.8em" }}>
            {r.endpoint.method} {r.endpoint.url.length > 40 ? r.endpoint.url.slice(0, 40) + "…" : r.endpoint.url}
          </span>
        ),
      },
      {
        key: "cooldown",
        header: "Cooldown",
        render: (r) => <span style={{ fontSize: "0.8em" }}>{r.cooldownSec}s</span>,
      },
      {
        key: "enabled",
        header: "Enabled",
        render: (r) => (
          <button
            type="button"
            disabled={toggling === r.triggerId}
            onClick={() => void toggleEnabled(r)}
            style={{ fontSize: "0.8em" }}
          >
            {toggling === r.triggerId ? "…" : r.enabled ? "✓ on" : "✗ off"}
          </button>
        ),
      },
      {
        key: "actions",
        header: "Actions",
        render: (r) => (
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              onClick={() => setEditing(editing === r.triggerId ? null : r.triggerId)}
              style={{ fontSize: "0.8em" }}
            >
              {editing === r.triggerId ? "Close" : "Edit"}
            </button>
            <button
              type="button"
              onClick={() => setDrawerKey(drawerKey === r.triggerId ? null : r.triggerId)}
              style={{ fontSize: "0.8em" }}
            >
              {drawerKey === r.triggerId ? "Hide fires" : "Fires"}
            </button>
          </div>
        ),
      },
    ],
    [editing, drawerKey, toggling]
  )

  if (loading) return <LoadingState label="Loading downstream triggers…" />
  if (err) return <ErrorState message={err} />

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Admin"
        title="Downstream Triggers"
        description="pa-downstream-triggers — eval LLM watches each turn, fires HMAC-signed POST to external service when condition matches. Per-user cooldown enforced via pa-trigger-fires."
        actions={
          <button type="button" onClick={() => void load()}>
            Refresh
          </button>
        }
      />

      <Panel title={`${triggers.length} trigger${triggers.length === 1 ? "" : "s"}`}>
        <DataTable
          rows={tableRows}
          columns={columns}
          empty={
            <EmptyState
              title="No triggers"
              body="pa-downstream-triggers is empty. Add one via Firestore directly or via admin script."
            />
          }
        />
      </Panel>

      {editing ? (
        (() => {
          const t = triggers.find((x) => x.triggerId === editing)
          if (!t) return null
          return (
            <Panel title={`Edit: ${t.name}`}>
              <TriggerEditor
                trigger={t}
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
        <Panel title={`Fire history: ${drawerKey}`}>
          <FireDrawer triggerId={drawerKey} />
        </Panel>
      ) : null}
    </div>
  )
}
