/**
 * employer-signals.ts — DERIVED EMPLOYER-HISTORY quality signals (Adam directive 2026-06-10).
 *
 * Candidate profiles must carry employer-history quality signals — worked at tier-1 big tech,
 * worked at fast-growing startups, founder/ownership scope — derived from their résumé/LinkedIn
 * history. Before this module those signals existed only as (a) `pa-companies/{id}` docs enriched
 * nightly (companyStage + companyTags incl. big_tech / mag_7 / yc_alumni / unicorn — see
 * enrich-companies-nightly.ts) that never flowed to users, and (b) prose bullets the pitch reads.
 *
 * Two independent, both-fail-open derivations over the candidate's MERGED experience timeline
 * (the MergeAndDetermineResult of merge-experience-profile.ts — the same seam at cv-ingest
 * runUserTagsMerge + coresignal-experiences-mirror):
 *
 *  1. COMPANY-METADATA JOIN — batch-load `pa-companies/{id}` docs for the distinct companies in
 *     the timeline (top 5 by recency; doc id via the EXISTING `normalizeCompanyName` from
 *     @pa/core-types — the same normalizer enrich-companies-nightly writes with). From the loaded
 *     docs derive employerStages / employerTags / hasBigTechBackground / employerGrowthTier.
 *     Missing docs are fine (most companies aren't enriched yet) — derive from what exists;
 *     EMPTY results write NOTHING (no clobber of absent fields).
 *
 *  2. OWNERSHIP / PRESTIGE EXTRACTION — ONE gpt-5.4-mini json_schema-STRICT call over the merged
 *     experiences' titles + bullets/descriptions (input capped ~3k chars) extracting founderRole,
 *     scopeOfOwnership {teamSize|revenue|users}, selectivitySignals (≤10, each ≤60 chars, only if
 *     EXPLICITLY present in the text — no inference). Mirrors the client/timeout/fail-open pattern
 *     of the merge-experience LLM call in the same directory (same key env, same 30s timeout,
 *     skip silently on any error). NO regex classifying text → enum (Adam absolute rule): the LLM
 *     picks, we only validate shape/caps. Injectable llmCall for tests.
 *
 * These signals are DERIVED-HISTORY fields on `pa-users.tags` (employerStages / employerTags /
 * hasBigTechBackground / employerGrowthTier / founderRole / scopeOfOwnership /
 * selectivitySignals) — DISTINCT from the preference axes companyStage/companySize, whose
 * semantics are untouched. Consumption is pitch + agent context ONLY; V16 matching consumption is
 * a separate Adam-gated decision (see compose-pitch.ts / candidate-context.ts).
 */
import type { Firestore } from "firebase-admin/firestore"
import { normalizeCompanyName } from "@pa/core-types"
import { COMPANY_STAGE_VOCAB } from "@wekruit/shared-tags"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One row of the candidate's employer timeline (MergedExperience-compatible; all optional). */
export type EmployerHistoryRow = {
  title?: string
  company?: string
  startDate?: string
  endDate?: string
  isCurrent?: boolean
  description?: string
}

export const EMPLOYER_GROWTH_TIERS = ["early_stage", "growth", "mature", "unknown"] as const
export type EmployerGrowthTier = (typeof EMPLOYER_GROWTH_TIERS)[number]

/** Signals derived from the pa-companies join. Empty object = nothing derivable (write nothing). */
export type EmployerCompanySignals = {
  employerStages?: string[]
  employerTags?: string[]
  hasBigTechBackground?: boolean
  employerGrowthTier?: EmployerGrowthTier
}

/** Signals extracted by the ownership/prestige LLM call. */
export type OwnershipSignals = {
  founderRole?: boolean
  scopeOfOwnership?: { teamSize?: number; revenue?: string; users?: number }
  selectivitySignals?: string[]
}

/** The combined additive tag patch this module produces. */
export type EmployerHistorySignals = EmployerCompanySignals & OwnershipSignals

// ---------------------------------------------------------------------------
// 1a. Growth tier — documented pure function
// ---------------------------------------------------------------------------

const EARLY_STAGES: ReadonlySet<string> = new Set(["pre_seed", "seed"])
const GROWTH_STAGES: ReadonlySet<string> = new Set(["series_a", "series_b", "series_c"])
const MATURE_STAGES: ReadonlySet<string> = new Set(["series_d_plus", "ipo_public", "private_mature"])

/**
 * Classify a candidate's employer-history STAGE MIX into one coarse growth tier.
 *
 * Pure + deterministic. Input = the `companyStage` values of the companies they worked at
 * (canonical `COMPANY_STAGE_VOCAB`; unrecognized tokens ignored). Rules, in order:
 *
 *  1. Any series_a / series_b / series_c employer        → "growth"
 *     (they've been inside a venture-growth environment — the strongest startup signal).
 *  2. Both an early employer (pre_seed/seed) AND a mature one → "growth"
 *     (their history spans both ends — the mix reads as growth-track, not purely early or mature).
 *  3. Only early employers (pre_seed/seed)               → "early_stage"
 *  4. Only mature employers (series_d_plus/ipo_public/private_mature) → "mature"
 *  5. No recognized stage signal (incl. only `unknown` / `bootstrapped` / `non_profit`,
 *     which carry no growth-tier information)            → "unknown"
 */
export function deriveEmployerGrowthTier(stages: ReadonlyArray<string>): EmployerGrowthTier {
  let hasEarly = false
  let hasGrowth = false
  let hasMature = false
  for (const s of stages) {
    if (typeof s !== "string") continue
    if (EARLY_STAGES.has(s)) hasEarly = true
    else if (GROWTH_STAGES.has(s)) hasGrowth = true
    else if (MATURE_STAGES.has(s)) hasMature = true
  }
  if (hasGrowth) return "growth"
  if (hasEarly && hasMature) return "growth"
  if (hasEarly) return "early_stage"
  if (hasMature) return "mature"
  return "unknown"
}

// ---------------------------------------------------------------------------
// 1b. Company-metadata join
// ---------------------------------------------------------------------------

const MAX_COMPANIES = 5
const MAX_EMPLOYER_TAGS = 30
const BIG_TECH_TAGS: ReadonlySet<string> = new Set(["big_tech", "mag_7"])
const COMPANY_STAGE_SET: ReadonlySet<string> = new Set(COMPANY_STAGE_VOCAB as readonly string[])

/** Comparable recency ms for a timeline row: isCurrent → +∞-ish, else parsed startDate, else -∞. */
function rowRecencyMs(row: EmployerHistoryRow): number {
  if (row.isCurrent === true) return Number.MAX_SAFE_INTEGER
  if (typeof row.startDate === "string" && row.startDate.trim()) {
    const t = Date.parse(row.startDate)
    if (!Number.isNaN(t)) return t
  }
  return -Infinity
}

/**
 * Distinct normalized pa-companies doc ids for the timeline, top `max` by recency (current role
 * first, then latest startDate; undated rows keep input order at the back). REUSES
 * `normalizeCompanyName` (@pa/core-types) — the exact normalizer enrich-companies-nightly uses
 * for `pa-companies/{id}` doc ids. Pure.
 */
export function topCompanyIdsByRecency(
  rows: ReadonlyArray<EmployerHistoryRow>,
  max: number = MAX_COMPANIES,
): string[] {
  const indexed = rows
    .map((row, i) => ({ row, i, ms: rowRecencyMs(row) }))
    .filter((x) => typeof x.row.company === "string" && x.row.company.trim().length > 0)
  // Stable: recency desc, then original order.
  indexed.sort((a, b) => (b.ms === a.ms ? a.i - b.i : b.ms - a.ms))
  const seen = new Set<string>()
  const out: string[] = []
  for (const { row } of indexed) {
    const id = normalizeCompanyName(row.company!)
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= max) break
  }
  return out
}

/**
 * Pure derivation from loaded pa-companies docs (null/undefined entries = company not enriched
 * yet — skipped). Returns {} when nothing derivable so the caller writes NOTHING.
 */
export function deriveEmployerCompanySignals(
  companyDocs: ReadonlyArray<Record<string, unknown> | null | undefined>,
): EmployerCompanySignals {
  const stages: string[] = []
  const tags: string[] = []
  const seenStages = new Set<string>()
  const seenTags = new Set<string>()
  for (const doc of companyDocs) {
    if (!doc || typeof doc !== "object") continue
    const stage = doc.companyStage
    // `unknown` is the un-enriched default — it carries no history signal, so it is not
    // recorded in employerStages (and contributes nothing to the growth tier).
    if (typeof stage === "string" && COMPANY_STAGE_SET.has(stage) && stage !== "unknown" && !seenStages.has(stage)) {
      seenStages.add(stage)
      stages.push(stage)
    }
    if (Array.isArray(doc.companyTags)) {
      for (const t of doc.companyTags) {
        if (typeof t !== "string") continue
        const norm = t.trim().toLowerCase()
        if (!norm || seenTags.has(norm)) continue
        seenTags.add(norm)
        if (tags.length < MAX_EMPLOYER_TAGS) tags.push(norm)
      }
    }
  }
  const out: EmployerCompanySignals = {}
  if (stages.length > 0) out.employerStages = stages
  if (tags.length > 0) out.employerTags = tags
  if (tags.some((t) => BIG_TECH_TAGS.has(t))) out.hasBigTechBackground = true
  const tier = deriveEmployerGrowthTier(stages)
  // "unknown" with zero loaded signal is NOT written — an absent field must stay absent
  // (additive contract). Only emit the tier when at least one stage informed it.
  if (stages.length > 0) out.employerGrowthTier = tier
  return out
}

/** Batched pa-companies loader (Firestore getAll). Injectable seam for tests/backfill. */
export type CompanyDocsLoader = (ids: string[]) => Promise<Array<Record<string, unknown> | null>>

export function makeFirestoreCompanyLoader(db: Firestore): CompanyDocsLoader {
  return async (ids: string[]) => {
    if (ids.length === 0) return []
    const refs = ids.map((id) => db.collection("pa-companies").doc(id))
    const snaps = await db.getAll(...refs)
    return snaps.map((s) => (s.exists ? ((s.data() ?? null) as Record<string, unknown> | null) : null))
  }
}

/**
 * The join: timeline → top-5 distinct company ids → batch-load pa-companies → pure derivation.
 * FAIL-OPEN: any error logs + returns {} — the caller's merge result is unaffected.
 */
export async function loadEmployerCompanySignals(
  rows: ReadonlyArray<EmployerHistoryRow>,
  deps: {
    getCompanyDocs: CompanyDocsLoader
    log?: (event: string, payload?: Record<string, unknown>) => void
  },
): Promise<EmployerCompanySignals> {
  try {
    const ids = topCompanyIdsByRecency(rows)
    if (ids.length === 0) return {}
    const docs = await deps.getCompanyDocs(ids)
    return deriveEmployerCompanySignals(docs)
  } catch (err) {
    deps.log?.("pa.employer_signals.company_join_error", {
      error: err instanceof Error ? err.message : String(err),
    })
    return {}
  }
}

// ---------------------------------------------------------------------------
// 2. Ownership / prestige extraction (ONE gpt-5.4-mini json_schema STRICT call)
// ---------------------------------------------------------------------------

const OWNERSHIP_MODEL = "gpt-5.4-mini" // parity with merge-experience-profile.ts + compose-pitch.ts.
const OWNERSHIP_INPUT_CAP = 3_000
const MAX_SELECTIVITY_SIGNALS = 10
const MAX_SELECTIVITY_LEN = 60

const OWNERSHIP_SYSTEM = [
  "You read a candidate's merged work-history text (role titles + achievement bullets) and extract",
  "ownership / prestige facts. Extract ONLY what is EXPLICITLY present in the text — NEVER infer,",
  "estimate, or embellish. Missing = null/empty.",
  "",
  "- founderRole: true ONLY if the text shows they founded / co-founded / owned their own venture",
  "  (a 'Founder', 'Co-Founder', 'Owner' role, or text saying they started the company). Working AT",
  "  a startup is NOT founderRole.",
  "- scopeOfOwnership.teamSize: the number of people they personally led/managed, ONLY if a number",
  "  is stated ('led a team of 5', 'managed 12 engineers'). Else null.",
  "- scopeOfOwnership.revenue: a SHORT verbatim revenue/budget figure they owned ('$2M ARR',",
  "  '$500K budget'), max 60 chars. Else null.",
  "- scopeOfOwnership.users: the number of users/customers their work served, ONLY if a count is",
  "  stated ('5,000 weekly users' → 5000). Else null.",
  "- selectivitySignals: honors, awards, rankings, or selective programs EXPLICITLY named ('Top",
  "  0.1% of 390K', 'YC W23', 'Forbes 30 Under 30', a named fellowship). Each entry ≤ 60 chars,",
  "  at most 10. Empty array when none.",
  "",
  "Return ONLY the JSON object matching the schema. No prose.",
].join("\n")

/** STRICT json_schema for the ownership response. Exported so tests can assert STRICT shape. */
export const OWNERSHIP_JSON_SCHEMA = {
  name: "employer_ownership_signals",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      founderRole: { type: "boolean" },
      scopeOfOwnership: {
        type: "object",
        additionalProperties: false,
        properties: {
          teamSize: { type: ["integer", "null"] },
          revenue: { type: ["string", "null"] },
          users: { type: ["integer", "null"] },
        },
        required: ["teamSize", "revenue", "users"],
      },
      selectivitySignals: { type: "array", items: { type: "string" } },
    },
    required: ["founderRole", "scopeOfOwnership", "selectivitySignals"],
  },
} as const

/** Injectable LLM seam (codebase-standard deps-injection; mirrors MergeLlmCall). */
export type OwnershipLlmCall = (args: { text: string }) => Promise<string>

const defaultOwnershipLlmCall: OwnershipLlmCall = async ({ text }) => {
  const { getOpenAIConfig } = await import("../lib/llm-providers.js")
  const cfg = getOpenAIConfig()
  if (!cfg.apiKey) return "" // no key → empty → fail-open in the caller.
  const baseURL = process.env.PA_OPENAI_AGENT_BASE_URL?.trim() || cfg.baseURL
  const { default: OpenAI } = (await import("openai")) as unknown as {
    default: new (init: { apiKey: string; baseURL?: string; timeout?: number }) => {
      responses: {
        create: (req: Record<string, unknown>) => Promise<{
          output_text?: string
          output?: Array<{ content?: Array<{ text?: string }> }>
        }>
      }
    }
  }
  // Same 30s per-request timeout convention as the merge+determine call (latency root-cause fix,
  // Adam 2026-06-06): a hung request must degrade gracefully, never stall the ingest path.
  const client = new OpenAI({ apiKey: cfg.apiKey, baseURL, timeout: 30_000 })
  const resp = await client.responses.create({
    model: OWNERSHIP_MODEL,
    input: [
      { role: "system", content: OWNERSHIP_SYSTEM },
      { role: "user", content: "Extract the ownership/prestige facts from this work history:\n" + text },
    ],
    text: { format: { type: "json_schema", ...OWNERSHIP_JSON_SCHEMA } },
  })
  return typeof resp.output_text === "string" && resp.output_text.trim()
    ? resp.output_text.trim()
    : Array.isArray(resp.output) && resp.output[0]?.content?.[0]?.text
      ? resp.output[0]!.content![0]!.text!.trim()
      : ""
}

/** Serialize the timeline rows into the capped extraction input. Pure. */
export function buildOwnershipInput(rows: ReadonlyArray<EmployerHistoryRow>): string {
  const lines: string[] = []
  for (const r of rows) {
    const head = [r.title, r.company].filter((s) => typeof s === "string" && s.trim()).join(" @ ")
    const desc = typeof r.description === "string" ? r.description.trim() : ""
    if (!head && !desc) continue
    lines.push(desc ? `${head || "(role)"}: ${desc}` : head)
  }
  return lines.join("\n").slice(0, OWNERSHIP_INPUT_CAP)
}

/**
 * The ONE ownership/prestige extraction. FAIL-OPEN: returns null on no-input / no-key / LLM error /
 * unparseable so the caller writes nothing. Validation is shape/cap only — the LLM picks the facts
 * (no regex classifying text → enum). `founderRole` is only emitted when TRUE: a 3k-char window is
 * not evidence of absence, and the additive contract means we never write a negative claim.
 */
export async function extractOwnershipSignals(
  rows: ReadonlyArray<EmployerHistoryRow>,
  deps: {
    llmCall?: OwnershipLlmCall
    log?: (event: string, payload?: Record<string, unknown>) => void
  } = {},
): Promise<OwnershipSignals | null> {
  const text = buildOwnershipInput(rows)
  if (!text) return null
  try {
    const llmCall = deps.llmCall ?? defaultOwnershipLlmCall
    const raw = await llmCall({ text })
    if (!raw) return null
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return null
    }
    const out: OwnershipSignals = {}
    if (parsed.founderRole === true) out.founderRole = true
    const scopeRaw =
      parsed.scopeOfOwnership && typeof parsed.scopeOfOwnership === "object" && !Array.isArray(parsed.scopeOfOwnership)
        ? (parsed.scopeOfOwnership as Record<string, unknown>)
        : null
    if (scopeRaw) {
      const scope: NonNullable<OwnershipSignals["scopeOfOwnership"]> = {}
      if (typeof scopeRaw.teamSize === "number" && Number.isInteger(scopeRaw.teamSize) && scopeRaw.teamSize > 0) {
        scope.teamSize = scopeRaw.teamSize
      }
      if (typeof scopeRaw.revenue === "string" && scopeRaw.revenue.trim()) {
        scope.revenue = scopeRaw.revenue.trim().slice(0, MAX_SELECTIVITY_LEN)
      }
      if (typeof scopeRaw.users === "number" && Number.isInteger(scopeRaw.users) && scopeRaw.users >= 0) {
        scope.users = scopeRaw.users
      }
      if (Object.keys(scope).length > 0) out.scopeOfOwnership = scope
    }
    if (Array.isArray(parsed.selectivitySignals)) {
      const seen = new Set<string>()
      const signals: string[] = []
      for (const s of parsed.selectivitySignals) {
        if (typeof s !== "string") continue
        const norm = s.trim().slice(0, MAX_SELECTIVITY_LEN)
        if (!norm || seen.has(norm)) continue
        seen.add(norm)
        signals.push(norm)
        if (signals.length >= MAX_SELECTIVITY_SIGNALS) break
      }
      if (signals.length > 0) out.selectivitySignals = signals
    }
    return Object.keys(out).length > 0 ? out : null
  } catch (err) {
    deps.log?.("pa.employer_signals.ownership_error", {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

// ---------------------------------------------------------------------------
// Combined orchestration (the seam entry point)
// ---------------------------------------------------------------------------

/**
 * Derive the full additive employer-history tag patch for a merged timeline. Both halves run
 * concurrently and are individually FAIL-OPEN — any error degrades to "that half contributes
 * nothing". Returns {} when nothing derivable → the seam writes NOTHING (absent fields untouched).
 */
export async function deriveEmployerHistorySignals(
  rows: ReadonlyArray<EmployerHistoryRow>,
  deps: {
    getCompanyDocs?: CompanyDocsLoader
    llmCall?: OwnershipLlmCall
    log?: (event: string, payload?: Record<string, unknown>) => void
  } = {},
): Promise<EmployerHistorySignals> {
  if (!Array.isArray(rows) || rows.length === 0) return {}
  try {
    const [companySignals, ownership] = await Promise.all([
      deps.getCompanyDocs
        ? loadEmployerCompanySignals(rows, { getCompanyDocs: deps.getCompanyDocs, ...(deps.log ? { log: deps.log } : {}) })
        : Promise.resolve({} as EmployerCompanySignals),
      extractOwnershipSignals(rows, { ...(deps.llmCall ? { llmCall: deps.llmCall } : {}), ...(deps.log ? { log: deps.log } : {}) }),
    ])
    return { ...companySignals, ...(ownership ?? {}) }
  } catch (err) {
    deps.log?.("pa.employer_signals.derive_error", {
      error: err instanceof Error ? err.message : String(err),
    })
    return {}
  }
}
