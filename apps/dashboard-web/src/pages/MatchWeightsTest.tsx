/**
 * iter30/WS8 Wave 2 — `/match/weights/test`.
 *
 * Operator pastes sample CV skills + JSON jobs → instantly see boost diff
 * (before vs after). Pure browser-side scoring (`dryRunBoost` in
 * match-weights-api.ts) so 0-latency feedback. Uses live Firestore-loaded
 * weight rows so an edit on the `/match/weights` page propagates here within
 * 30s (mirrors orchestrator-side cache TTL contract).
 */
import { useEffect, useMemo, useState } from "react"
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Panel,
} from "../components/ui.js"
import { AdminJobLink } from "../components/AdminEntityLink.js"
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
  dryRunBoost,
  listRows,
  listWeightTables,
  type DryRunResult,
  type MatchWeightRow,
  type MatchWeightTableMeta,
} from "../lib/match-weights-api.js"

const SAMPLE_CV = `RAG
LangChain
Python
SQL`

const SAMPLE_JOBS = `[
  { "id": "j-rag-eng", "requiredSkills": ["RAG", "tool calling", "Python"] },
  { "id": "j-be-eng",  "requiredSkills": ["Python", "SQL", "AWS"] },
  { "id": "j-llm-pm",  "requiredSkills": ["LLM", "prompt engineering"] }
]`

type ParsedJob = { id: string; requiredSkills: string[] }

function parseJobs(blob: string): { jobs: ParsedJob[]; error: string | null } {
  if (!blob.trim()) return { jobs: [], error: null }
  try {
    const parsed = JSON.parse(blob)
    if (!Array.isArray(parsed)) {
      return { jobs: [], error: "Expected a JSON array of jobs" }
    }
    const jobs: ParsedJob[] = []
    for (const [i, raw] of parsed.entries()) {
      if (typeof raw !== "object" || raw === null) {
        return { jobs: [], error: `Item ${i}: not an object` }
      }
      const r = raw as Record<string, unknown>
      const id = typeof r.id === "string" ? r.id : `j_${i}`
      const required = Array.isArray(r.requiredSkills)
        ? (r.requiredSkills as unknown[]).filter(
            (s): s is string => typeof s === "string"
          )
        : []
      jobs.push({ id, requiredSkills: required })
    }
    return { jobs, error: null }
  } catch (e) {
    return { jobs: [], error: e instanceof Error ? e.message : String(e) }
  }
}

function MultMode(mult: number): string {
  if (mult >= 1.2) return "STRONG"
  if (mult > 1.0) return "LEAN"
  if (mult >= 1.0) return "NEUTRAL"
  return "WEAK"
}

function MultTone(mult: number): "good" | "warn" | "muted" | "bad" {
  if (mult >= 1.2) return "good"
  if (mult > 1.0) return "warn"
  if (mult >= 1.0) return "muted"
  return "bad"
}

export function MatchWeightsTest() {
  const [tables, setTables] = useState<MatchWeightTableMeta[] | null>(null)
  const [tableKey, setTableKey] = useState<string | null>(null)
  const [rows, setRows] = useState<MatchWeightRow[] | null>(null)
  const [pageErr, setPageErr] = useState<string | null>(null)

  const [cvText, setCvText] = useState(SAMPLE_CV)
  const [jobsJson, setJobsJson] = useState(SAMPLE_JOBS)

  // Load tables on mount
  useEffect(() => {
    let cancelled = false
    listWeightTables()
      .then((t) => {
        if (cancelled) return
        setTables(t)
        if (t.length > 0) setTableKey((cur) => cur ?? t[0]!.tableKey)
      })
      .catch((e) =>
        !cancelled && setPageErr(e instanceof Error ? e.message : String(e))
      )
    return () => {
      cancelled = true
    }
  }, [])

  // Load rows when tableKey changes
  useEffect(() => {
    if (!tableKey) return
    let cancelled = false
    setRows(null)
    listRows(tableKey)
      .then((r) => !cancelled && setRows(r))
      .catch(
        (e) =>
          !cancelled && setPageErr(e instanceof Error ? e.message : String(e))
      )
    return () => {
      cancelled = true
    }
  }, [tableKey])

  const cvSkills = useMemo(
    () =>
      cvText
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    [cvText]
  )

  const parsed = useMemo(() => parseJobs(jobsJson), [jobsJson])

  const results = useMemo<DryRunResult[]>(() => {
    if (!rows || parsed.error) return []
    return dryRunBoost(cvSkills, parsed.jobs, rows)
  }, [cvSkills, parsed.jobs, parsed.error, rows])

  // Sort: finalScore desc — that's the "after-boost" rank
  const ranked = useMemo(
    () => results.slice().sort((a, b) => b.finalScore - a.finalScore),
    [results]
  )

  if (pageErr) return <ErrorState message={pageErr} />

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="iter30 / WS8 / Match"
        title="Match Weights — Dry Run"
        description="Paste sample CV skills + JSON jobs → see boost result before saving any weight edits. Pure browser-side scoring (zero-latency, no Firestore writes)."
      />

      <Panel title="Inputs">
        <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
          <label className="block text-sm md:col-span-1">
            <span className="mb-1 block font-medium">
              CV skills (one per line, or comma-separated)
            </span>
            <textarea
              value={cvText}
              onChange={(e) => setCvText(e.target.value)}
              rows={8}
              className="w-full rounded-md border border-input bg-background p-2 font-mono text-sm"
            />
            <span className="mt-1 block text-xs text-slate-500">
              {cvSkills.length} skill{cvSkills.length === 1 ? "" : "s"} parsed
            </span>
          </label>

          <label className="block text-sm md:col-span-1">
            <span className="mb-1 block font-medium">
              Sample jobs (JSON array)
            </span>
            <textarea
              value={jobsJson}
              onChange={(e) => setJobsJson(e.target.value)}
              rows={8}
              className="w-full rounded-md border border-input bg-background p-2 font-mono text-xs"
            />
            {parsed.error ? (
              <span className="mt-1 block text-xs text-red-600">
                {parsed.error}
              </span>
            ) : (
              <span className="mt-1 block text-xs text-slate-500">
                {parsed.jobs.length} job{parsed.jobs.length === 1 ? "" : "s"}{" "}
                parsed
              </span>
            )}
          </label>

          <div className="space-y-3 md:col-span-1">
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Weight table</span>
              <Select
                value={tableKey ?? ""}
                onValueChange={(v) => setTableKey(v)}
                disabled={!tables}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Pick a table" />
                </SelectTrigger>
                <SelectContent>
                  {(tables ?? []).map((t) => (
                    <SelectItem key={t.tableKey} value={t.tableKey}>
                      {t.tableKey} (v{t.version}, {t.rowCount} rows)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setCvText(SAMPLE_CV)
                setJobsJson(SAMPLE_JOBS)
              }}
            >
              Reset to sample
            </Button>
            <p className="text-xs text-slate-500">
              Edits on the <code>/match/weights</code> page propagate here on
              the next page refresh; this page reads Firestore directly.
            </p>
          </div>
        </div>
      </Panel>

      <Panel title={`Boost result (${ranked.length} jobs)`}>
        {!tableKey || rows === null ? (
          <LoadingState label="Loading weight table…" />
        ) : ranked.length === 0 ? (
          <EmptyState
            title="No results"
            body={
              parsed.error
                ? "Fix the JSON parse error above to compute boosts."
                : "Add at least one valid job to the JSON list."
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">#</TableHead>
                <TableHead>jobId</TableHead>
                <TableHead className="w-24">boost</TableHead>
                <TableHead className="w-24">mode</TableHead>
                <TableHead>matched</TableHead>
                <TableHead>coreMissing</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ranked.map((r, i) => (
                <TableRow key={r.jobId}>
                  <TableCell className="font-mono text-xs">{i + 1}</TableCell>
                  <TableCell className="font-mono">
                    <AdminJobLink jobId={r.jobId} />
                  </TableCell>
                  <TableCell className="font-mono">
                    ×{r.boostMult.toFixed(2)}
                  </TableCell>
                  <TableCell>
                    <span className={`status-badge ${MultTone(r.boostMult)}`}>
                      {MultMode(r.boostMult)}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs">
                    {r.matched.length === 0
                      ? "—"
                      : r.matched
                          .map((m) => `${m.skill} (${m.category})`)
                          .join(", ")}
                  </TableCell>
                  <TableCell className="text-xs text-red-600">
                    {r.coreMissing.length === 0
                      ? "—"
                      : r.coreMissing.map((m) => m.skill).join(", ")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>
    </div>
  )
}
