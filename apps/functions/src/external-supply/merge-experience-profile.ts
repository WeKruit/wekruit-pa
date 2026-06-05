/**
 * merge-experience-profile.ts — the UNIFIED experience MERGE + DETERMINE extractor (Adam 2026-06-05).
 *
 * Adam, verbatim intent: "merge the experience between linkedin & resume, and ask llm to determine."
 *
 * THE BUG THIS FIXES: extraction was wrong for uid 8fEwIduUrzxZsblHHsNz —
 * pa-users.tags.recentRoleTitle="Software Engineer Intern", careerStage="junior", yoeRange=[0,1] —
 * because the résumé parse grabbed the (stale, not-updated) résumé's intern role and undercounted YoE,
 * while his LinkedIn clearly shows "Senior Software Engineer" currentRole=true (Feb 2026). NOBODY merged
 * the two sources and let the LLM determine the truth. THIS module is that fix.
 *
 * It makes ONE gpt-5.4-mini json_schema-STRICT call (reuses getOpenAIConfig + the LlmPitchComposer SDK
 * pattern) that:
 *   - MERGES the LinkedIn/Coresignal experiences and the résumé workHistory into ONE canonical timeline:
 *     recognizes the SAME real role across sources (same employer + overlapping span even if titles
 *     differ slightly), DEDUPES to one entry, and when the sources DISAGREE on the current/most-recent
 *     title prefers the MORE RECENT source (LinkedIn's "Senior Software Engineer" Feb 2026 beats the
 *     résumé's stale "Software Engineer Intern"). Keeps résumé bullets as the merged entry's description
 *     (the achievement detail LinkedIn lacks). Keeps every distinct real role from EITHER source.
 *   - DETERMINES from the merged timeline: recentRoleTitle + recentCompany (current / most-recent real
 *     role), careerStage (one of CAREER_STAGE_VOCAB — judged from titles + durations, NOT just the
 *     newest title), yoeRange [lo,hi] = TOTAL FULL-TIME years (EXCLUDE internships).
 *
 * HARD CONSTRAINTS (Adam):
 *   - The merge AND the determination are done by the LLM, in ONE call, response_format json_schema STRICT.
 *   - NO regex classifying text → enum. (careerStage is the LLM's pick; we only VALIDATE membership.)
 *   - careerStage MUST be one of CAREER_STAGE_VOCAB; validate and DROP if invalid.
 *   - FAIL-OPEN: on any LLM error / empty / invalid / no-key, return null so the caller leaves existing
 *     tags + highlights untouched. Enrichment must never crash.
 */
import { CAREER_STAGE_VOCAB } from "@wekruit/shared-tags"

const MERGE_MODEL = "gpt-5.4-mini" // parity with compose-pitch.ts — stronger than nano for the centerpiece.

/** One source experience row (LinkedIn/Coresignal OR résumé workHistory), normalized to what the LLM needs. */
export type SourceExperience = {
  title?: string
  company?: string
  startDate?: string
  endDate?: string
  /** LinkedIn/Coresignal carries this boolean; résumé may too. */
  isCurrent?: boolean
  durationMonths?: number
  /** Résumé bullets / projects carry the real achievement detail LinkedIn lacks. */
  description?: string
}

/** One entry in the merged canonical timeline. */
export type MergedExperience = {
  title: string
  company: string
  startDate?: string
  endDate?: string
  isCurrent: boolean
  description?: string
}

export type MergeAndDetermineResult = {
  mergedExperiences: MergedExperience[]
  recentRoleTitle?: string
  recentCompany?: string
  careerStage?: string
  yoeRange?: [number, number]
}

const MERGE_SYSTEM = [
  "You merge a candidate's work history that arrives from TWO sources — their LinkedIn (fresh role titles,",
  "with startDate/endDate/isCurrent) and their parsed résumé (workHistory with real achievement bullets in",
  "the description) — into ONE canonical timeline, then DETERMINE a few facts from it. Both lists describe",
  "the SAME PERSON. You are NOT picking one source; you MERGE them.",
  "",
  "MERGE RULES:",
  "- Recognize the SAME real role across the two sources: same employer + overlapping time span counts as",
  "  the SAME role even if the titles differ slightly (e.g. 'Software Engineer' vs 'Senior Software",
  "  Engineer' at the same company over the same/adjacent span). DEDUPE it to ONE entry.",
  "- When the two sources DISAGREE on the title of the current / most-recent role, prefer the MORE RECENT",
  "  source. A LinkedIn role marked isCurrent or carrying the latest startDate beats a stale résumé title.",
  "  (Concrete: LinkedIn 'Senior Software Engineer' currentRole=true Feb 2026 MUST win over a résumé",
  "  'Software Engineer Intern' for the most-recent role.)",
  "- Keep the résumé's bullets / description as the merged entry's `description` (the achievement detail",
  "  LinkedIn lacks). If only LinkedIn has a description, keep that.",
  "- Keep EVERY distinct real role from EITHER source. Do NOT drop a role just because it appears in only",
  "  one source. Different roles at the same company over time stay SEPARATE entries.",
  "- Never invent a role, title, employer, date, or description. Use only what the sources provide.",
  "",
  "DETERMINE (from the MERGED timeline, not from a single newest title):",
  "- recentRoleTitle + recentCompany = the candidate's CURRENT / most-recent real role (the merged entry",
  "  with isCurrent true, else the one with the latest startDate).",
  "- careerStage = ONE value chosen from this CLOSED set ONLY:",
  "    " + CAREER_STAGE_VOCAB.join(", "),
  "  ANCHOR on the seniority the CURRENT / most-recent real role's TITLE conveys: a current 'Senior <role>'",
  "  → 'senior', 'Staff <role>' → 'staff', 'Principal' → 'principal', 'Manager'/'Director'/'VP'/'Founder'",
  "  → that stage, an early-career title → 'entry_level'/'junior'/'mid_level' as fits. Use the rest of the",
  "  timeline and durations ONLY to disambiguate between ADJACENT stages — NEVER to demote a clearly senior",
  "  current title down to mid_level/junior just because total tenure is short. Do NOT pin an experienced",
  "  person to 'intern' because an early role was an internship. Be CONSISTENT: the same timeline must",
  "  always yield the same careerStage. If genuinely unsure, omit careerStage.",
  "- yoeRange = [lo, hi] TOTAL FULL-TIME years of professional experience. EXCLUDE internships / co-op /",
  "  trainee / apprentice roles from the count. Sum the full-time durations (do NOT double-count",
  "  overlapping concurrent roles at the same employer) and give a sensible [lo, hi] range — lo is your",
  "  conservative estimate, hi your generous one; for someone with MORE THAN ONE completed full-time role",
  "  lo should be greater than 0. If everything is internships / school, use [0, 0] and careerStage",
  "  'entry_level' or 'intern' as fits. If durations are missing, estimate conservatively from the spans",
  "  present — never invent.",
  "",
  "Return ONLY the JSON object matching the schema. No prose.",
].join("\n")

/** The STRICT json_schema for the merge+determine response. */
const MERGE_JSON_SCHEMA = {
  name: "merged_experience_profile",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      mergedExperiences: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string" },
            company: { type: "string" },
            startDate: { type: ["string", "null"] },
            endDate: { type: ["string", "null"] },
            isCurrent: { type: "boolean" },
            description: { type: ["string", "null"] },
          },
          required: ["title", "company", "startDate", "endDate", "isCurrent", "description"],
        },
      },
      recentRoleTitle: { type: ["string", "null"] },
      recentCompany: { type: ["string", "null"] },
      careerStage: { type: ["string", "null"] },
      yoeRange: {
        type: ["array", "null"],
        items: { type: "number" },
        minItems: 2,
        maxItems: 2,
      },
    },
    required: ["mergedExperiences", "recentRoleTitle", "recentCompany", "careerStage", "yoeRange"],
  },
} as const

/** Drop empty rows (need at least a title or company to be a real role). */
function compactSources(rows: SourceExperience[] | null | undefined): SourceExperience[] {
  if (!Array.isArray(rows)) return []
  const out: SourceExperience[] = []
  for (const r of rows) {
    if (!r || typeof r !== "object") continue
    const title = typeof r.title === "string" ? r.title.trim() : ""
    const company = typeof r.company === "string" ? r.company.trim() : ""
    if (!title && !company) continue
    const row: SourceExperience = {}
    if (title) row.title = title
    if (company) row.company = company
    if (typeof r.startDate === "string" && r.startDate.trim()) row.startDate = r.startDate.trim()
    if (typeof r.endDate === "string" && r.endDate.trim()) row.endDate = r.endDate.trim()
    if (typeof r.isCurrent === "boolean") row.isCurrent = r.isCurrent
    if (typeof r.durationMonths === "number" && Number.isFinite(r.durationMonths)) {
      row.durationMonths = r.durationMonths
    }
    if (typeof r.description === "string" && r.description.trim()) {
      row.description = r.description.trim().slice(0, 2_000)
    }
    out.push(row)
  }
  return out
}

/** Validate + normalize a single merged entry the model returned. Drops entries with no title+company. */
function normalizeMergedEntry(raw: unknown): MergedExperience | null {
  if (!raw || typeof raw !== "object") return null
  const o = raw as Record<string, unknown>
  const title = typeof o.title === "string" ? o.title.trim() : ""
  const company = typeof o.company === "string" ? o.company.trim() : ""
  if (!title || !company) return null
  const entry: MergedExperience = {
    title,
    company,
    isCurrent: o.isCurrent === true,
  }
  if (typeof o.startDate === "string" && o.startDate.trim()) entry.startDate = o.startDate.trim()
  if (typeof o.endDate === "string" && o.endDate.trim()) entry.endDate = o.endDate.trim()
  if (typeof o.description === "string" && o.description.trim()) {
    entry.description = o.description.trim().slice(0, 2_000)
  }
  return entry
}

/** Validate careerStage ∈ CAREER_STAGE_VOCAB. Returns the value or undefined (DROP on invalid). */
function validateCareerStage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const v = value.trim()
  return (CAREER_STAGE_VOCAB as readonly string[]).includes(v) ? v : undefined
}

/** Validate a [lo, hi] numeric tuple. Returns undefined if not two finite non-negative numbers. */
function validateYoeRange(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined
  const lo = value[0]
  const hi = value[1]
  if (typeof lo !== "number" || typeof hi !== "number") return undefined
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < 0 || hi < 0) return undefined
  const a = Math.min(lo, hi)
  const b = Math.max(lo, hi)
  return [a, b]
}

/**
 * The raw LLM call seam — returns the model's JSON string (or "" on miss). Default implementation
 * makes the ONE gpt-5.4-mini json_schema-STRICT Responses-API call. Injectable so the unit test can
 * mock the LLM WITHOUT the live SDK (the existing test runner has no `--experimental-test-module-mocks`,
 * so deps-injection is the codebase-standard way to stub an LLM).
 */
export type MergeLlmCall = (args: { linkedin: SourceExperience[]; resume: SourceExperience[] }) => Promise<string>

const defaultMergeLlmCall: MergeLlmCall = async ({ linkedin, resume }) => {
  const { getOpenAIConfig } = await import("../lib/llm-providers.js")
  const cfg = getOpenAIConfig()
  if (!cfg.apiKey) return "" // no key → empty → fail-open in the caller.
  const baseURL = process.env.PA_OPENAI_AGENT_BASE_URL?.trim() || cfg.baseURL
  const { default: OpenAI } = (await import("openai")) as unknown as {
    default: new (init: { apiKey: string; baseURL?: string }) => {
      responses: {
        create: (req: Record<string, unknown>) => Promise<{
          output_text?: string
          output?: Array<{ content?: Array<{ text?: string }> }>
        }>
      }
    }
  }
  const client = new OpenAI({ apiKey: cfg.apiKey, baseURL })
  const resp = await client.responses.create({
    model: MERGE_MODEL,
    input: [
      { role: "system", content: MERGE_SYSTEM },
      {
        role: "user",
        content:
          "Merge these two experience lists into one canonical timeline and determine the facts.\n" +
          JSON.stringify({ linkedinExperiences: linkedin, resumeExperiences: resume }),
      },
    ],
    text: { format: { type: "json_schema", ...MERGE_JSON_SCHEMA } },
  })
  return typeof resp.output_text === "string" && resp.output_text.trim()
    ? resp.output_text.trim()
    : Array.isArray(resp.output) && resp.output[0]?.content?.[0]?.text
      ? resp.output[0]!.content![0]!.text!.trim()
      : ""
}

/**
 * The ONE merge+determine call. FAIL-OPEN: returns null on no-key / LLM error / empty / unparseable /
 * no-valid-merged-experiences so the caller leaves existing tags + highlights untouched.
 *
 * NO regex classifies text → enum: careerStage is the LLM's pick; we only validate set membership.
 *
 * `deps.llmCall` is injectable for tests; default makes the real gpt-5.4-mini json_schema-STRICT call.
 */
export async function mergeAndDetermineProfile(
  input: {
    linkedinExperiences: SourceExperience[] | null | undefined
    resumeExperiences: SourceExperience[] | null | undefined
  },
  deps: { llmCall?: MergeLlmCall } = {},
): Promise<MergeAndDetermineResult | null> {
  const linkedin = compactSources(input.linkedinExperiences)
  const resume = compactSources(input.resumeExperiences)
  // Nothing to merge → leave existing data (fail-open / no-op).
  if (linkedin.length === 0 && resume.length === 0) return null

  try {
    const llmCall = deps.llmCall ?? defaultMergeLlmCall
    const text = await llmCall({ linkedin, resume })
    if (!text) return null

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(text) as Record<string, unknown>
    } catch {
      return null
    }

    const mergedRaw = Array.isArray(parsed.mergedExperiences) ? parsed.mergedExperiences : []
    const mergedExperiences: MergedExperience[] = []
    for (const r of mergedRaw) {
      const entry = normalizeMergedEntry(r)
      if (entry) mergedExperiences.push(entry)
    }
    // A merge that yields zero usable roles is not trustworthy → fail-open, leave existing data.
    if (mergedExperiences.length === 0) return null

    const result: MergeAndDetermineResult = { mergedExperiences }
    const recentRoleTitle =
      typeof parsed.recentRoleTitle === "string" && parsed.recentRoleTitle.trim()
        ? parsed.recentRoleTitle.trim()
        : undefined
    const recentCompany =
      typeof parsed.recentCompany === "string" && parsed.recentCompany.trim()
        ? parsed.recentCompany.trim()
        : undefined
    if (recentRoleTitle) result.recentRoleTitle = recentRoleTitle
    if (recentCompany) result.recentCompany = recentCompany
    const careerStage = validateCareerStage(parsed.careerStage)
    if (careerStage) result.careerStage = careerStage
    const yoeRange = validateYoeRange(parsed.yoeRange)
    if (yoeRange) result.yoeRange = yoeRange
    return result
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Source-row adapters (so both wire sites feed the SAME function consistently)
// ---------------------------------------------------------------------------

/**
 * Map a LinkedIn/Coresignal experience row (ExternalCandidateRecord.experience[] OR the
 * pa-users.experienceHighlights shape) into a SourceExperience. Tolerant of both `currentRole`
 * (Coresignal) and `isCurrent` keys.
 */
export function toSourceFromLinkedin(row: Record<string, unknown> | null | undefined): SourceExperience {
  if (!row || typeof row !== "object") return {}
  const out: SourceExperience = {}
  if (typeof row.title === "string" && row.title.trim()) out.title = row.title.trim()
  if (typeof row.company === "string" && row.company.trim()) out.company = row.company.trim()
  if (typeof row.startDate === "string" && row.startDate.trim()) out.startDate = row.startDate.trim()
  if (typeof row.endDate === "string" && row.endDate.trim()) out.endDate = row.endDate.trim()
  if (typeof row.currentRole === "boolean") out.isCurrent = row.currentRole
  else if (typeof row.isCurrent === "boolean") out.isCurrent = row.isCurrent
  if (typeof row.durationMonths === "number" && Number.isFinite(row.durationMonths)) {
    out.durationMonths = row.durationMonths
  }
  if (typeof row.description === "string" && row.description.trim()) out.description = row.description.trim()
  return out
}

/**
 * Map a résumé workHistory row into a SourceExperience. Surfaces the achievement text from `bullets`
 * (the richest), then `achievements`/`highlights`, then a real `description` — exactly the layers
 * compose-pitch reads — so the merged entry's description carries the proof LinkedIn lacks.
 */
export function toSourceFromResume(row: Record<string, unknown> | null | undefined): SourceExperience {
  if (!row || typeof row !== "object") return {}
  const out: SourceExperience = {}
  if (typeof row.title === "string" && row.title.trim()) out.title = row.title.trim()
  if (typeof row.company === "string" && row.company.trim()) out.company = row.company.trim()
  if (typeof row.startDate === "string" && row.startDate.trim()) out.startDate = row.startDate.trim()
  if (typeof row.endDate === "string" && row.endDate.trim()) out.endDate = row.endDate.trim()
  if (typeof row.currentRole === "boolean") out.isCurrent = row.currentRole
  else if (typeof row.isCurrent === "boolean") out.isCurrent = row.isCurrent
  if (typeof row.durationMonths === "number" && Number.isFinite(row.durationMonths)) {
    out.durationMonths = row.durationMonths
  }
  const bulletParts: string[] = []
  for (const key of ["bullets", "achievements", "highlights"]) {
    const arr = row[key]
    if (Array.isArray(arr)) for (const b of arr) if (typeof b === "string" && b.trim()) bulletParts.push(b.trim())
  }
  if (bulletParts.length > 0) out.description = bulletParts.join(" • ").slice(0, 2_000)
  else if (typeof row.description === "string" && row.description.trim().length >= 40) {
    out.description = row.description.trim().slice(0, 2_000)
  }
  return out
}
