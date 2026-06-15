/**
 * Pure résumé-URL → embeddable-URL logic, split out from CandidateResumePreview so it can
 * be unit-tested without pulling in React.
 */
export type ResumeEmbed = { embedUrl: string | null; kind: "drive" | "pdf" | "gview" | "none" }

/** Rewrite a résumé URL into something an <iframe> can render. Pure + testable. */
export function toResumeEmbedUrl(rawUrl: string | undefined | null): ResumeEmbed {
  const url = (rawUrl ?? "").trim()
  if (!url) return { embedUrl: null, kind: "none" }
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return { embedUrl: null, kind: "none" }
  }
  const host = u.host.toLowerCase()

  // Google Drive: /file/d/{id}/view · /open?id={id} · ?id={id}  →  /file/d/{id}/preview
  // Exact host (or a real subdomain) — `endsWith` alone would also accept a spoofed
  // host like `evildrive.google.com`.
  if (host === "drive.google.com" || host.endsWith(".drive.google.com")) {
    const m = u.pathname.match(/\/file\/d\/([^/]+)/)
    const id = m ? m[1] : u.searchParams.get("id") ?? ""
    if (id) return { embedUrl: `https://drive.google.com/file/d/${id}/preview`, kind: "drive" }
  }
  // Google Docs / Sheets / Slides: /{kind}/d/{id}/...  →  /{kind}/d/{id}/preview
  if (host === "docs.google.com" || host.endsWith(".docs.google.com")) {
    const m = u.pathname.match(/\/(document|spreadsheets|presentation)\/d\/([^/]+)/)
    if (m) return { embedUrl: `https://docs.google.com/${m[1]}/d/${m[2]}/preview`, kind: "drive" }
  }
  // Direct PDF — browsers render it inline.
  if (/\.pdf($|\?|#)/i.test(url)) return { embedUrl: url, kind: "pdf" }
  // Anything else (Firebase-Storage .docx, arbitrary host) — best-effort Google viewer.
  return { embedUrl: `https://docs.google.com/viewer?url=${encodeURIComponent(url)}&embedded=true`, kind: "gview" }
}
