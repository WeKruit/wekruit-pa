/**
 * Stream D — CV context injection into Claire's systemPrompt.
 *
 * After the regular handbook compose path (V2 or legacy fallback) finishes,
 * we look up the user's most recently ingested CV (parsedCandidateResumes
 * collection, written by apps/functions/src/cv-ingest/cv-ingest.ts) and
 * append a short profile block so Claire can ground job recommendations
 * and follow-ups in actual experience instead of generic platitudes.
 *
 * Failure-mode contract: ANY error degrades silently (logged) and returns
 * the original systemPrompt unchanged — a missing CV must NEVER black out
 * the orchestrator turn.
 */

import type { Firestore } from "firebase-admin/firestore"

export type CvProfileDoc = {
  candidateProfile?: {
    name?: unknown
    skills?: unknown
  }
  experiences?: Array<{
    company?: unknown
    title?: unknown
    startDate?: unknown
    endDate?: unknown
    location?: unknown
    description?: unknown
  }>
  education?: Array<{
    school?: unknown
    degree?: unknown
    field?: unknown
  }>
  /** Stream F1 — 1..3 canonical industry tags (cv-ingest extracts). */
  industryTags?: unknown
}

const PARSED_RESUMES_COLLECTION = "parsedCandidateResumes"
const FALLBACK_NAME = "Unknown"

function safeStr(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null
}

/**
 * Render the user's most recent parsed CV into a short profile block
 * appended to the systemPrompt. Returns the input unchanged when:
 *   - no userId provided
 *   - lookup throws or returns empty
 *   - the doc is malformed
 */
export async function appendCvContextToSystemPrompt(
  db: Firestore | undefined,
  userId: string | undefined,
  systemPrompt: string,
  log?: (event: string, payload?: Record<string, unknown>) => void
): Promise<string> {
  if (!db || !userId) return systemPrompt
  let doc: CvProfileDoc | null = null
  try {
    const snap = await db
      .collection(PARSED_RESUMES_COLLECTION)
      .where("userId", "==", userId)
      .orderBy("createdAt", "desc")
      .limit(1)
      .get()
    if (snap.empty) return systemPrompt
    doc = snap.docs[0]!.data() as CvProfileDoc
  } catch (err) {
    log?.("pa.cv_context.lookup_failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
    return systemPrompt
  }
  if (!doc) return systemPrompt

  const block = renderCvBlock(doc)
  if (!block) return systemPrompt
  // Trailing-newline-safe append: ensure exactly one blank line separator.
  const trimmed = systemPrompt.replace(/\s+$/, "")
  return `${trimmed}\n\n${block}`
}

/**
 * Pure renderer — exported for unit tests. Returns null if the input is so
 * malformed there is nothing meaningful to inject.
 */
export function renderCvBlock(doc: CvProfileDoc): string | null {
  const cp = doc.candidateProfile && typeof doc.candidateProfile === "object" ? doc.candidateProfile : {}
  const name = safeStr(cp.name) ?? FALLBACK_NAME
  const skills = Array.isArray(cp.skills)
    ? (cp.skills.filter((s) => typeof s === "string") as string[])
    : []
  const experiences = Array.isArray(doc.experiences) ? doc.experiences : []
  const top = experiences[0]
  const topTitle = safeStr(top?.title)
  const topCompany = safeStr(top?.company)
  const topStart = safeStr(top?.startDate)
  const topEnd = safeStr(top?.endDate) ?? "present"
  const recentRole =
    topTitle && topCompany
      ? `${topTitle} at ${topCompany} (${topStart ?? "?"}–${topEnd})`
      : null

  const education = Array.isArray(doc.education) ? doc.education : []
  const edu = education
    .map((e) => {
      const school = safeStr(e?.school)
      const degree = safeStr(e?.degree)
      if (school && degree) return `${school} ${degree}`
      return school ?? degree ?? null
    })
    .filter((s): s is string => s !== null)
    .join("; ")

  // Stream F1 — surface industry tags so Claire can ground probe questions.
  const tags = Array.isArray(doc.industryTags)
    ? (doc.industryTags.filter((t) => typeof t === "string") as string[])
    : []

  const lines: string[] = ["## User CV Profile (extracted from uploaded resume)"]
  lines.push(`Name: ${name}`)
  lines.push(`Skills: ${skills.length > 0 ? skills.join(", ") : "(none listed)"}`)
  if (recentRole) lines.push(`Recent role: ${recentRole}`)
  if (edu) lines.push(`Education: ${edu}`)
  if (tags.length > 0) {
    lines.push(`Industry tags (top guesses from CV): ${tags.join(", ")}`)
  }
  lines.push("")
  lines.push(
    "Use this profile to ground job recommendations and follow-ups. Reference specific experiences when natural (\"看到你在 X 做 Y...\") instead of generic platitudes."
  )
  return lines.join("\n")
}
