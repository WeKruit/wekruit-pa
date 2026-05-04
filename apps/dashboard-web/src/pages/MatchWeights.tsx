/**
 * iter30/WS8 Wave 2 — `/match/weights` page.
 *
 * List of weight tables (top), selected-table item editor (bottom). Inline
 * row edit (weight slider 0-3.0, category select, mandatory reason). Save
 * batched-writes Firestore + audit row + bumps `tableRef.version` so
 * downstream explainer cache invalidates within 30s.
 *
 * Mirrors Playbooks.tsx pattern (see file for canonical state-management
 * pattern). Deliberately uses page-local useState — no Zustand, no React
 * Query — same convention as the rest of the dashboard.
 */
import { useEffect, useMemo, useState } from "react"
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Panel,
  StatusBadge,
} from "../components/ui.js"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  deleteRow,
  listAuditForRow,
  listAuditForTable,
  listRows,
  listWeightTables,
  saveRow,
  type MatchWeightAuditEvent,
  type MatchWeightCategory,
  type MatchWeightRow,
  type MatchWeightTableMeta,
} from "../lib/match-weights-api.js"

const CATEGORIES: MatchWeightCategory[] = ["core", "supporting", "generic"]

function formatTs(iso: string | null): string {
  if (!iso) return "—"
  return iso.slice(0, 19).replace("T", " ")
}

function categoryTone(c: MatchWeightCategory): "good" | "warn" | "muted" {
  return c === "core" ? "good" : c === "supporting" ? "warn" : "muted"
}

// ---------------------------------------------------------------------------
// Row editor (inline panel)
// ---------------------------------------------------------------------------

type RowDraft = {
  skillKey: string
  skill: string
  weight: number
  category: MatchWeightCategory
  reason: string
}

function makeDraft(r: MatchWeightRow | null): RowDraft {
  return r
    ? {
        skillKey: r.skillKey,
        skill: r.skill,
        weight: r.weight,
        category: r.category,
        reason: "",
      }
    : { skillKey: "", skill: "", weight: 1.5, category: "supporting", reason: "" }
}

function RowEditor({
  tableKey,
  row,
  onSaved,
  onCancel,
}: {
  tableKey: string
  row: MatchWeightRow | null
  onSaved: () => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<RowDraft>(() => makeDraft(row))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const isCreate = row === null

  async function handleSave() {
    setErr(null)
    if (!draft.reason.trim()) {
      setErr("Reason is required (audit log).")
      return
    }
    setBusy(true)
    try {
      await saveRow({
        tableKey,
        skillKey: draft.skillKey,
        skill: draft.skill,
        weight: draft.weight,
        category: draft.category,
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
    <div className="space-y-4 rounded-lg border bg-slate-50 p-4">
      <div className="grid grid-cols-2 gap-4">
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Skill</span>
          <Input
            value={draft.skill}
            disabled={busy || !isCreate}
            onChange={(e) => setDraft({ ...draft, skill: e.target.value })}
            placeholder="rag / tool calling / langchain"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Category</span>
          <Select
            value={draft.category}
            onValueChange={(v) =>
              setDraft({ ...draft, category: v as MatchWeightCategory })
            }
            disabled={busy}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CATEGORIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between text-sm">
          <span className="font-medium">Weight</span>
          <span className="font-mono text-base">{draft.weight.toFixed(2)}</span>
        </div>
        <Slider
          min={0}
          max={3}
          step={0.05}
          value={[draft.weight]}
          onValueChange={(v) =>
            setDraft({ ...draft, weight: typeof v[0] === "number" ? v[0] : 1.0 })
          }
          disabled={busy}
        />
        <div className="mt-1 flex justify-between text-xs text-slate-500">
          <span>0 (off)</span>
          <span>1.5 (supporting)</span>
          <span>3.0 (core hot)</span>
        </div>
      </div>

      <label className="block text-sm">
        <span className="mb-1 block font-medium">
          Reason (required, audited)
        </span>
        <Input
          value={draft.reason}
          disabled={busy}
          onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
          placeholder="Why is this changing? — e.g. 'Q2 2026 market shift, RAG less differentiating'"
        />
      </label>

      {err ? <ErrorState message={err} /> : null}

      <div className="flex gap-2">
        <Button type="button" disabled={busy} onClick={() => void handleSave()}>
          {busy ? "Saving…" : isCreate ? "Create row" : "Save"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Audit drawer
// ---------------------------------------------------------------------------

function AuditDrawer({
  tableKey,
  skillKey,
}: {
  tableKey: string
  skillKey: string | null
}) {
  const [events, setEvents] = useState<MatchWeightAuditEvent[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setEvents(null)
    setErr(null)
    const fetcher = skillKey
      ? listAuditForRow(tableKey, skillKey, 20)
      : listAuditForTable(tableKey, 20)
    fetcher
      .then((rows) => {
        if (!cancelled) setEvents(rows)
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [tableKey, skillKey])

  if (err) return <ErrorState message={err} />
  if (events === null) return <LoadingState label="Loading audit history…" />
  if (events.length === 0) {
    return (
      <EmptyState
        title="No audit events yet"
        body={
          skillKey
            ? `No history for ${tableKey}/${skillKey}.`
            : `No table-level events for ${tableKey} yet. Edit a row to populate.`
        }
      />
    )
  }

  return (
    <ol className="space-y-3 pl-4 text-sm">
      {events.map((e) => (
        <li key={e.id} className="border-l-2 border-slate-200 pl-3">
          <div className="font-medium">
            {e.action.replace("match-weight.", "")}{" "}
            <span className="text-slate-500 font-normal">
              by {e.actor.split("@")[0] ?? e.actor} — {formatTs(e.ts)}
            </span>
          </div>
          {e.oldValue || e.newValue ? (
            <div className="mt-1 font-mono text-xs text-slate-600">
              {e.oldValue
                ? `old: weight=${e.oldValue.weight ?? "—"} category=${
                    e.oldValue.category ?? "—"
                  }`
                : "(create)"}
              {" → "}
              {e.newValue
                ? `new: weight=${e.newValue.weight ?? "—"} category=${
                    e.newValue.category ?? "—"
                  }`
                : "(delete)"}
            </div>
          ) : null}
          {e.reason ? (
            <div className="mt-0.5 italic text-slate-600">"{e.reason}"</div>
          ) : null}
        </li>
      ))}
    </ol>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function MatchWeights() {
  const [tables, setTables] = useState<MatchWeightTableMeta[] | null>(null)
  const [selectedTableKey, setSelectedTableKey] = useState<string | null>(null)
  const [rows, setRows] = useState<MatchWeightRow[] | null>(null)
  const [editing, setEditing] = useState<string | null>(null) // skillKey | "__new__"
  const [auditFor, setAuditFor] = useState<string | null>(null) // skillKey | "" (table-level)
  const [pageErr, setPageErr] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  // Load tables on mount
  useEffect(() => {
    let cancelled = false
    setPageErr(null)
    listWeightTables()
      .then((t) => {
        if (cancelled) return
        setTables(t)
        if (t.length > 0 && selectedTableKey === null) {
          setSelectedTableKey(t[0]!.tableKey)
        }
      })
      .catch((e) => {
        if (!cancelled) setPageErr(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  // Load rows whenever selected table changes
  useEffect(() => {
    if (!selectedTableKey) return
    let cancelled = false
    setRows(null)
    listRows(selectedTableKey)
      .then((r) => {
        if (!cancelled) setRows(r)
      })
      .catch((e) => {
        if (!cancelled) setPageErr(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [selectedTableKey, refreshKey])

  const selectedTable = useMemo(
    () => tables?.find((t) => t.tableKey === selectedTableKey) ?? null,
    [tables, selectedTableKey]
  )

  async function handleDelete(row: MatchWeightRow) {
    if (!selectedTableKey) return
    const reason = window.prompt(
      `Delete ${selectedTableKey}/${row.skillKey} — reason for audit log?`
    )
    if (!reason || !reason.trim()) return
    try {
      await deleteRow(selectedTableKey, row.skillKey, reason.trim())
      setRefreshKey((n) => n + 1)
    } catch (e) {
      alert(`Delete failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (pageErr) return <ErrorState message={pageErr} />

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="iter30 / WS8 / Match"
        title="Match Weights"
        description="Per-role skill weight tables — Firestore-backed, edits go live within 30s without a deploy. Each save bumps the table version, invalidating downstream explainer cache."
        actions={
          <Button
            type="button"
            variant="outline"
            onClick={() => setRefreshKey((n) => n + 1)}
          >
            Refresh
          </Button>
        }
      />

      <Panel
        title={`Tables (${tables?.length ?? "—"})`}
        eyebrow="pa-match-weight-tables"
      >
        {tables === null ? (
          <LoadingState label="Loading tables…" />
        ) : tables.length === 0 ? (
          <EmptyState
            title="No tables yet"
            body="Run apps/functions/scripts/seed-match-weights.mjs --confirm to seed the AI agent 2026 table."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Key</TableHead>
                <TableHead>Name</TableHead>
                <TableHead className="w-20">Rows</TableHead>
                <TableHead className="w-24">Version</TableHead>
                <TableHead className="w-24">Active</TableHead>
                <TableHead>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tables.map((t) => (
                <TableRow
                  key={t.tableKey}
                  className={
                    t.tableKey === selectedTableKey
                      ? "bg-slate-100"
                      : "cursor-pointer"
                  }
                  onClick={() => {
                    setSelectedTableKey(t.tableKey)
                    setEditing(null)
                    setAuditFor(null)
                  }}
                >
                  <TableCell className="font-mono text-xs">{t.tableKey}</TableCell>
                  <TableCell>{t.name}</TableCell>
                  <TableCell>{t.rowCount}</TableCell>
                  <TableCell>v{t.version}</TableCell>
                  <TableCell>
                    <StatusBadge value={t.active ? "active" : "muted"} />
                  </TableCell>
                  <TableCell className="text-xs text-slate-500">
                    {formatTs(t.updatedAt)}
                    {t.updatedBy ? ` by ${t.updatedBy.split("@")[0]}` : ""}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>

      {selectedTable ? (
        <Panel
          title={`Rows: ${selectedTable.tableKey}`}
          eyebrow={selectedTable.name}
          actions={
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setAuditFor(auditFor === "" ? null : "")
                }}
              >
                {auditFor === "" ? "Hide audit" : "Table audit"}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => setEditing(editing === "__new__" ? null : "__new__")}
              >
                {editing === "__new__" ? "Close" : "+ Add row"}
              </Button>
            </div>
          }
        >
          {rows === null ? (
            <LoadingState label="Loading rows…" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Skill</TableHead>
                  <TableHead className="w-24">Weight</TableHead>
                  <TableHead className="w-32">Category</TableHead>
                  <TableHead className="w-40">Updated</TableHead>
                  <TableHead className="w-48">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.skillKey}>
                    <TableCell className="font-medium">{r.skill}</TableCell>
                    <TableCell className="font-mono">
                      {r.weight.toFixed(2)}
                    </TableCell>
                    <TableCell>
                      <span
                        className={`status-badge ${categoryTone(r.category)}`}
                      >
                        {r.category}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs text-slate-500">
                      {formatTs(r.updatedAt)}
                      {r.updatedBy ? ` by ${r.updatedBy.split("@")[0]}` : ""}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            setEditing(editing === r.skillKey ? null : r.skillKey)
                          }
                        >
                          {editing === r.skillKey ? "Close" : "Edit"}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            setAuditFor(
                              auditFor === r.skillKey ? null : r.skillKey
                            )
                          }
                        >
                          {auditFor === r.skillKey ? "Hide hist." : "History"}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          onClick={() => void handleDelete(r)}
                        >
                          Delete
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Panel>
      ) : null}

      {selectedTableKey && editing === "__new__" ? (
        <Panel title="Add new row" eyebrow={selectedTableKey}>
          <RowEditor
            tableKey={selectedTableKey}
            row={null}
            onSaved={() => {
              setEditing(null)
              setRefreshKey((n) => n + 1)
            }}
            onCancel={() => setEditing(null)}
          />
        </Panel>
      ) : null}

      {selectedTableKey && editing && editing !== "__new__"
        ? (() => {
            const r = rows?.find((x) => x.skillKey === editing)
            if (!r) return null
            return (
              <Panel title={`Edit: ${r.skill}`} eyebrow={selectedTableKey}>
                <RowEditor
                  tableKey={selectedTableKey}
                  row={r}
                  onSaved={() => {
                    setEditing(null)
                    setRefreshKey((n) => n + 1)
                  }}
                  onCancel={() => setEditing(null)}
                />
              </Panel>
            )
          })()
        : null}

      {selectedTableKey && auditFor !== null ? (
        <Panel
          title={
            auditFor === ""
              ? `Audit history: ${selectedTableKey}`
              : `Audit history: ${selectedTableKey}/${auditFor}`
          }
        >
          <AuditDrawer
            tableKey={selectedTableKey}
            skillKey={auditFor === "" ? null : auditFor}
          />
        </Panel>
      ) : null}
    </div>
  )
}
