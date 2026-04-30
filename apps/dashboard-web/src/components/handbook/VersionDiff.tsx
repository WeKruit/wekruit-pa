/**
 * Phase 29 T2 — section-level diff vs previous version. Side-by-side view
 * with green/red highlighting per section. Pre-save preview lives in the
 * page header; this component also renders historical diffs from the
 * version drawer.
 */
import { diffSections, type HandbookSections } from "../../lib/handbook-api.js"

export function VersionDiff({
  before,
  after,
  beforeLabel,
  afterLabel,
}: {
  before: HandbookSections
  after: HandbookSections
  beforeLabel?: string
  afterLabel?: string
}) {
  const rows = diffSections(before, after)
  const changed = rows.filter((r) => r.changed)
  if (changed.length === 0) {
    return (
      <div style={{ color: "#64748b", fontStyle: "italic", padding: "0.5rem" }}>
        No section changes ({beforeLabel ?? "before"} vs {afterLabel ?? "after"}).
      </div>
    )
  }
  return (
    <div>
      <div style={{ fontSize: "0.85em", marginBottom: 8, color: "#64748b" }}>
        {changed.length} section{changed.length === 1 ? "" : "s"} changed
      </div>
      {changed.map((row) => (
        <div
          key={row.key}
          style={{
            border: "1px solid #e2e8f0",
            borderRadius: 6,
            marginBottom: 8,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              background: "#f1f5f9",
              padding: "6px 10px",
              fontSize: "0.85em",
              fontWeight: 600,
            }}
          >
            {row.key}
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 0,
              fontFamily: "monospace",
              fontSize: "0.8em",
            }}
          >
            <pre
              style={{
                padding: 8,
                background: "#fef2f2",
                margin: 0,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                borderRight: "1px solid #e2e8f0",
              }}
            >
              {row.beforeText || "(empty)"}
            </pre>
            <pre
              style={{
                padding: 8,
                background: "#f0fdf4",
                margin: 0,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {row.afterText || "(empty)"}
            </pre>
          </div>
        </div>
      ))}
      <div
        style={{
          display: "flex",
          gap: 4,
          fontSize: "0.75em",
          color: "#64748b",
          marginTop: 4,
        }}
      >
        <span style={{ background: "#fef2f2", padding: "0 6px" }}>
          {beforeLabel ?? "before"}
        </span>
        <span style={{ background: "#f0fdf4", padding: "0 6px" }}>
          {afterLabel ?? "after"}
        </span>
      </div>
    </div>
  )
}
