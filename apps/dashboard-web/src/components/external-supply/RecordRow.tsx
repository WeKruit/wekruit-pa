/**
 * v2.0 External Supply V1 — Wave D — Per-record table row for BatchDetail.
 *
 * Renders the redacted email + multi-link chip row (linkedin/github/twitter/
 * etc, harvested via the v2.3 multi-link parser into `enrichment.links`) +
 * identity-status pill + action menu.
 *
 * v2026-05-14 update — replaced the truncated single LinkedIn cell with the
 * same chip grid used on `BatchCandidates.tsx` so the operator sees every
 * link on the row at a glance, with hostname tooltips.
 */
import type { ExternalCandidateRecord } from "@pa/core-types"
import { IdentityStatusBadge } from "./IdentityStatusBadge.js"
import { RedactedField } from "./RedactedField.js"

export type RecordRowAction = "view_conflict" | "re_resolve" | "view_audit"

interface LinkChip {
  url: string
  kind: string
  hostname: string
}

const LINK_KIND_BG: Record<string, string> = {
  linkedin: "#dbeafe",
  github: "#f3f4f6",
  twitter: "#e0f2fe",
  facebook: "#dbeafe",
  instagram: "#fce7f3",
  medium: "#f3f4f6",
  youtube: "#fee2e2",
  tiktok: "#0f172a",
  dribbble: "#fce7f3",
  behance: "#dbeafe",
  stackoverflow: "#fef3c7",
  personal: "#dcfce7",
}
const LINK_KIND_FG: Record<string, string> = {
  linkedin: "#1e3a8a",
  github: "#0f172a",
  twitter: "#0c4a6e",
  facebook: "#1e3a8a",
  instagram: "#831843",
  medium: "#1f2937",
  youtube: "#991b1b",
  tiktok: "#f8fafc",
  dribbble: "#831843",
  behance: "#1e3a8a",
  stackoverflow: "#92400e",
  personal: "#166534",
}
const LINK_KIND_LABEL: Record<string, string> = {
  linkedin: "in",
  github: "GH",
  twitter: "X",
  facebook: "FB",
  instagram: "IG",
  medium: "M",
  youtube: "YT",
  tiktok: "TT",
  dribbble: "DR",
  behance: "BE",
  stackoverflow: "SO",
  personal: "site",
}

function deriveLinks(record: ExternalCandidateRecord): LinkChip[] {
  const enrichment = (record.enrichment ?? {}) as { links?: LinkChip[] }
  if (Array.isArray(enrichment.links) && enrichment.links.length > 0) {
    return enrichment.links
  }
  // Fall back to canonicalLinkedInUrl when the upstream parser didn't emit
  // links[] (older records pre-v2.3 multi-link adapter).
  if (record.canonicalLinkedInUrl) {
    return [
      { url: record.canonicalLinkedInUrl, kind: "linkedin", hostname: "linkedin.com" },
    ]
  }
  return []
}

export function RecordRow({
  record,
  onAction,
}: {
  record: ExternalCandidateRecord
  onAction?: (recordId: string, action: RecordRowAction) => void
}) {
  const primaryEmail = record.emails[0]?.value
  const links = deriveLinks(record)
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
        {links.length > 0 ? (
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {links.map((l, i) => (
              <a
                key={`${l.url}-${i}`}
                href={l.url}
                target="_blank"
                rel="noopener noreferrer"
                title={l.url}
                style={{
                  fontSize: "0.7em",
                  fontWeight: 700,
                  padding: "2px 6px",
                  borderRadius: 4,
                  background: LINK_KIND_BG[l.kind] ?? "#f1f5f9",
                  color: LINK_KIND_FG[l.kind] ?? "#475569",
                  textDecoration: "none",
                }}
              >
                {LINK_KIND_LABEL[l.kind] ?? l.hostname.slice(0, 4)}
              </a>
            ))}
          </div>
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
