import * as React from "react"
import type { ReactNode } from "react"

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string
  title: string
  description?: string
  actions?: ReactNode
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  )
}

export function Panel({
  title,
  eyebrow,
  children,
  actions,
}: {
  title?: string
  eyebrow?: string
  children: ReactNode
  actions?: ReactNode
}) {
  return (
    <section className="panel">
      {title ? (
        <div className="section-title">
          <div>
            {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
            <h2>{title}</h2>
          </div>
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  )
}

export function StatusBadge({ value }: { value?: string | null }) {
  const normalized = value || "unknown"
  const tone =
    normalized === "completed" || normalized === "sent" || normalized === "active"
      ? "good"
      : normalized === "failed" || normalized === "dead_letter"
        ? "bad"
        : normalized === "processing" || normalized === "sending" || normalized === "pending"
          ? "warn"
          : "muted"
  return <span className={`status-badge ${tone}`}>{normalized}</span>
}

// v1.8 — tone-explicit badge variant (Phase 78/79 dashboards consume this
// instead of StatusBadge so they can hand-pick the visual tone for
// terminal states, question types, etc., independent of the legacy
// status-string heuristic above).
export function Badge({
  tone,
  children,
}: {
  tone: "ok" | "warn" | "info" | "muted"
  children: ReactNode
}) {
  const cls = tone === "ok" ? "good" : tone === "warn" ? "bad" : tone === "info" ? "warn" : "muted"
  return <span className={`status-badge ${cls}`}>{children}</span>
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string
  body: string
  action?: ReactNode
}) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      <p>{body}</p>
      {action ? <div>{action}</div> : null}
    </div>
  )
}

export function ErrorState({ message }: { message: string }) {
  return <div className="notice notice-bad">Error: {message}</div>
}

export function LoadingState({ label = "Loading..." }: { label?: string }) {
  return <div className="loading-state">{label}</div>
}

export type DataTableColumn<T> = {
  key: string
  header: string
  render: (row: T) => ReactNode
}

export function DataTable<T extends { id: string | number }>({
  rows,
  columns,
  empty,
}: {
  rows: T[]
  columns: DataTableColumn<T>[]
  empty: ReactNode
}) {
  if (rows.length === 0) return <>{empty}</>
  return (
    <div className="table-shell">
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key}>{column.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.id)}>
              {columns.map((column) => (
                <td key={column.key}>{column.render(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
