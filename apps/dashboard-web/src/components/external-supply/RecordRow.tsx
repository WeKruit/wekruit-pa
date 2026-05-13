/**
 * v2.0 External Supply V1 — Wave D — Per-record table row for BatchDetail.
 *
 * Renders the redacted email + canonical LinkedIn URL (link only, never
 * full PII in href text) + identity-status pill + action menu.
 */
import type { ExternalCandidateRecord } from "@pa/core-types"
import { IdentityStatusBadge } from "./IdentityStatusBadge.js"
import { RedactedField } from "./RedactedField.js"

export type RecordRowAction = "view_conflict" | "re_resolve" | "view_audit"

export function RecordRow({
  record,
  onAction,
}: {
  record: ExternalCandidateRecord
  onAction?: (recordId: string, action: RecordRowAction) => void
}) {
  const primaryEmail = record.emails[0]?.value
  return (
    <tr key={record.recordId} style={{ borderBottom: "1px solid #f1f5f9" }}>
      <td style={{ padding: "0.4rem 0", fontFamily: "monospace", fontSize: "0.75em" }}>
        {record.recordId.slice(0, 8)}…
      </td>
      <td style={{ padding: "0.4rem 0" }}>{record.name ?? "—"}</td>
      <td style={{ padding: "0.4rem 0", fontSize: "0.85em" }}>
        {record.currentTitle ? (
          <>
            <span>{record.currentTitle}</span>
            {record.currentCompany ? (
              <span style={{ color: "#64748b" }}> @ {record.currentCompany}</span>
            ) : null}
          </>
        ) : (
          "—"
        )}
      </td>
      <td style={{ padding: "0.4rem 0" }}>
        <RedactedField value={primaryEmail} kind="email" context={record.recordId} />
      </td>
      <td style={{ padding: "0.4rem 0" }}>
        {record.canonicalLinkedInUrl ? (
          <a
            href={record.canonicalLinkedInUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "#1a73e8", fontSize: "0.85em" }}
          >
            {record.canonicalLinkedInUrl.replace(/^https?:\/\/(www\.)?/, "")}
          </a>
        ) : (
          <span style={{ color: "#94a3b8" }}>—</span>
        )}
      </td>
      <td style={{ padding: "0.4rem 0" }}>
        <IdentityStatusBadge status={record.identityResolutionStatus} />
      </td>
      <td style={{ padding: "0.4rem 0", fontSize: "0.85em" }}>
        {record.resolvedUserId ? (
          <code style={{ fontSize: "0.85em" }}>{record.resolvedUserId.slice(0, 8)}…</code>
        ) : (
          <span style={{ color: "#94a3b8" }}>—</span>
        )}
      </td>
      <td style={{ padding: "0.4rem 0" }}>
        {onAction && (
          <div style={{ display: "flex", gap: 4 }}>
            {record.resolutionConflictId && (
              <button
                type="button"
                onClick={() => onAction(record.recordId, "view_conflict")}
                style={menuBtnStyle}
              >
                Conflict
              </button>
            )}
            <button
              type="button"
              onClick={() => onAction(record.recordId, "view_audit")}
              style={menuBtnStyle}
            >
              Audit
            </button>
          </div>
        )}
      </td>
    </tr>
  )
}

const menuBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "1px solid #cbd5e1",
  borderRadius: 4,
  padding: "2px 6px",
  fontSize: "0.75em",
  cursor: "pointer",
  color: "#475569",
}
