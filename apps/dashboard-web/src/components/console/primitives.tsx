// WeKruit Console — shared primitives.
// TSX port of the design bundle's components.jsx — same className contracts,
// same visual output, typed for React 18 + production codebase use.

import type { CSSProperties, ReactNode } from "react"
import { Fragment, useEffect, useRef, useState } from "react"
import { Icon } from "./Icon.js"

type Tone = "live" | "hitl" | "blocked" | "info" | "neutral"

export function PulseDot({
  tone = "info",
  animated = false,
  size = 8,
  style,
}: {
  tone?: Tone
  animated?: boolean
  size?: number
  style?: CSSProperties
}) {
  return (
    <span
      className={`pulse pulse--${tone}${animated ? " pulse--animated" : ""}`}
      style={{ width: size, height: size, ...style }}
    />
  )
}

export function StatusPill({
  tone = "neutral",
  children,
  dot = false,
  icon = null,
  animated = false,
}: {
  tone?: Tone
  children: ReactNode
  dot?: boolean
  icon?: string | null
  animated?: boolean
}) {
  return (
    <span className={`pill pill--${tone}`}>
      {dot && <PulseDot tone={tone} animated={animated} size={6} />}
      {icon && <Icon name={icon} size={12} />}
      {children}
    </span>
  )
}

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
}: {
  eyebrow?: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="page-head">
      <div style={{ minWidth: 0, flex: 1 }}>
        {eyebrow && (
          <div
            style={{
              fontSize: 11,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              fontWeight: 600,
              color: "var(--ink-3)",
              marginBottom: 8,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {eyebrow}
          </div>
        )}
        <h1 className="page-head__title">{title}</h1>
        {subtitle && <p className="page-head__sub">{subtitle}</p>}
      </div>
      {actions && <div className="page-head__actions">{actions}</div>}
    </div>
  )
}

export type CrumbItem = { label: ReactNode; route?: string }

export function Crumbs({
  items,
  onNavigate,
}: {
  items: CrumbItem[]
  onNavigate?: (route: string) => void
}) {
  return (
    <div className="crumbs">
      {items.map((it, i) => {
        const isLast = i === items.length - 1
        return (
          <Fragment key={i}>
            {i > 0 && <Icon name="chev_r" size={12} className="crumbs__sep" />}
            {isLast || !it.route ? (
              <span className={isLast ? "crumbs__leaf" : undefined}>{it.label}</span>
            ) : (
              <button onClick={() => onNavigate && it.route && onNavigate(it.route)}>
                {it.label}
              </button>
            )}
          </Fragment>
        )
      })}
    </div>
  )
}

export function Tick({ value }: { value: number | string }) {
  const [v, setV] = useState<number | string>(value)
  const prev = useRef<number | string>(value)
  useEffect(() => {
    if (typeof value !== "number") {
      setV(value)
      prev.current = value
      return
    }
    const start = typeof prev.current === "number" ? prev.current : value
    if (start === value) {
      setV(value)
      return
    }
    prev.current = value
    const dur = 700
    const t0 = performance.now()
    let raf = 0
    const loop = (t: number) => {
      const k = Math.min(1, (t - t0) / dur)
      const e = 1 - Math.pow(1 - k, 3)
      setV(Math.round(start + (value - start) * e))
      if (k < 1) raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [value])
  return <>{typeof v === "number" ? v.toLocaleString() : v}</>
}

export type EntitySub = { value: ReactNode; label: ReactNode; tone?: Tone }

export function EntityCard({
  label,
  icon,
  hero,
  heroUnit,
  subs,
  cta,
  ctaIcon,
  tone = "live",
  onClick,
}: {
  label: ReactNode
  icon: string
  hero: number | string
  heroUnit?: ReactNode
  subs: EntitySub[]
  cta?: ReactNode
  ctaIcon?: string
  tone?: Tone
  onClick?: () => void
}) {
  return (
    <button className="ent" onClick={onClick} type="button">
      <div className="ent__top">
        <div className="ent__label">
          <Icon name={icon} size={14} />
          {label}
        </div>
        <PulseDot tone={tone} animated />
      </div>
      <div className="ent__hero">
        <span>
          <Tick value={hero} />
        </span>
        {heroUnit && <span className="ent__hero-unit">{heroUnit}</span>}
      </div>
      <div className="ent__subs">
        {subs.map((s, i) => (
          <div key={i} className="ent__sub">
            <PulseDot tone={s.tone || "neutral"} size={6} />
            <span>
              <b>{s.value}</b> {s.label}
            </span>
          </div>
        ))}
      </div>
      {cta && (
        <div className="ent__cta">
          <span>{cta}</span>
          <Icon name={ctaIcon || "arrow_right"} size={15} className="ent__cta-arrow" />
        </div>
      )}
    </button>
  )
}

export const HITL_TYPE_META: Record<
  string,
  { label: string; icon: string; tone: Tone }
> = {
  enrichment: { label: "Enrichment", icon: "briefcase", tone: "info" },
  merge: { label: "Identity merge", icon: "user_merge", tone: "hitl" },
  match: { label: "Match review", icon: "zap", tone: "hitl" },
  outreach: { label: "Outreach", icon: "send", tone: "info" },
  prescreen: { label: "Prescreen", icon: "message", tone: "hitl" },
  tags: { label: "Tag review", icon: "tag", tone: "info" },
}

export type HitlRow = {
  id?: string
  type: keyof typeof HITL_TYPE_META | string
  object: ReactNode
  objectMeta?: ReactNode
  urgency: "high" | "med" | "low"
  age: string
}

export function HitlInboxRow({
  row,
  onClick,
}: {
  row: HitlRow
  onClick?: (row: HitlRow) => void
}) {
  const meta = HITL_TYPE_META[row.type] || HITL_TYPE_META.match
  const tone: Tone =
    row.urgency === "high" ? "blocked" : row.urgency === "med" ? "hitl" : "info"
  const pillTone: Tone = tone === "info" ? "neutral" : tone
  return (
    <div className="hitl-row" onClick={() => onClick && onClick(row)}>
      <PulseDot tone={tone} animated={row.urgency === "high"} />
      <div className="hitl-row__type">
        <Icon name={meta.icon} size={13} />
        {meta.label}
      </div>
      <div className="hitl-row__obj">
        {row.object}
        {row.objectMeta && <span className="hitl-row__obj-meta">{row.objectMeta}</span>}
      </div>
      <StatusPill tone={pillTone}>
        {row.urgency === "high" ? "High" : row.urgency === "med" ? "Medium" : "Low"}
      </StatusPill>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span className="hitl-row__age">{row.age}</span>
        <Icon name="arrow_right" size={14} className="hitl-row__icon" />
      </div>
    </div>
  )
}

export type Column<R> = {
  key: string
  label: ReactNode
  width?: number | string
  className?: string
  render?: (row: R) => ReactNode
  /** When true the header becomes a button that calls onSort(key). */
  sortable?: boolean
}

export interface DataTableSort {
  key: string
  dir: "asc" | "desc"
}

export interface DataTableChip {
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

export function DataTable<R extends { id?: string }>({
  columns,
  rows,
  onRowClick,
  selectedRowId,
  search,
  onSearch,
  searchPlaceholder = "Search…",
  filters,
  chips,
  count,
  totalCount,
  toolbar = true,
  empty,
  sort,
  onSort,
  page,
  pageCount,
  onPageChange,
  onResetFilters,
}: {
  columns: Column<R>[]
  rows: R[]
  onRowClick?: (row: R) => void
  /** When set, the row whose id matches gets a `dt-row--selected` highlight. */
  selectedRowId?: string | null
  search?: string
  onSearch?: (v: string) => void
  searchPlaceholder?: string
  filters?: { label: ReactNode; value?: ReactNode; onClick?: () => void }[]
  /** Chip filter rows produced by useTable().chipsForRender. */
  chips?: DataTableChip[]
  count?: number
  /** Total row count pre-filter; rendered as "N of M" when both set. */
  totalCount?: number
  toolbar?: boolean
  empty?: ReactNode
  sort?: DataTableSort | null
  onSort?: (key: string) => void
  page?: number
  pageCount?: number
  onPageChange?: (page: number) => void
  onResetFilters?: () => void
}) {
  const showPagination = page !== undefined && pageCount !== undefined && onPageChange && pageCount > 1
  return (
    <div className="dt-shell">
      {chips && chips.length > 0 && (
        <div className="dt-shell__chips">
          {chips.map((chip) => (
            <div key={chip.id} className="dt-chip-row">
              <div className="dt-chip-row__label">{chip.label}</div>
              <div className="dt-chip-row__options">
                {chip.options.map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    className={`dt-chip${opt.active ? " dt-chip--active" : ""}`}
                    title={opt.title}
                    onClick={opt.onClick}
                  >
                    {opt.label} <span className="dt-chip__count">· {opt.count}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {toolbar && (
        <div className="dt-shell__toolbar">
          {onSearch && (
            <div className="dt-search">
              <Icon name="search" size={14} style={{ color: "var(--ink-3)" }} />
              <input
                value={search || ""}
                onChange={(e) => onSearch(e.target.value)}
                placeholder={searchPlaceholder}
              />
            </div>
          )}
          {filters &&
            filters.map((f, i) => (
              <button key={i} className="dt-shell__filter" onClick={f.onClick}>
                <Icon name="filter" size={12} />
                {f.label}
                {f.value && (
                  <span style={{ color: "var(--ink)", fontWeight: 600 }}>· {f.value}</span>
                )}
              </button>
            ))}
          {onResetFilters && (
            <button className="dt-shell__filter" onClick={onResetFilters} title="Clear all filters + search">
              Reset
            </button>
          )}
          {count !== undefined && (
            <div className="dt-shell__count">
              {count.toLocaleString()}
              {totalCount !== undefined && totalCount !== count ? ` of ${totalCount.toLocaleString()}` : ""}{" "}
              {count === 1 ? "row" : "rows"}
            </div>
          )}
        </div>
      )}
      {rows.length === 0 ? (
        empty || (
          <div style={{ padding: 40, textAlign: "center", color: "var(--ink-3)" }}>
            No rows.
          </div>
        )
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="dt">
            <thead>
              <tr>
                {columns.map((c) => {
                  const isSorted = sort?.key === c.key
                  const clickable = c.sortable && onSort
                  const headerCls = [
                    clickable ? "dt-th--sortable" : "",
                    isSorted ? "dt-th--sorted" : "",
                  ].filter(Boolean).join(" ") || undefined
                  return (
                    <th
                      key={c.key}
                      style={{ width: c.width }}
                      className={headerCls}
                      onClick={clickable ? () => onSort(c.key) : undefined}
                      title={clickable ? "Click to sort" : undefined}
                    >
                      {c.label}
                      {c.sortable && (
                        <span className="dt-th__sort">
                          {isSorted ? (sort!.dir === "asc" ? "▲" : "▼") : "↕"}
                        </span>
                      )}
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={r.id || i}
                  onClick={() => onRowClick && onRowClick(r)}
                  className={selectedRowId != null && r.id === selectedRowId ? "dt-row--selected" : undefined}
                  aria-selected={selectedRowId != null && r.id === selectedRowId ? true : undefined}
                >
                  {columns.map((c) => (
                    <td key={c.key} className={c.className}>
                      {c.render
                        ? c.render(r)
                        : ((r as Record<string, ReactNode>)[c.key] as ReactNode)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {showPagination && (
        <div className="dt-shell__pager">
          <button
            type="button"
            disabled={page === 0}
            onClick={() => onPageChange!(Math.max(0, page! - 1))}
          >
            ← Prev
          </button>
          <span>
            Page {page! + 1} of {pageCount}
          </span>
          <button
            type="button"
            disabled={page! >= pageCount! - 1}
            onClick={() => onPageChange!(Math.min(pageCount! - 1, page! + 1))}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  )
}

export type MetricItem = {
  label: ReactNode
  value: ReactNode
  unit?: ReactNode
  delta?: ReactNode
  deltaDir?: "up" | "down"
  sub?: ReactNode
  tone?: Tone
  animated?: boolean
}

export function MetricStrip({ items }: { items: MetricItem[] }) {
  return (
    <div className="strip" style={{ gridTemplateColumns: `repeat(${items.length}, 1fr)` }}>
      {items.map((it, i) => (
        <div key={i} className="strip__cell">
          <div className="strip__label">
            {it.tone && <PulseDot tone={it.tone} animated={it.animated} size={6} />}
            {it.label}
          </div>
          <div className="strip__value">
            <span>{it.value}</span>
            {it.unit && (
              <span
                style={{
                  fontSize: 13,
                  color: "var(--ink-3)",
                  fontFamily: "var(--font-sans)",
                }}
              >
                {it.unit}
              </span>
            )}
            {it.delta && (
              <span
                className={`strip__delta ${
                  it.deltaDir === "up"
                    ? "strip__delta--up"
                    : it.deltaDir === "down"
                      ? "strip__delta--down"
                      : ""
                }`}
              >
                {it.delta}
              </span>
            )}
          </div>
          {it.sub && <div className="strip__sub">{it.sub}</div>}
        </div>
      ))}
    </div>
  )
}

export function EmptyState({
  icon,
  title,
  body,
  cta,
  onCta,
}: {
  icon?: string
  title: ReactNode
  body?: ReactNode
  cta?: ReactNode
  onCta?: () => void
}) {
  return (
    <div className="empty">
      {icon && (
        <div className="empty__icon">
          <Icon name={icon} size={28} />
        </div>
      )}
      <div className="empty__title">{title}</div>
      {body && <p className="empty__body">{body}</p>}
      {cta && (
        <button className="btn btn--primary btn--sm" onClick={onCta}>
          {cta}
        </button>
      )}
    </div>
  )
}

export function SectionHead({
  title,
  count,
  actions,
}: {
  title: ReactNode
  count?: number | string
  actions?: ReactNode
}) {
  return (
    <div className="section-head">
      <h2>
        {title}
        {count !== undefined && <span className="section-head__count">{count}</span>}
      </h2>
      {actions && <div className="section-head__actions">{actions}</div>}
    </div>
  )
}

export function Card({
  title,
  action,
  padded = true,
  serif = false,
  style,
  children,
}: {
  title?: ReactNode
  action?: ReactNode
  padded?: boolean
  serif?: boolean
  style?: CSSProperties
  children: ReactNode
}) {
  return (
    <div className="card" style={{ ...(padded ? null : { padding: 0 }), ...style }}>
      {(title || action) && (
        <div className="card__head" style={padded ? undefined : { padding: "14px 18px 0" }}>
          <div className={serif ? "card__title-serif" : "card__title"}>{title}</div>
          {action}
        </div>
      )}
      {children}
    </div>
  )
}
