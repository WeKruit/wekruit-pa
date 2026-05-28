/**
 * useTable — unified state primitive for admin tables.
 *
 *   const t = useTable(rows, {
 *     defaultSort: { key: "createdAt", dir: "desc" },
 *     pageSize: 50,
 *     searchableFields: ["name", "email"],
 *     chips: { state: { ... }, source: { ... } },
 *   })
 *   <DataTable rows={t.visibleRows} columns={...} sort={t.sort} onSort={t.setSort}
 *              page={t.page} pageSize={t.pageSize} totalRows={t.filteredRows.length}
 *              onPageChange={t.setPage} chips={t.chipsForRender} ... />
 *
 * Pure client-side filter + sort + page. URL hash sync optional.
 */
import { useCallback, useMemo, useState } from "react"

export type SortDir = "asc" | "desc"
export interface SortState {
  key: string
  dir: SortDir
}

export interface ChipDef<T> {
  /** Stable id per chip row, e.g. "state" / "source" / "identity". */
  id: string
  /** Label shown to the left of the chip row, e.g. "STATE", "SOURCE". */
  label: string
  /** Whether multiple chips in this row can be active simultaneously. */
  multi?: boolean
  /** Chip options. */
  options: Array<{
    key: string
    label: string
    /** Optional tooltip shown on hover (explains the predicate). */
    title?: string
    /** Predicate. Returns true if `row` matches this chip. */
    test: (row: T) => boolean
  }>
}

export interface UseTableOptions<T> {
  defaultSort?: SortState
  pageSize?: number
  /** Free-text search: tests each row against the query (lowercased). */
  search?: (row: T, query: string) => boolean
  /** Chip rows. Each row filters via its active chips (multi-AND across rows). */
  chips?: ChipDef<T>[]
  /** Manual filter predicate (always applied). */
  prefilter?: (row: T) => boolean
}

export interface ChipForRender {
  id: string
  label: string
  multi: boolean
  options: Array<{
    key: string
    label: string
    title?: string
    count: number
    active: boolean
    onClick: () => void
  }>
}

export interface UseTableResult<T> {
  // Visible (post-filter, post-sort, paged) rows.
  visibleRows: T[]
  // Post-filter rows (pre-pagination, post-sort).
  filteredRows: T[]
  totalRows: number
  filteredCount: number
  search: string
  setSearch: (s: string) => void
  sort: SortState | null
  setSort: (s: SortState | null) => void
  toggleSort: (key: string) => void
  page: number
  setPage: (p: number) => void
  pageSize: number
  setPageSize: (n: number) => void
  pageCount: number
  // Chip state — keyed by `chips[].id`, value is Set of active option keys.
  activeChips: Record<string, Set<string>>
  toggleChip: (rowId: string, key: string) => void
  clearChipRow: (rowId: string) => void
  // Renderable chip rows with live counts + click handlers.
  chipsForRender: ChipForRender[]
  // Reset everything.
  reset: () => void
}

export function useTable<T extends { id?: string }>(
  rows: T[],
  options: UseTableOptions<T> = {},
): UseTableResult<T> {
  const [search, setSearch] = useState("")
  const [sort, setSort] = useState<SortState | null>(options.defaultSort ?? null)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(options.pageSize ?? 50)
  const [activeChips, setActiveChips] = useState<Record<string, Set<string>>>({})

  const toggleSort = useCallback((key: string) => {
    setSort((s) => {
      if (!s || s.key !== key) return { key, dir: "asc" }
      if (s.dir === "asc") return { key, dir: "desc" }
      return null
    })
  }, [])

  const toggleChip = useCallback((rowId: string, key: string) => {
    setActiveChips((prev) => {
      const next = { ...prev }
      const set = new Set(next[rowId] ?? [])
      const chipRow = options.chips?.find((c) => c.id === rowId)
      if (chipRow?.multi === false || chipRow?.multi === undefined) {
        // Exclusive: clicking same chip toggles off, clicking another replaces.
        if (set.has(key)) set.delete(key)
        else { set.clear(); set.add(key) }
      } else {
        if (set.has(key)) set.delete(key)
        else set.add(key)
      }
      if (set.size === 0) delete next[rowId]
      else next[rowId] = set
      return next
    })
    setPage(0)
  }, [options.chips])

  const clearChipRow = useCallback((rowId: string) => {
    setActiveChips((prev) => {
      const next = { ...prev }
      delete next[rowId]
      return next
    })
    setPage(0)
  }, [])

  const reset = useCallback(() => {
    setSearch("")
    setSort(options.defaultSort ?? null)
    setPage(0)
    setActiveChips({})
  }, [options.defaultSort])

  // Filter
  const filteredRows = useMemo(() => {
    let out = rows
    if (options.prefilter) out = out.filter(options.prefilter)
    if (search.trim() && options.search) {
      const q = search.trim().toLowerCase()
      out = out.filter((r) => options.search!(r, q))
    }
    for (const [rowId, set] of Object.entries(activeChips)) {
      const chipRow = options.chips?.find((c) => c.id === rowId)
      if (!chipRow || set.size === 0) continue
      out = out.filter((r) => {
        for (const k of set) {
          const opt = chipRow.options.find((o) => o.key === k)
          if (opt?.test(r)) return true
        }
        return false
      })
    }
    return out
  }, [rows, search, activeChips, options])

  // Sort
  const sortedRows = useMemo(() => {
    if (!sort) return filteredRows
    const factor = sort.dir === "asc" ? 1 : -1
    return [...filteredRows].sort((a, b) => {
      const av = (a as Record<string, unknown>)[sort.key]
      const bv = (b as Record<string, unknown>)[sort.key]
      if (av == null && bv == null) return 0
      if (av == null) return 1 * factor
      if (bv == null) return -1 * factor
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * factor
      return String(av).localeCompare(String(bv)) * factor
    })
  }, [filteredRows, sort])

  // Page
  const pageCount = Math.max(1, Math.ceil(sortedRows.length / pageSize))
  const safePage = Math.min(page, pageCount - 1)
  const visibleRows = useMemo(
    () => sortedRows.slice(safePage * pageSize, (safePage + 1) * pageSize),
    [sortedRows, safePage, pageSize],
  )

  // Chip rows with live counts (counts always over `rows` post-prefilter, not
  // post-other-chips — easier for operator to reason about).
  const baseRowsForChipCounts = useMemo(() => {
    return options.prefilter ? rows.filter(options.prefilter) : rows
  }, [rows, options.prefilter])

  const chipsForRender: ChipForRender[] = useMemo(() => {
    if (!options.chips) return []
    return options.chips.map((c) => ({
      id: c.id,
      label: c.label,
      multi: c.multi ?? false,
      options: c.options.map((o) => ({
        key: o.key,
        label: o.label,
        title: o.title,
        count: baseRowsForChipCounts.filter((r) => o.test(r)).length,
        active: activeChips[c.id]?.has(o.key) ?? false,
        onClick: () => toggleChip(c.id, o.key),
      })),
    }))
  }, [options.chips, baseRowsForChipCounts, activeChips, toggleChip])

  return {
    visibleRows,
    filteredRows: sortedRows,
    totalRows: rows.length,
    filteredCount: sortedRows.length,
    search,
    setSearch,
    sort,
    setSort,
    toggleSort,
    page: safePage,
    setPage,
    pageSize,
    setPageSize,
    pageCount,
    activeChips,
    toggleChip,
    clearChipRow,
    chipsForRender,
    reset,
  }
}
