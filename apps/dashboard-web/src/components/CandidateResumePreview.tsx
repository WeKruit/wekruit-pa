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

export type ParsedResumeView = {
  profile?: string
  experiences?: Array<{ title?: string; company?: string; startDate?: string; endDate?: string; location?: string; description?: string }>
  education?: Array<{ school?: string; degree?: string; field?: string }>
  skills?: string[]
}

export function CandidateResumePreview({
  resumeUrl,
  fileName,
  linkedinUrl,
  parsedSummary,
  parsed,
  height = "72vh",
  title = "Résumé",
}: {
  resumeUrl?: string
  fileName?: string
  linkedinUrl?: string
  parsedSummary?: string
  /** Full parsed résumé (shown when there is no PDF on file). */
  parsed?: ParsedResumeView
  /** iframe height — accepts any CSS length (default a tall 72vh). */
  height?: number | string
  title?: string
}) {
  const trimmedUrl = resumeUrl?.trim() || undefined
  const trimmedLinkedin = linkedinUrl?.trim() || undefined
  const summary = parsedSummary?.trim() || undefined
  const hasParsed = Boolean(parsed && ((parsed.experiences?.length ?? 0) > 0 || (parsed.education?.length ?? 0) > 0 || (parsed.skills?.length ?? 0) > 0 || parsed.profile))
  const { embedUrl } = toResumeEmbedUrl(trimmedUrl)

  // Nothing to show at all → render nothing (keeps panels clean).
  if (!trimmedUrl && !trimmedLinkedin && !summary && !hasParsed) return null

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
      ) : hasParsed ? (
        <ParsedResumeBlock parsed={parsed!} summary={summary} />
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

/** Render the parsed résumé (no original PDF on file) — experience, education,
 *  skills — so reviewers still see a real résumé, not just a one-line summary. */
function ParsedResumeBlock({ parsed, summary }: { parsed: ParsedResumeView; summary?: string }) {
  const dates = (a?: string, b?: string) => [a, b].filter(Boolean).join(" – ") || undefined
  return (
    <div style={parsedWrap}>
      <div style={parsedNote}>No original file on record — showing the parsed résumé.</div>
      {parsed.profile || summary ? <div style={parsedProfile}>{parsed.profile || summary}</div> : null}

      {parsed.experiences && parsed.experiences.length > 0 ? (
        <div>
          <div style={parsedH}>Experience</div>
          {parsed.experiences.map((e, i) => (
            <div key={i} style={parsedItem}>
              <div style={parsedItemTop}>
                <span style={{ fontWeight: 600, color: "#1f2937" }}>{[e.title, e.company].filter(Boolean).join(" · ") || "—"}</span>
                {dates(e.startDate, e.endDate) ? <span style={parsedDim}>{dates(e.startDate, e.endDate)}</span> : null}
              </div>
              {e.location ? <div style={parsedDim}>{e.location}</div> : null}
              {e.description ? <div style={parsedDesc}>{e.description}</div> : null}
            </div>
          ))}
        </div>
      ) : null}

      {parsed.education && parsed.education.length > 0 ? (
        <div>
          <div style={parsedH}>Education</div>
          {parsed.education.map((e, i) => (
            <div key={i} style={parsedItem}>
              <span style={{ fontWeight: 600, color: "#1f2937" }}>{e.school || "—"}</span>
              {[e.degree, e.field].filter(Boolean).length ? (
                <div style={parsedDim}>{[e.degree, e.field].filter(Boolean).join(" · ")}</div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {parsed.skills && parsed.skills.length > 0 ? (
        <div>
          <div style={parsedH}>Skills</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {parsed.skills.map((s, i) => (
              <span key={i} style={parsedChip}>{s.replace(/_/g, " ")}</span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

const parsedWrap: CSSProperties = { display: "grid", gap: 14, maxHeight: "72vh", overflowY: "auto", paddingRight: 4 }
const parsedNote: CSSProperties = { fontSize: 12, color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 6, padding: "6px 10px" }
const parsedProfile: CSSProperties = { fontSize: 13.5, lineHeight: 1.55, color: "#334155" }
const parsedH: CSSProperties = { fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#94a3b8", marginBottom: 8, borderBottom: "1px solid #eee6da", paddingBottom: 4 }
const parsedItem: CSSProperties = { marginBottom: 12 }
const parsedItemTop: CSSProperties = { display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline", flexWrap: "wrap" }
const parsedDim: CSSProperties = { fontSize: 12, color: "#94a3b8" }
const parsedDesc: CSSProperties = { fontSize: 13, lineHeight: 1.5, color: "#475569", marginTop: 3 }
const parsedChip: CSSProperties = { fontSize: 12, color: "#374151", background: "#f1f5f9", borderRadius: 999, padding: "3px 10px" }

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
