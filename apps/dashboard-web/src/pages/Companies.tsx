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
import { useEffect, useState, useMemo, useCallback } from "react"
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

function matchesFilters(
  row: CompanyRow,
  stageFilter: CompanyStage | "all",
  tagFilters: CompanyTag[],
  needsEnrichment: boolean,
  search: string,
): boolean {
  if (stageFilter !== "all" && row.companyStage !== stageFilter) return false
  if (tagFilters.length > 0) {
    const have = new Set(row.companyTags ?? [])
    if (!tagFilters.every((t) => have.has(t))) return false
  }
  if (needsEnrichment && !isStale(row)) return false
  if (search) {
    const q = search.toLowerCase()
    const name = (row.displayName ?? row.normalizedName ?? row.id).toLowerCase()
    if (!name.includes(q)) return false
  }
  return true
}

export function Companies() {
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
  const [search, setSearch] = useState("")

  // Selection (bulk re-enrich)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkMsg, setBulkMsg] = useState<string | null>(null)
  const [bulkErr, setBulkErr] = useState<string | null>(null)

  // Per-row save state
  const [savingId, setSavingId] = useState<string | null>(null)
  const [rowErr, setRowErr] = useState<Record<string, string>>({})

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
    () => rows.filter((r) => matchesFilters(r, stageFilter, tagFilters, needsEnrichment, search)),
    [rows, stageFilter, tagFilters, needsEnrichment, search],
  )

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

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Phase A4 / Admin"
        title="Companies"
        description={`Centralized company directory (pa-companies). Inline edit stage + tags. "Needs enrichment" surfaces docs with no source or stale beyond ${STALE_DAYS} days.`}
        actions={
          <button type="button" onClick={() => setRefreshKey((n) => n + 1)} disabled={loading}>
            Refresh
          </button>
        }
      />

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
                  <th style={{ padding: "0.5rem 0" }}>Source</th>
                  <th style={{ padding: "0.5rem 0" }}>Enriched</th>
                  <th style={{ padding: "0.5rem 0" }}>Last reviewed</th>
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
                      <td style={{ padding: "0.4rem 0", fontFamily: "monospace", fontSize: "0.78em" }}>
                        {row.enrichmentSource ?? "—"}
                      </td>
                      <td style={{ padding: "0.4rem 0", fontSize: "0.78em" }}>
                        {fmtTimestamp(row.enrichedAt)}
                      </td>
                      <td style={{ padding: "0.4rem 0", fontSize: "0.78em" }}>
                        {row.lastReviewedBy ?? "—"}
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
