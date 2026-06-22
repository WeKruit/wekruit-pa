/**
 * descriptionMd → recruiter `jdBlocks`.
 *
 * A job's real JD lives on the `pa-jobs` doc as `descriptionMd` (the same field
 * the candidate site renders). The recruiter surfaces (recruiter app + admin
 * board + submission eval) read a separate structured `jdBlocks` field that is
 * only ever hand-authored by the seed script — so for any real collaborated job
 * it comes back empty and the recruiter "Job description" panel is blank.
 *
 * This derives `jdBlocks` from `descriptionMd` at read time (no migration,
 * self-heals every job). Recruiter surfaces are internal, so visa /
 * work-authorization lines are intentionally NOT stripped here (the candidate
 * site strips them at its own render layer).
 *
 * Block model matches what the recruiter renderers consume: a heading starts a
 * block; the lines under it become `body` (markdown preserved — both recruiter
 * renderers parse `- ` bullets out of `body`, and `RoleSheetPage` reads ONLY
 * `body`, so list content must live there, not in a separate `items` array).
 */
export interface JdBlock {
  heading?: string
  body?: string
  kind?: "prose" | "list"
}

/** Heading detection mirrors the candidate site (PublicJob `descriptionHeadingText`). */
function headingText(line: string): string | undefined {
  const md = line.match(/^#{1,6}\s+(.+)$/)
  if (md) return md[1].replace(/\*\*/g, "").trim()
  const bold = line.match(/^\*\*(.+?)\*\*$/)
  if (bold) return bold[1].trim()
  // Short, non-terminated, non-bullet line → treated as a heading (e.g. "About
  // Invoko", "What you'll own"). Same heuristic the candidate renderer uses.
  if (line.length <= 90 && !/[.!?]$/.test(line) && !/^[-*]\s+/.test(line)) {
    return line.replace(/\*\*/g, "").trim()
  }
  return undefined
}

export function descriptionMdToJdBlocks(descriptionMd?: string | null): JdBlock[] {
  const raw = (descriptionMd ?? "").trim()
  if (!raw) return []

  const lines = raw.split(/\r?\n/)
  const blocks: JdBlock[] = []
  let heading: string | undefined
  let bodyLines: string[] = []
  let hasBullet = false

  const flush = () => {
    const body = bodyLines.join("\n").replace(/\n{3,}/g, "\n\n").trim()
    if (heading || body) {
      blocks.push({
        ...(heading ? { heading } : {}),
        ...(body ? { body } : {}),
        kind: hasBullet ? "list" : "prose",
      })
    }
    heading = undefined
    bodyLines = []
    hasBullet = false
  }

  for (const rawLine of lines) {
    const t = rawLine.trim()
    const h = headingText(t)
    if (h !== undefined) {
      flush()
      heading = h
      continue
    }
    if (/^[-*]\s+/.test(t)) {
      hasBullet = true
      bodyLines.push("- " + t.replace(/^[-*]\s+/, "").replace(/\*\*/g, "").trim())
    } else if (t === "") {
      bodyLines.push("")
    } else {
      bodyLines.push(t.replace(/\*\*/g, "").trim())
    }
  }
  flush()

  return blocks
}
