/**
 * iter30/WS8 Wave 2 — `/match/explainer-history`.
 *
 * Read-only paginated view of `pa-job-rec-explanations` (the Firestore-cached
 * Qwen-7B explainer reasons). Operators spot-check daily-batch output by
 * userId or language; click "view" for full reason + metadata.
 *
 * Composite index needed: (userId asc + createdAt desc) — added to
 * firestore.indexes.json under iter30/WS8 deploy step.
 */
import { useEffect, useMemo, useState } from "react"
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Panel,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  listRecentExplanations,
  type ExplanationDoc,
} from "../lib/match-explainer-api.js"
import { AdminJobLink, AdminUserLink } from "../components/AdminEntityLink.js"

function formatTs(iso: string | null): string {
  if (!iso) return "—"
  return iso.slice(0, 19).replace("T", " ")
}

function preview(reason: string, len = 80): string {
  const flat = reason.replace(/\s+/g, " ").trim()
  return flat.length <= len ? flat : `${flat.slice(0, len)}…`
}

export function MatchExplainerHistory() {
  const [rows, setRows] = useState<ExplanationDoc[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  // Filters
  const [userIdFilter, setUserIdFilter] = useState("")
  const [language, setLanguage] = useState<"" | "zh" | "en">("")
  const [pageSize, setPageSize] = useState(25)
  const [refreshKey, setRefreshKey] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setRows(null)
    setErr(null)
    listRecentExplanations({
      userId: userIdFilter.trim() || undefined,
      language: language || undefined,
      pageSize,
    })
      .then((r) => !cancelled && setRows(r))
      .catch(
        (e) => !cancelled && setErr(e instanceof Error ? e.message : String(e))
      )
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  const selectedRow = useMemo(
    () => rows?.find((r) => r.id === selected) ?? null,
    [rows, selected]
  )

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="iter30 / WS8 / Match"
        title="Match Explainer — History"
        description="Spot-check Qwen-7B explainer output from production daily-batch runs. Filter by user / language / date. Each row is a cached reason — `__v{N}` suffix in id = weight-table version (any weight edit forces a fresh row)."
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

      <Panel title="Filters">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
          <label className="block text-sm">
            <span className="mb-1 block font-medium">User ID</span>
            <Input
              value={userIdFilter}
              onChange={(e) => setUserIdFilter(e.target.value)}
              placeholder="adam@wekruit.com"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Language</span>
            <Select
              value={language || "all"}
              onValueChange={(v) =>
                setLanguage(v === "all" ? "" : (v as "zh" | "en"))
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">all</SelectItem>
                <SelectItem value="zh">zh</SelectItem>
                <SelectItem value="en">en</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Page size</span>
            <Select
              value={String(pageSize)}
              onValueChange={(v) => setPageSize(Number(v))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="25">25</SelectItem>
                <SelectItem value="50">50</SelectItem>
                <SelectItem value="100">100</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <div className="flex items-end">
            <Button
              type="button"
              onClick={() => setRefreshKey((n) => n + 1)}
              className="w-full"
            >
              Apply
            </Button>
          </div>
        </div>
      </Panel>

      <Panel
        title={`Reasons (${rows?.length ?? "—"})`}
        eyebrow="pa-job-rec-explanations"
      >
        {err ? <ErrorState message={err} /> : null}
        {rows === null && !err ? (
          <LoadingState label="Loading explanations…" />
        ) : rows && rows.length === 0 ? (
          <EmptyState
            title="No matching explanations"
            body="Try widening the filters, or wait for the next daily-batch run."
          />
        ) : rows ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-44">When</TableHead>
                <TableHead className="w-44">User</TableHead>
                <TableHead className="w-32">Job</TableHead>
                <TableHead className="w-16">Lang</TableHead>
                <TableHead className="w-16">v</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead className="w-20">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow
                  key={r.id}
                  className={
                    selected === r.id ? "bg-slate-100" : undefined
                  }
                >
                  <TableCell className="text-xs text-slate-500">
                    {formatTs(r.createdAt)}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    <AdminUserLink userId={r.userId}>{r.userId.split("@")[0] ?? r.userId}</AdminUserLink>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    <AdminJobLink jobId={r.jobId} />
                  </TableCell>
                  <TableCell>{r.language}</TableCell>
                  <TableCell>
                    {r.weightTableVersion !== null
                      ? `v${r.weightTableVersion}`
                      : "—"}
                  </TableCell>
                  <TableCell className="text-sm">
                    {preview(r.reason)}
                  </TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setSelected(selected === r.id ? null : r.id)
                      }
                    >
                      {selected === r.id ? "Hide" : "View"}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
      </Panel>

      {selectedRow ? (
        <Panel
          title={`Selected: ${selectedRow.userId} → ${selectedRow.jobId}`}
          eyebrow={selectedRow.language}
        >
          <div className="space-y-2 text-sm">
            <div className="flex flex-wrap gap-3 text-xs">
              <span>candidate <AdminUserLink userId={selectedRow.userId}>{selectedRow.userId.split("@")[0] ?? selectedRow.userId}</AdminUserLink></span>
              <span>job <AdminJobLink jobId={selectedRow.jobId} /></span>
            </div>
            <div>
              <span className="font-medium">Reason: </span>
              <span className="font-mono">{selectedRow.reason}</span>
            </div>
            <div className="text-xs text-slate-500">
              Created: {formatTs(selectedRow.createdAt)} · TTL:{" "}
              {formatTs(selectedRow.ttlAt)} · Match score:{" "}
              {selectedRow.matchScore?.toFixed(3) ?? "—"} · Weight-table
              version:{" "}
              {selectedRow.weightTableVersion !== null
                ? `v${selectedRow.weightTableVersion}`
                : "(legacy / unversioned)"}
            </div>
            <div className="text-xs text-slate-400">
              Doc id: <code>{selectedRow.id}</code>
            </div>
          </div>
        </Panel>
      ) : null}
    </div>
  )
}
