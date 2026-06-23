/**
 * descriptionMd → recruiter `jdBlocks` (self-contained copy).
 *
 * recruiter-board-fn is an isolated Cloud Functions codebase that does NOT
 * depend on workspace `@pa/*` packages, so this mirrors the canonical
 * `descriptionMdToJdBlocks` in `@pa/core-types` (packages/core-types/src/
 * job-description.ts). Keep the two in sync.
 *
 * Why: the recruiter board reads a structured `jdBlocks` field that is only ever
 * hand-seeded, so real collaborated jobs show a blank JD. Their actual JD is on
 * the same `pa-jobs` doc as `descriptionMd` (the field the candidate site
 * renders). This derives blocks from it at read time. Recruiter is internal, so
 * visa / work-authorization lines are intentionally NOT stripped.
 */
export interface JdBlock {
  heading: string
  body: string
  kind?: "list" | "prose"
}

function headingText(line: string): string | undefined {
  const md = line.match(/^#{1,6}\s+(.+)$/)
  if (md) return md[1].replace(/\*\*/g, "").trim()
  const bold = line.match(/^\*\*(.+?)\*\*$/)
  if (bold) return bold[1].trim()
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
      blocks.push({ heading: heading ?? "", body, kind: hasBullet ? "list" : "prose" })
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
