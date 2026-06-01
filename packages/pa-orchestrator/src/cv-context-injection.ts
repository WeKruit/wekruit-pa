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
 * Pure renderer — exported for unit tests. Returns null only when EVERY field
 * is empty (no name, no skills, no experience, no education, no tags). When
 * any field is present, render the directive — the CRITICAL block asserts the
 * CV is uploaded, which still works with sparse data.
 *
 * Stream H5 — directive HARDENED. Soft "when natural" phrasing was giving
 * nano explicit permission to skip CV grounding (10/10 turns came back with
 * "send me your CV" despite the doc being injected). New directive
 * unambiguously asserts possession of the CV + names the example good-reply
 * pattern + lists the forbidden "send me your CV" patterns.
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

  // Stream H5 — only return null if literally NOTHING is parseable. Sparse
  // doc (e.g. just name + skills, no experiences) still asserts "CV uploaded".
  const hasAnyContent =
    safeStr(cp.name) !== null ||
    skills.length > 0 ||
    experiences.length > 0 ||
    education.length > 0 ||
    tags.length > 0
  if (!hasAnyContent) return null

  const lines: string[] = [
    "## User CV Profile (THE USER HAS ALREADY UPLOADED THEIR CV — content below is authoritative)",
  ]
  lines.push(`Name: ${name}`)
  lines.push(`Skills: ${skills.length > 0 ? skills.join(", ") : "(none listed)"}`)
  if (recentRole) lines.push(`Recent role: ${recentRole}`)
  if (edu) lines.push(`Education: ${edu}`)
  if (tags.length > 0) {
    lines.push(`Industry tags (top guesses from CV): ${tags.join(", ")}`)
  }
  lines.push("")
  lines.push("CRITICAL — read this carefully:")
  lines.push(
    "- The user has already uploaded their resume. The facts above are EXTRACTED from that real resume — they are authoritative."
  )
  lines.push(
    "- When the user mentions resume / CV / \"I sent it\" / \"just sent it\" / \"sent it over\", DO NOT ask them to send it again. The resume is in front of you NOW."
  )
  lines.push(
    "- Your FIRST reply after detecting any CV-related user message (\"sent my resume\", \"just sent it\", \"take a look at my CV\", \"sent my CV\", etc.) MUST literally include AT LEAST ONE concrete noun from above — the company name (e.g. NEUROVA), the role title (e.g. Data Analyst), or a named skill (e.g. Python, SQL, Tableau). Do not paraphrase. Do not say \"that experience\" or \"those key parts\" — name the actual thing from the Skills/Recent role list above."
  )
  // Stream H5 — build a CONCRETE pre-filled example using THIS user's actual
  // CV data so nano sees a fully-resolved string rather than a fill-in-the-blank
  // template. Instruction-following improves dramatically when the example is
  // literal (we observed nano interpreting "replace NEUROVA with..." as "ask
  // the user for their company name").
  const exampleCompany = topCompany ?? (tags[0] ?? "your most recent role")
  const exampleTitle = topTitle ?? "what you've been working on"
  const exampleSkill = skills[0] ?? "the tools you've used"
  lines.push(
    `- Example good first reply (FULLY PRE-FILLED — use these exact nouns, do not paraphrase): "Saw your ${exampleCompany} ${exampleTitle} gig — the ${exampleSkill} side jumped out. What part felt most yours?"`
  )
  lines.push(
    "- Bad replies (NEVER do these): \"send me your CV\", \"send it over and I'll take a look\", \"I'll give you some tips after I look\", \"paste again\", \"paste it here\". The CV is ALREADY in your system prompt above — never ask for it to be re-sent or re-pasted."
  )
  lines.push(
    "- If a specific field above is sparse or missing for what the user is asking, ASSERT possession of the resume but acknowledge the specific gap (\"I've got your resume — could you fill me in on [specific field]?\") — never claim the resume isn\'t uploaded."
  )
  return lines.join("\n")
}
