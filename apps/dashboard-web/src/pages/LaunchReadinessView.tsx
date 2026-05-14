import * as React from "react"
import type { CSSProperties } from "react"

import { Badge, EmptyState, Panel } from "../components/ui.js"
import type { LaunchReadinessSnapshot, LaunchReadinessStatus } from "../lib/launch-readiness-api.js"

export function LaunchReadinessSnapshotView({ snapshot }: { snapshot: LaunchReadinessSnapshot }) {
  return (
    <>
      <Panel title="Readiness Overview" eyebrow={`status ${snapshot.status}`}>
        <div style={overviewGridStyle}>
          <section style={statusPanelStyle}>
            <h3 style={sectionHeadingStyle}>Current status</h3>
            <Badge tone={statusTone(snapshot.status)}>{snapshot.status}</Badge>
          </section>
          {snapshot.sections.map((section) => (
            <section key={section.key} style={statusPanelStyle}>
              <div style={sectionHeaderStyle}>
                <h3 style={sectionHeadingStyle}>{section.label}</h3>
                <Badge tone={statusTone(section.status)}>{section.status}</Badge>
              </div>
              <p style={mutedStyle}>{section.summary ?? "-"}</p>
              {typeof section.count === "number" ? <strong>{section.count}</strong> : null}
            </section>
          ))}
        </div>
      </Panel>

      <Panel title="Privacy Requests" eyebrow={`${snapshot.privacyRequests.length} row(s)`}>
        {snapshot.privacyRequests.length === 0 ? (
          <EmptyState title="No privacy requests" body="No recent privacy request rows are present in this snapshot." />
        ) : (
          <div style={rowStackStyle}>
            {snapshot.privacyRequests.map((row) => (
              <article key={row.requestId} style={cardStyle}>
                <div style={sectionHeaderStyle}>
                  <div>
                    <h3 style={cardTitleStyle}>{row.kind}</h3>
                    <p style={mutedStyle}>{row.requestId} · {formatTimestamp(row.createdAt)}</p>
                  </div>
                  <Badge tone={privacyTone(row.status)}>{row.status}</Badge>
                </div>
                <div style={factGridStyle}>
                  <Fact label="candidate" value={row.candidateId ?? "-"} />
                  <Fact label="surface" value={row.sourceSurface ?? "-"} />
                  <Fact label="updated" value={formatTimestamp(row.updatedAt)} />
                </div>
              </article>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Outreach Stop Controls" eyebrow={`${snapshot.stopControls.length} row(s)`}>
        {snapshot.stopControls.length === 0 ? (
          <EmptyState title="No stop controls" body="No outreach stop-control rows are present in this snapshot." />
        ) : (
          <div style={rowStackStyle}>
            {snapshot.stopControls.map((row) => (
              <article key={row.controlId} style={cardStyle}>
                <div style={sectionHeaderStyle}>
                  <div>
                    <h3 style={cardTitleStyle}>{row.scope}</h3>
                    <p style={mutedStyle}>{row.controlId} · {formatTimestamp(row.updatedAt)}</p>
                  </div>
                  <Badge tone={row.paused ? "warn" : "ok"}>{row.paused ? "paused" : "open"}</Badge>
                </div>
                <div style={factGridStyle}>
                  <Fact label="scope id" value={row.scopeId ?? "-"} />
                  <Fact label="reason" value={row.reason ?? "-"} />
                </div>
              </article>
            ))}
          </div>
        )}
      </Panel>
    </>
  )
}

export function Fact({ label, value }: { label: string; value: string | number }) {
  return (
    <div style={factStyle}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

export function formatTimestamp(value?: string): string {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function statusTone(status: LaunchReadinessStatus): "ok" | "warn" | "info" | "muted" {
  if (status === "green") return "ok"
  if (status === "yellow" || status === "red") return "warn"
  return "muted"
}

function privacyTone(status: string): "ok" | "warn" | "info" | "muted" {
  if (status === "resolved" || status === "cancelled") return "ok"
  if (status === "submitted" || status === "in_review") return "warn"
  if (status === "rejected") return "muted"
  return "info"
}

const overviewGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: 12,
}

const statusPanelStyle: CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  padding: 14,
  display: "grid",
  gap: 8,
}

const sectionHeaderStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
  alignItems: "start",
}

const sectionHeadingStyle: CSSProperties = {
  margin: 0,
  fontSize: 15,
  lineHeight: 1.3,
}

const rowStackStyle: CSSProperties = {
  display: "grid",
  gap: 12,
}

const cardStyle: CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  padding: 14,
  display: "grid",
  gap: 12,
}

const cardTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 16,
  lineHeight: 1.3,
}

const factGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
  gap: 8,
}

const factStyle: CSSProperties = {
  display: "grid",
  gap: 2,
  minWidth: 0,
}

const mutedStyle: CSSProperties = {
  margin: 0,
  color: "#647067",
  overflowWrap: "anywhere",
}
