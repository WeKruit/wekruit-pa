/**
 * Phase A4 (WEK-yc) — `/admin/companies` CRUD.
 *
 * Lists `pa-companies` docs (centralized company directory) with inline edit
 * for `companyStage` (closed enum) and `companyTags` (open vocab, multi-pick
 * chips). Filters by stage, tag, and a "needs enrichment" toggle that
 * surfaces docs with no `enrichmentSource` OR `enrichedAt < now - 30d`.
 *
 * Inline edit writes `setDoc(..., { merge: true })` with `lastReviewedBy`
 * stamped from the current operator email — this sets the Phase A5
 * never-overwrite sentinel (see `pa-company.ts` doc comment).
 *
 * Bulk action "Re-enrich selected" calls `paEnrichCompaniesAdHoc` callable
 * (Phase A5). The callable may not be deployed yet — surface the error to
 * the operator if so.
 *
 * Auth: dashboard sign-in wall + CF-side operator check (mirrors
 * `/admin/canonical-tags`).
 */
import { useEffect, useState, useMemo, useCallback, type FormEvent } from "react"
import {
  collection,
  doc,
  getDocs,
  limit as fsLimit,
  orderBy,
  query,
  setDoc,
  startAfter,
  where,
  type QueryConstraint,
  type QueryDocumentSnapshot,
} from "firebase/firestore"
import { httpsCallable } from "firebase/functions"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import {
  COMPANY_STAGE_VOCAB,
  COMPANY_TAG_VOCAB,
  type CompanyStage,
  type CompanyTag,
} from "@wekruit/shared-tags/canonical"
import { PA_COLLECTIONS } from "@pa/core-types"
import type { PaCompany } from "@pa/core-types"

import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Panel,
} from "../components/ui.js"
import { auth, db, functions } from "../lib/firebase.js"
import { createCompany } from "../lib/job-admin-api.js"
import { suggestCompanyId } from "../lib/job-admin-ids.js"

const PAGE_SIZE = 100
const STALE_DAYS = 30
const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000

type CompanyRow = Partial<PaCompany> & { id: string }

function operatorEmail(): string {
  return auth().currentUser?.email ?? "unknown@wekruit.com"
}

function fmtTimestamp(value: string | null | undefined): string {
  if (!value) return "—"
  return value.slice(0, 19).replace("T", " ")
}

function isStale(c: CompanyRow): boolean {
  if (!c.enrichmentSource) return true
  if (!c.enrichedAt) return true
  const enriched = Date.parse(c.enrichedAt)
  if (Number.isNaN(enriched)) return true
  return Date.now() - enriched > STALE_MS
}

type CollabFilter = "all" | "collab_only" | "non_collab"
type JobsFilter = "all" | "has_jobs" | "no_jobs"

function matchesFilters(
  row: CompanyRow,
  stageFilter: CompanyStage | "all",
  tagFilters: CompanyTag[],
  needsEnrichment: boolean,
  collabFilter: CollabFilter,
  jobsFilter: JobsFilter,
  search: string,
): boolean {
  if (stageFilter !== "all" && row.companyStage !== stageFilter) return false
  if (tagFilters.length > 0) {
    const have = new Set(row.companyTags ?? [])
    if (!tagFilters.every((t) => have.has(t))) return false
  }
  if (needsEnrichment && !isStale(row)) return false
  if (collabFilter === "collab_only" && row.wekruitCollab !== true) return false
  if (collabFilter === "non_collab" && row.wekruitCollab === true) return false
  if (jobsFilter === "has_jobs" && !((row.jobsCount ?? 0) > 0)) return false
  if (jobsFilter === "no_jobs" && (row.jobsCount ?? 0) > 0) return false
  if (search) {
    const q = search.toLowerCase()
    const name = (row.displayName ?? row.normalizedName ?? row.id).toLowerCase()
    if (!name.includes(q)) return false
  }
  return true
}

export function Companies() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [rows, setRows] = useState<CompanyRow[]>([])
  const [cursor, setCursor] = useState<QueryDocumentSnapshot | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  // Filters
  const [stageFilter, setStageFilter] = useState<CompanyStage | "all">("all")
  const [tagFilters, setTagFilters] = useState<CompanyTag[]>([])
  const [needsEnrichment, setNeedsEnrichment] = useState(false)
  const [collabFilter, setCollabFilter] = useState<CollabFilter>("all")
  const [jobsFilter, setJobsFilter] = useState<JobsFilter>("all")
  const [search, setSearch] = useState("")

  // Selection (bulk re-enrich)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkMsg, setBulkMsg] = useState<string | null>(null)
  const [bulkErr, setBulkErr] = useState<string | null>(null)

  // Per-row save state
  const [savingId, setSavingId] = useState<string | null>(null)
  const [rowErr, setRowErr] = useState<Record<string, string>>({})
  const [showCreate, setShowCreate] = useState(searchParams.get("create") === "1")
  const [createBusy, setCreateBusy] = useState(false)
  const [createErr, setCreateErr] = useState<string | null>(null)
  const [createForm, setCreateForm] = useState({
    displayName: "",
    companyId: "",
    domain: "",
    websiteUrl: "",
    careersUrl: "",
    description: "",
  })
  const [companyIdTouched, setCompanyIdTouched] = useState(false)

  const loadInitial = useCallback(async () => {
    setLoading(true)
    setErr(null)
    setRows([])
    setCursor(null)
    setHasMore(false)
    setSelected(new Set())
    try {
      const constraints: QueryConstraint[] = [
        orderBy("updatedAt", "desc"),
        fsLimit(PAGE_SIZE),
      ]
      const snap = await getDocs(query(collection(db(), PA_COLLECTIONS.companies), ...constraints))
      const next = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Partial<PaCompany>),
      }))
      setRows(next)
      setCursor(snap.docs.length > 0 ? snap.docs[snap.docs.length - 1]! : null)
      setHasMore(snap.docs.length === PAGE_SIZE)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadInitial()
  }, [loadInitial, refreshKey])

  useEffect(() => {
    if (searchParams.get("create") === "1") {
      setShowCreate(true)
    }
  }, [searchParams])

  async function loadMore() {
    if (!cursor || loadingMore) return
    setLoadingMore(true)
    setErr(null)
    try {
      const snap = await getDocs(
        query(
          collection(db(), PA_COLLECTIONS.companies),
          orderBy("updatedAt", "desc"),
          startAfter(cursor),
          fsLimit(PAGE_SIZE),
        ),
      )
      const next = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Partial<PaCompany>),
      }))
      setRows((prev) => [...prev, ...next])
      setCursor(snap.docs.length > 0 ? snap.docs[snap.docs.length - 1]! : cursor)
      setHasMore(snap.docs.length === PAGE_SIZE)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoadingMore(false)
    }
  }

  async function persistPatch(
    id: string,
    patch: Partial<PaCompany>,
  ): Promise<void> {
    setSavingId(id)
    setRowErr((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    try {
      const now = new Date().toISOString()
      const fullPatch = {
        ...patch,
        lastReviewedBy: operatorEmail(),
        updatedAt: now,
      }
      await setDoc(doc(db(), PA_COLLECTIONS.companies, id), fullPatch, { merge: true })
      setRows((prev) =>
        prev.map((r) => (r.id === id ? { ...r, ...fullPatch } : r)),
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setRowErr((prev) => ({ ...prev, [id]: msg }))
    } finally {
      setSavingId(null)
    }
  }

  function setStage(row: CompanyRow, stage: CompanyStage) {
    void persistPatch(row.id, { companyStage: stage })
  }

  function toggleTag(row: CompanyRow, tag: CompanyTag) {
    const current = new Set<CompanyTag>(row.companyTags ?? [])
    if (current.has(tag)) current.delete(tag)
    else current.add(tag)
    void persistPatch(row.id, { companyTags: Array.from(current) })
  }

  function toggleTagFilter(tag: CompanyTag) {
    setTagFilters((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    )
  }

  const filtered = useMemo(
    () =>
      rows.filter((r) =>
        matchesFilters(r, stageFilter, tagFilters, needsEnrichment, collabFilter, jobsFilter, search),
      ),
    [rows, stageFilter, tagFilters, needsEnrichment, collabFilter, jobsFilter, search],
  )

  function toggleCollab(row: CompanyRow) {
    const next = !(row.wekruitCollab === true)
    void persistPatch(row.id, { wekruitCollab: next })
  }

  function toggleSelectAll() {
    if (filtered.every((r) => selected.has(r.id))) {
      setSelected(new Set())
    } else {
      setSelected(new Set(filtered.map((r) => r.id)))
    }
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function reenrichSelected() {
    if (selected.size === 0) return
    setBulkBusy(true)
    setBulkMsg(null)
    setBulkErr(null)
    try {
      const companyNames = filtered
        .filter((r) => selected.has(r.id))
        .map((r) => r.displayName ?? r.normalizedName ?? r.id)
      const fn = httpsCallable<
        { companyNames: string[] },
        { ok: boolean; queued?: number; message?: string }
      >(functions(), "paEnrichCompaniesAdHoc")
      const res = await fn({ companyNames })
      const queued = res.data?.queued ?? companyNames.length
      setBulkMsg(`Queued ${queued} company re-enrichment(s).`)
      setSelected(new Set())
    } catch (e) {
      setBulkErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBulkBusy(false)
    }
  }

  async function handleCreateCompany(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setCreateBusy(true)
    setCreateErr(null)
    try {
      const { companyId } = await createCompany({
        ...createForm,
        operatorEmail: operatorEmail(),
      })
      navigate(`/admin/external-supply/jobs/${encodeURIComponent(companyId)}`)
    } catch (e) {
      setCreateErr(e instanceof Error ? e.message : String(e))
    } finally {
      setCreateBusy(false)
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Phase A4 / Admin"
        title="Companies"
        description={`Centralized company directory (pa-companies). Inline edit stage + tags. "Needs enrichment" surfaces docs with no source or stale beyond ${STALE_DAYS} days.`}
        actions={
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={() => setRefreshKey((n) => n + 1)} disabled={loading}>
              Refresh
            </button>
            <button type="button" onClick={() => setShowCreate((prev) => !prev)}>
              {showCreate ? "Hide create" : "Create company"}
            </button>
          </div>
        }
      />

      {showCreate ? (
        <Panel title="Create company" eyebrow="Create in pa-companies, then continue into job creation">
          <form onSubmit={(event) => void handleCreateCompany(event)}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                gap: 12,
              }}
            >
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: "0.78em", color: "#64748b" }}>Display name</span>
                <input
                  type="text"
                  value={createForm.displayName}
                  onChange={(e) => {
                    const displayName = e.target.value
                    setCreateForm((prev) => ({
                      ...prev,
                      displayName,
                      companyId: companyIdTouched ? prev.companyId : suggestCompanyId(displayName),
                    }))
                  }}
                  placeholder="Rain"
                  style={{
                    padding: "8px 10px",
                    border: "1px solid #e2e8f0",
                    borderRadius: 4,
                    fontSize: "0.9em",
                  }}
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: "0.78em", color: "#64748b" }}>Company ID</span>
                <input
                  type="text"
                  value={createForm.companyId}
                  onChange={(e) => {
                    setCompanyIdTouched(true)
                    setCreateForm((prev) => ({ ...prev, companyId: e.target.value }))
                  }}
                  placeholder="rain"
                  style={{
                    padding: "8px 10px",
                    border: "1px solid #e2e8f0",
                    borderRadius: 4,
                    fontSize: "0.9em",
                    fontFamily: "monospace",
                  }}
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: "0.78em", color: "#64748b" }}>Domain</span>
                <input
                  type="text"
                  value={createForm.domain}
                  onChange={(e) => setCreateForm((prev) => ({ ...prev, domain: e.target.value }))}
                  placeholder="rain.xyz"
                  style={{
                    padding: "8px 10px",
                    border: "1px solid #e2e8f0",
                    borderRadius: 4,
                    fontSize: "0.9em",
                  }}
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: "0.78em", color: "#64748b" }}>Website URL</span>
                <input
                  type="url"
                  value={createForm.websiteUrl}
                  onChange={(e) =>
                    setCreateForm((prev) => ({ ...prev, websiteUrl: e.target.value }))
                  }
                  placeholder="https://rain.xyz"
                  style={{
                    padding: "8px 10px",
                    border: "1px solid #e2e8f0",
                    borderRadius: 4,
                    fontSize: "0.9em",
                  }}
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: "0.78em", color: "#64748b" }}>Careers URL</span>
                <input
                  type="url"
                  value={createForm.careersUrl}
                  onChange={(e) =>
                    setCreateForm((prev) => ({ ...prev, careersUrl: e.target.value }))
                  }
                  placeholder="https://rain.xyz/careers"
                  style={{
                    padding: "8px 10px",
                    border: "1px solid #e2e8f0",
                    borderRadius: 4,
                    fontSize: "0.9em",
                  }}
                />
              </label>
              <label
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                  gridColumn: "1 / -1",
                }}
              >
                <span style={{ fontSize: "0.78em", color: "#64748b" }}>Description</span>
                <textarea
                  value={createForm.description}
                  onChange={(e) => setCreateForm((prev) => ({ ...prev, description: e.target.value }))}
                  rows={4}
                  placeholder="Short internal note or company summary"
                  style={{
                    padding: "8px 10px",
                    border: "1px solid #e2e8f0",
                    borderRadius: 4,
                    fontSize: "0.9em",
                    fontFamily: "inherit",
                  }}
                />
              </label>
            </div>
            {createErr ? (
              <div style={{ marginTop: 12 }}>
                <ErrorState message={createErr} />
              </div>
            ) : null}
            <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
              <button
                type="submit"
                disabled={createBusy}
                style={{
                  padding: "8px 14px",
                  borderRadius: 4,
                  border: "none",
                  background: "#1a73e8",
                  color: "white",
                  cursor: createBusy ? "wait" : "pointer",
                }}
              >
                {createBusy ? "Creating…" : "Create company and continue"}
              </button>
              <span style={{ fontSize: "0.8em", color: "#64748b" }}>
                Success path: company directory → company jobs → create first job
              </span>
            </div>
          </form>
        </Panel>
      ) : null}

      <Panel title="Filters" eyebrow={`${filtered.length} of ${rows.length} loaded`}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-start" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: "0.78em", color: "#64748b" }}>Search</span>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="display name…"
              style={{
                padding: "4px 8px",
                border: "1px solid #e2e8f0",
                borderRadius: 4,
                fontSize: "0.85em",
                minWidth: 180,
              }}
            />
          </label>

          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: "0.78em", color: "#64748b" }}>Stage</span>
            <select
              value={stageFilter}
              onChange={(e) => setStageFilter(e.target.value as CompanyStage | "all")}
              style={{
                padding: "4px 8px",
                border: "1px solid #e2e8f0",
                borderRadius: 4,
                fontSize: "0.85em",
              }}
            >
              <option value="all">All stages</option>
              {COMPANY_STAGE_VOCAB.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>

          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: "0.78em", color: "#64748b" }}>Tags (AND)</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, maxWidth: 480 }}>
              {COMPANY_TAG_VOCAB.map((t) => {
                const active = tagFilters.includes(t)
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => toggleTagFilter(t)}
                    style={{
                      padding: "2px 8px",
                      fontSize: "0.78em",
                      border: active ? "1px solid #1a73e8" : "1px solid #e2e8f0",
                      background: active ? "#eff6ff" : "#ffffff",
                      borderRadius: 999,
                      cursor: "pointer",
                      fontFamily: "monospace",
                    }}
                  >
                    {t}
                  </button>
                )
              })}
            </div>
          </div>

          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: "0.78em", color: "#64748b" }}>WeKruit collab</span>
            <select
              value={collabFilter}
              onChange={(e) => setCollabFilter(e.target.value as CollabFilter)}
              style={{
                padding: "4px 8px",
                border: "1px solid #e2e8f0",
                borderRadius: 4,
                fontSize: "0.85em",
              }}
            >
              <option value="all">All</option>
              <option value="collab_only">Collab partners only</option>
              <option value="non_collab">Non-collab only</option>
            </select>
          </label>

          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: "0.78em", color: "#64748b" }}>Jobs</span>
            <select
              value={jobsFilter}
              onChange={(e) => setJobsFilter(e.target.value as JobsFilter)}
              style={{
                padding: "4px 8px",
                border: "1px solid #e2e8f0",
                borderRadius: 4,
                fontSize: "0.85em",
              }}
            >
              <option value="all">All</option>
              <option value="has_jobs">Has open jobs</option>
              <option value="no_jobs">No jobs (enrich-only)</option>
            </select>
          </label>

          <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 18 }}>
            <input
              type="checkbox"
              checked={needsEnrichment}
              onChange={(e) => setNeedsEnrichment(e.target.checked)}
            />
            <span style={{ fontSize: "0.85em" }}>Needs enrichment</span>
          </label>
        </div>
      </Panel>

      <Panel
        title="Companies"
        eyebrow={`pa-companies · orderBy updatedAt desc · ${PAGE_SIZE}/page`}
        actions={
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {bulkMsg ? (
              <span style={{ fontSize: "0.8em", color: "#16a34a" }}>{bulkMsg}</span>
            ) : null}
            {bulkErr ? (
              <span style={{ fontSize: "0.8em", color: "#dc2626" }}>{bulkErr}</span>
            ) : null}
            <button
              type="button"
              disabled={selected.size === 0 || bulkBusy}
              onClick={() => void reenrichSelected()}
              style={{
                padding: "4px 12px",
                background: selected.size === 0 ? "#94a3b8" : "#1a73e8",
                color: "white",
                border: "none",
                borderRadius: 4,
                cursor: selected.size === 0 ? "not-allowed" : "pointer",
              }}
            >
              {bulkBusy ? "Queuing…" : `Re-enrich selected (${selected.size})`}
            </button>
          </div>
        }
      >
        {err ? <ErrorState message={err} /> : null}
        {loading ? (
          <LoadingState label="Loading companies…" />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No companies yet"
            body="pa-companies is empty. Phase A5 nightly enrichment will populate it from matching-jobs companyName."
            action={
              <button type="button" onClick={() => setShowCreate(true)}>
                Create company
              </button>
            }
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            title="No companies match the current filters"
            body="Clear filters or load more rows to expand the result set."
          />
        ) : (
          <div className="table-shell">
            <table style={{ width: "100%", fontSize: "0.85em" }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid #e2e8f0" }}>
                  <th style={{ padding: "0.5rem 0", width: 28 }}>
                    <input
                      type="checkbox"
                      checked={
                        filtered.length > 0 && filtered.every((r) => selected.has(r.id))
                      }
                      onChange={toggleSelectAll}
                      aria-label="Select all visible"
                    />
                  </th>
                  <th style={{ padding: "0.5rem 0" }}>Company</th>
                  <th style={{ padding: "0.5rem 0", minWidth: 140 }}>Stage</th>
                  <th style={{ padding: "0.5rem 0", minWidth: 260 }}>Tags</th>
                  <th style={{ padding: "0.5rem 0", textAlign: "right", minWidth: 60 }}>Jobs</th>
                  <th style={{ padding: "0.5rem 0", textAlign: "center", minWidth: 100 }}>Collab</th>
                  <th style={{ padding: "0.5rem 0" }}>Source</th>
                  <th style={{ padding: "0.5rem 0" }}>Enriched</th>
                  <th style={{ padding: "0.5rem 0" }}>Last reviewed</th>
                  <th style={{ padding: "0.5rem 0", minWidth: 150 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => {
                  const tagsHave = new Set<CompanyTag>(row.companyTags ?? [])
                  const isSaving = savingId === row.id
                  return (
                    <tr key={row.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                      <td style={{ padding: "0.4rem 0" }}>
                        <input
                          type="checkbox"
                          checked={selected.has(row.id)}
                          onChange={() => toggleSelect(row.id)}
                          aria-label={`Select ${row.displayName ?? row.id}`}
                        />
                      </td>
                      <td style={{ padding: "0.4rem 0" }}>
                        <div style={{ fontWeight: 500 }}>
                          {row.displayName ?? row.normalizedName ?? row.id}
                        </div>
                        <div style={{ fontSize: "0.78em", color: "#94a3b8", fontFamily: "monospace" }}>
                          {row.id}
                        </div>
                        {rowErr[row.id] ? (
                          <div style={{ fontSize: "0.75em", color: "#dc2626" }}>
                            save failed: {rowErr[row.id]}
                          </div>
                        ) : null}
                      </td>
                      <td style={{ padding: "0.4rem 0" }}>
                        <select
                          value={row.companyStage ?? "unknown"}
                          disabled={isSaving}
                          onChange={(e) => setStage(row, e.target.value as CompanyStage)}
                          style={{
                            padding: "2px 6px",
                            fontSize: "0.85em",
                            border: "1px solid #e2e8f0",
                            borderRadius: 4,
                            background: isSaving ? "#f8fafc" : "white",
                          }}
                        >
                          {COMPANY_STAGE_VOCAB.map((s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td style={{ padding: "0.4rem 0" }}>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                          {COMPANY_TAG_VOCAB.map((t) => {
                            const active = tagsHave.has(t)
                            return (
                              <button
                                key={t}
                                type="button"
                                disabled={isSaving}
                                onClick={() => toggleTag(row, t)}
                                style={{
                                  padding: "1px 6px",
                                  fontSize: "0.72em",
                                  fontFamily: "monospace",
                                  border: active ? "1px solid #1a73e8" : "1px solid #e2e8f0",
                                  background: active ? "#eff6ff" : "#ffffff",
                                  color: active ? "#1a73e8" : "#64748b",
                                  borderRadius: 999,
                                  cursor: isSaving ? "not-allowed" : "pointer",
                                }}
                              >
                                {t}
                              </button>
                            )
                          })}
                          {/* Custom tags outside seed vocab still rendered as readonly chips. */}
                          {(row.companyTags ?? [])
                            .filter((t) => !(COMPANY_TAG_VOCAB as readonly string[]).includes(t))
                            .map((t) => (
                              <span
                                key={t}
                                style={{
                                  padding: "1px 6px",
                                  fontSize: "0.72em",
                                  fontFamily: "monospace",
                                  border: "1px dashed #cbd5e1",
                                  background: "#f8fafc",
                                  color: "#64748b",
                                  borderRadius: 999,
                                }}
                                title="Open-vocab tag (not in seed list)"
                              >
                                {t}
                              </span>
                            ))}
                        </div>
                      </td>
                      <td
                        style={{
                          padding: "0.4rem 0",
                          textAlign: "right",
                          fontFamily: "monospace",
                          fontSize: "0.85em",
                          color: (row.jobsCount ?? 0) > 0 ? "#16a34a" : "#94a3b8",
                        }}
                        title={
                          row.jobsCountUpdatedAt
                            ? `Updated ${fmtTimestamp(row.jobsCountUpdatedAt)}`
                            : "Never synced — paCompaniesJobCountSync hasn't run for this row"
                        }
                      >
                        {row.jobsCount ?? "—"}
                      </td>
                      <td style={{ padding: "0.4rem 0", textAlign: "center" }}>
                        <button
                          type="button"
                          disabled={isSaving}
                          onClick={() => toggleCollab(row)}
                          aria-pressed={row.wekruitCollab === true}
                          title={
                            row.wekruitCollab === true
                              ? "Active WeKruit partner — click to revoke"
                              : "Not a partner — click to mark as collab"
                          }
                          style={{
                            padding: "2px 10px",
                            fontSize: "0.78em",
                            fontWeight: 600,
                            border:
                              row.wekruitCollab === true
                                ? "1px solid #16a34a"
                                : "1px solid #e2e8f0",
                            background:
                              row.wekruitCollab === true ? "#dcfce7" : "#ffffff",
                            color: row.wekruitCollab === true ? "#15803d" : "#64748b",
                            borderRadius: 999,
                            cursor: isSaving ? "not-allowed" : "pointer",
                          }}
                        >
                          {row.wekruitCollab === true ? "✓ Collab" : "Mark"}
                        </button>
                      </td>
                      <td style={{ padding: "0.4rem 0", fontFamily: "monospace", fontSize: "0.78em" }}>
                        {row.enrichmentSource ?? "—"}
                      </td>
                      <td style={{ padding: "0.4rem 0", fontSize: "0.78em" }}>
                        {fmtTimestamp(row.enrichedAt)}
                      </td>
                      <td style={{ padding: "0.4rem 0", fontSize: "0.78em" }}>
                        {row.lastReviewedBy ?? "—"}
                      </td>
                      <td style={{ padding: "0.4rem 0", fontSize: "0.8em", whiteSpace: "nowrap" }}>
                        <Link to={`/admin/external-supply/jobs/${encodeURIComponent(row.id)}`}>Jobs</Link>
                        {" · "}
                        <Link to={`/admin/jobs/new?companyId=${encodeURIComponent(row.id)}`}>Create job</Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {hasMore ? (
          <div style={{ marginTop: 12, textAlign: "center" }}>
            <button
              type="button"
              disabled={loadingMore}
              onClick={() => void loadMore()}
              style={{
                padding: "6px 16px",
                border: "1px solid #e2e8f0",
                borderRadius: 4,
                background: "white",
                cursor: loadingMore ? "wait" : "pointer",
              }}
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          </div>
        ) : null}
      </Panel>
    </div>
  )
}
