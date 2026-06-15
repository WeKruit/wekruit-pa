/**
 * CandidateResumePreview — ONE shared candidate-source + inline-résumé UI used by both
 * the recruiter submission review (RecruiterBoardOps) and the prescreen review drawer
 * (PrescreenReviewDrawers). Prescreen layers its transcript on top; the resume + LinkedIn
 * presentation is identical across both so reviewers get the same surface everywhere.
 *
 * Behavior:
 * - If there's a résumé URL, it renders it INLINE in an iframe (no leaving the page).
 *   Google Drive / Docs links are rewritten to their embeddable `/preview` form, direct
 *   PDFs embed as-is, and anything else (e.g. a Firebase-Storage .docx) goes through the
 *   Google viewer as a best effort. An "Open ↗" link is ALWAYS shown so a frame that a
 *   site blocks (X-Frame-Options) still has a working escape hatch.
 * - With no URL (candidate-upload résumés keep only a parsed summary), it falls back to
 *   the parsed summary text. With neither, it renders nothing.
 */
import { type CSSProperties } from "react"
import { toResumeEmbedUrl } from "./resume-embed.js"

export { toResumeEmbedUrl } from "./resume-embed.js"

export function CandidateResumePreview({
  resumeUrl,
  fileName,
  linkedinUrl,
  parsedSummary,
  height = "72vh",
  title = "Résumé",
}: {
  resumeUrl?: string
  fileName?: string
  linkedinUrl?: string
  parsedSummary?: string
  /** iframe height — accepts any CSS length (default a tall 72vh). */
  height?: number | string
  title?: string
}) {
  const trimmedUrl = resumeUrl?.trim() || undefined
  const trimmedLinkedin = linkedinUrl?.trim() || undefined
  const summary = parsedSummary?.trim() || undefined
  const { embedUrl } = toResumeEmbedUrl(trimmedUrl)

  // Nothing to show at all → render nothing (keeps panels clean).
  if (!trimmedUrl && !trimmedLinkedin && !summary) return null

  return (
    <div style={cardStyle}>
      <div style={headerStyle}>
        <strong style={{ fontSize: 14, color: "#3a2c1e" }}>
          {title}
          {fileName ? <span style={{ color: "#8b7d6d", fontWeight: 500 }}> · {fileName}</span> : null}
        </strong>
        <span style={{ flex: 1 }} />
        {trimmedLinkedin ? (
          <a href={trimmedLinkedin} target="_blank" rel="noreferrer" style={linkStyle} title={trimmedLinkedin}>
            in · LinkedIn ↗
          </a>
        ) : null}
        {trimmedUrl ? (
          <a href={trimmedUrl} target="_blank" rel="noreferrer" style={linkStyle} title={trimmedUrl}>
            Open résumé ↗
          </a>
        ) : null}
      </div>

      {trimmedUrl && embedUrl ? (
        <>
          <iframe
            src={embedUrl}
            title={`${title} preview`}
            style={{
              width: "100%",
              height,
              border: "1px solid #e5ded2",
              borderRadius: 8,
              background: "#fff",
            }}
            loading="lazy"
          />
          <div style={{ fontSize: 11, color: "#a89a88" }}>
            If the preview is blank, the host may block embedding — use “Open résumé ↗”.
          </div>
        </>
      ) : trimmedUrl ? (
        <div style={fallbackStyle}>
          This résumé link can’t be previewed inline. <a href={trimmedUrl} target="_blank" rel="noreferrer">Open it ↗</a>
        </div>
      ) : summary ? (
        <div style={summaryStyle}>{summary}</div>
      ) : null}
    </div>
  )
}

const cardStyle: CSSProperties = {
  border: "1px solid #e5ded2",
  borderRadius: 10,
  background: "#fffdf9",
  padding: 12,
  display: "grid",
  gap: 8,
}

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  flexWrap: "wrap",
}

const linkStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 10px",
  background: "#fff",
  color: "#1d4ed8",
  border: "1px solid #bfdbfe",
  borderRadius: 999,
  fontSize: 12,
  fontWeight: 600,
  textDecoration: "none",
}

const fallbackStyle: CSSProperties = {
  fontSize: 13,
  color: "#6f6256",
  padding: "8px 0",
}

const summaryStyle: CSSProperties = {
  fontSize: 13.5,
  lineHeight: 1.55,
  color: "#334155",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  borderTop: "1px solid #eee6da",
  paddingTop: 10,
  maxHeight: 360,
  overflowY: "auto",
}
