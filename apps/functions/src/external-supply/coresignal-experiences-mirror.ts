/**
 * P2.5 — Mirror CoreSignal v2 collect experience[] into the canonical
 * `parsedCandidateResumes/{auto-id}` collection so all downstream surfaces
 * (Claire cv-analysis, paReverseMatch, job-rec-daily, dashboard CandidateProfile)
 * can see CoreSignal-sourced candidates.
 *
 * Without this mirror, CoreSignal data lives only in
 * `pa-external-candidate-records.experience[]` which the rubric evaluator
 * reads — but the rest of the system queries `parsedCandidateResumes`. P2
 * already filled `pa-users.tags.skills`, but tag-level fields aren't enough
 * for surfaces that walk per-experience work history.
 *
 * Also records `coresignalEmployeeId` on the `pa-users` doc as a stable
 * external identity handle so subsequent fetches of the same CoreSignal id
 * for an already-linked candidate are de-duplicated cheaply (vs full
 * linkedin-url canonicalization roundtrip).
 *
 * Idempotency: skip mirror if a parsedCandidateResumes doc with
 * `source: "coresignal_collect_v2"` AND same `coresignalEmployeeId` already
 * exists for this userId. CoreSignal data is stable per id — duplicate
 * mirrors waste storage and confuse the cv-context-injection ordering.
 */
import type { Firestore } from "firebase-admin/firestore"
import type { ExternalCandidateRecord } from "@pa/core-types"
import {
  mergeAndDetermineProfile,
  toSourceFromLinkedin,
  toSourceFromResume,
  type MergeAndDetermineResult,
  type SourceExperience,
} from "./merge-experience-profile.js"
// Employer-history quality signals (Adam 2026-06-10): pa-companies join + ownership extraction
// over the merged timeline. ADDITIVE + fail-open (see employer-signals.ts).
import {
  deriveEmployerHistorySignals,
  makeFirestoreCompanyLoader,
  type EmployerHistoryRow,
  type EmployerHistorySignals,
} from "./employer-signals.js"

const PARSED_RESUMES_COLLECTION = "parsedCandidateResumes"
const PA_USERS_COLLECTION = "pa-users"

export interface CoresignalExperiencesMirrorResult {
  status:
    | "mirrored"
    | "skipped_not_coresignal"
    | "skipped_no_experience"
    | "skipped_already_mirrored"
    | "skipped_no_coresignal_id"
    | "refreshed_existing"
}

/**
 * Read CoreSignal employee id from the external candidate record's rawPayload.
 * The CoreSignal cdapi v2 collect response has `id: <number>` at root.
 */
function extractCoresignalEmployeeId(record: ExternalCandidateRecord): number | null {
  const raw = record.rawPayload as Record<string, unknown> | undefined
  if (!raw) return null
  const id = raw.id
  if (typeof id === "number" && Number.isInteger(id) && id > 0) return id
  // Defensive: coresignal sometimes stringifies
  if (typeof id === "string") {
    const parsed = Number.parseInt(id, 10)
    if (Number.isInteger(parsed) && parsed > 0) return parsed
  }
  return null
}

function isLinkedinOAuthMarker(value: unknown): boolean {
  return typeof value === "string" && value.includes("/oauth-linked/")
}

function stripUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))
}

function normalizeOptionalUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`
  try {
    const parsed = new URL(withProtocol)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined
    return parsed.toString()
  } catch {
    return undefined
  }
}

type ExistingParsedResumeForMirror = {
  id?: string
  coresignalEmployeeId?: number
  source?: string
  experiences?: Array<Record<string, unknown>>
}

type ResumeExperienceDescription = {
  company: string
  title: string
  startDate?: string
  endDate?: string
  description: string
}

function cleanText(value: unknown, max = 4_000): string | undefined {
  if (typeof value !== "string") return undefined
  const normalized = value.replace(/\s+/g, " ").trim()
  return normalized ? normalized.slice(0, max) : undefined
}

function normalizeForMatch(value: unknown): string {
  return cleanText(value, 500)
    ?.toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(?:inc|incorporated|llc|ltd|corp|corporation|company|co)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim() ?? ""
}

function tokenSet(value: string): Set<string> {
  return new Set(value.split(/\s+/).filter((token) => token.length >= 3))
}

function compactForMatch(value: string): string {
  return value.replace(/\s+/g, "")
}

function overlapCount(a: Set<string>, b: Set<string>): number {
  let count = 0
  for (const token of a) {
    if (b.has(token)) count += 1
  }
  return count
}

function parseMonthYear(value: unknown): { year?: number; month?: number } {
  const text = cleanText(value, 64)?.toLowerCase()
  if (!text) return {}
  const yearMatch = text.match(/\b(19|20)\d{2}\b/)
  const year = yearMatch ? Number.parseInt(yearMatch[0], 10) : undefined
  const months = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ]
  const monthIndex = months.findIndex((month) => text.includes(month) || text.includes(month.slice(0, 3)))
  return { year, month: monthIndex >= 0 ? monthIndex + 1 : undefined }
}

function dateScore(
  target: Pick<ResumeExperienceDescription, "startDate" | "endDate">,
  candidate: Pick<ResumeExperienceDescription, "startDate" | "endDate">,
): number {
  const targetStart = parseMonthYear(target.startDate)
  const candidateStart = parseMonthYear(candidate.startDate)
  if (targetStart.year && candidateStart.year) {
    if (targetStart.year === candidateStart.year && targetStart.month && candidateStart.month) {
      return targetStart.month === candidateStart.month ? 2 : 1
    }
    if (targetStart.year === candidateStart.year) return 1
  }
  const targetEnd = parseMonthYear(target.endDate)
  const candidateEnd = parseMonthYear(candidate.endDate)
  const targetYears = [targetStart.year, targetEnd.year].filter((year): year is number => Boolean(year))
  const candidateYears = [candidateStart.year, candidateEnd.year].filter((year): year is number => Boolean(year))
  if (targetYears.length > 0 && candidateYears.some((year) => targetYears.includes(year))) return 1
  return 0
}

function titlePenalty(targetTitle: string, candidateTitle: string, dates: number): number {
  const targetTokens = tokenSet(targetTitle)
  const candidateTokens = tokenSet(candidateTitle)
  const targetSenior = ["senior", "staff", "principal", "manager", "director", "lead"].some((token) => targetTokens.has(token))
  const candidateSenior = ["senior", "staff", "principal", "manager", "director", "lead"].some((token) => candidateTokens.has(token))
  const targetIntern = targetTokens.has("intern") || targetTokens.has("internship")
  const candidateIntern = candidateTokens.has("intern") || candidateTokens.has("internship")
  if (dates > 0) return 0
  if (targetSenior !== candidateSenior) return 3
  if (targetIntern !== candidateIntern) return 2
  return 0
}

function collectResumeDescriptions(existing: ExistingParsedResumeForMirror[]): ResumeExperienceDescription[] {
  const out: ResumeExperienceDescription[] = []
  for (const row of existing) {
    if (row.source === "coresignal_collect_v2") continue
    for (const experience of row.experiences ?? []) {
      const company = cleanText(experience.company ?? experience.companyName, 200)
      const title = cleanText(experience.title ?? experience.position, 200)
      const description = cleanText(experience.description, 4_000)
      if (!company || !title || !description) continue
      out.push({
        company,
        title,
        startDate: cleanText(experience.startDate ?? experience.start, 64),
        endDate: cleanText(experience.endDate ?? experience.end, 64),
        description,
      })
    }
  }
  return out
}

/**
 * Collect EVERY résumé role (title/company even when there's no description) from the user's existing
 * non-coresignal parsedCandidateResumes rows, mapped to SourceExperience. Unlike collectResumeDescriptions
 * (which requires a description for the per-role text-merge), this keeps every real role so the LLM merge
 * sees the candidate's full résumé timeline. Bullets/achievements surface as the merged description.
 */
function collectResumeSourceExperiences(existing: ExistingParsedResumeForMirror[]): SourceExperience[] {
  const out: SourceExperience[] = []
  for (const row of existing) {
    if (row.source === "coresignal_collect_v2") continue
    for (const experience of row.experiences ?? []) {
      const src = toSourceFromResume(experience)
      if (src.title || src.company) out.push(src)
    }
  }
  return out
}

/** Map a MergedExperience timeline entry to the canonical experienceHighlights shape. */
function mergedToHighlights(merged: MergeAndDetermineResult): Array<Record<string, unknown>> {
  return merged.mergedExperiences.slice(0, 10).map((e) =>
    stripUndefined({
      title: e.title,
      company: e.company,
      description: e.description ?? undefined,
      startDate: e.startDate ?? undefined,
      endDate: e.endDate ?? undefined,
      currentRole: e.isCurrent === true ? true : undefined,
      source: "merged_linkedin_resume",
      sourceLabel: "LinkedIn+Résumé",
    }),
  )
}

function bestResumeDescription(
  target: NonNullable<ExternalCandidateRecord["experience"]>[number],
  candidates: ResumeExperienceDescription[],
): string | undefined {
  const targetCompany = normalizeForMatch(target.company)
  const targetTitle = normalizeForMatch(target.title)
  if (!targetCompany || !targetTitle) return undefined
  const targetCompanyTokens = tokenSet(targetCompany)
  const targetTitleTokens = tokenSet(targetTitle)
  let best: { score: number; description: string } | undefined
  for (const candidate of candidates) {
    const candidateCompany = normalizeForMatch(candidate.company)
    const candidateTitle = normalizeForMatch(candidate.title)
    if (!candidateCompany || !candidateTitle) continue
    const companyEquivalent =
      targetCompany === candidateCompany ||
      compactForMatch(targetCompany) === compactForMatch(candidateCompany) ||
      targetCompany.includes(candidateCompany) ||
      candidateCompany.includes(targetCompany)
    const companyOverlap = overlapCount(targetCompanyTokens, tokenSet(candidateCompany))
    if (companyOverlap === 0 && !companyEquivalent) {
      continue
    }
    const titleTokens = tokenSet(candidateTitle)
    const titleOverlap = overlapCount(targetTitleTokens, titleTokens)
    const dates = dateScore(target, candidate)
    const companyScore = companyEquivalent ? 4 : Math.min(3, companyOverlap)
    const titleScore =
      targetTitle === candidateTitle || targetTitle.includes(candidateTitle) || candidateTitle.includes(targetTitle)
        ? 3
        : titleOverlap >= 2
          ? 2
          : titleOverlap
    const score = companyScore + titleScore + dates - titlePenalty(targetTitle, candidateTitle, dates)
    if (score < 6) continue
    if (!best || score > best.score) {
      best = { score, description: candidate.description }
    }
  }
  return best?.description
}

function mergeResumeDescriptionsIntoRecord(
  record: ExternalCandidateRecord,
  existing: ExistingParsedResumeForMirror[],
): ExternalCandidateRecord {
  const candidates = collectResumeDescriptions(existing)
  if (candidates.length === 0 || !record.experience?.length) return record
  return {
    ...record,
    experience: record.experience.map((experience) => {
      if (cleanText(experience.description)) return experience
      const description = bestResumeDescription(experience, candidates)
      return description ? { ...experience, description } : experience
    }),
  }
}

export function buildExperienceHighlightsFromRecord(record: ExternalCandidateRecord): Array<Record<string, unknown>> {
  return (record.experience ?? [])
    .filter((experience) => experience.company && experience.title)
    .slice(0, 8)
    .map((experience, index) => {
      const inferredCurrent =
        experience.currentRole === true
          ? true
          : experience.currentRole === false
            ? undefined
            : index === 0 && !experience.endDate
              ? true
              : undefined
      return stripUndefined({
        title: experience.title,
        company: experience.company,
        location: experience.location ?? undefined,
        description: experience.description ?? undefined,
        startDate: experience.startDate ?? undefined,
        endDate: experience.endDate ?? undefined,
        durationMonths: experience.durationMonths ?? undefined,
        currentRole: inferredCurrent,
        department: experience.department ?? undefined,
        managementLevel: experience.managementLevel ?? undefined,
        companyId: experience.companyId ?? undefined,
        companyIndustry: experience.companyIndustry ?? undefined,
        companySizeRange: experience.companySizeRange ?? undefined,
        companyWebsite: normalizeOptionalUrl(experience.companyWebsite),
        companyLinkedinUrl: normalizeOptionalUrl(experience.companyLinkedinUrl),
        companyHqCity: experience.companyHqCity ?? undefined,
        companyHqCountry: experience.companyHqCountry ?? undefined,
        companyLogoUrl: normalizeOptionalUrl(experience.companyLogoUrl),
        source: "coresignal_collect_v2",
        sourceLabel: "LinkedIn",
      })
    })
}

/**
 * Translate ExternalCandidateRecord into a parsedCandidateResumes baseDoc
 * shape. Mirrors the canonical write site in
 * `apps/functions/src/cv-ingest/cv-ingest.ts` minus PDF-specific fields
 * (mediaUrl, fileType, sha256) which don't apply to LinkedIn-sourced data.
 */
export function buildParsedResumeDocFromRecord(
  record: ExternalCandidateRecord,
  userId: string,
  nowIso: string,
  coresignalEmployeeId: number,
): Record<string, unknown> {
  const experiences = (record.experience ?? []).map((e) => ({
    title: e.title,
    company: e.company,
    location: e.location ?? null,
    description: e.description ?? null,
    startDate: e.startDate ?? null,
    endDate: e.endDate ?? null,
    durationMonths: e.durationMonths ?? null,
    currentRole: e.currentRole ?? null,
    department: e.department ?? null,
    managementLevel: e.managementLevel ?? null,
    companyId: e.companyId ?? null,
    companyIndustry: e.companyIndustry ?? null,
    companySizeRange: e.companySizeRange ?? null,
    companyWebsite: normalizeOptionalUrl(e.companyWebsite) ?? null,
    companyLinkedinUrl: normalizeOptionalUrl(e.companyLinkedinUrl) ?? null,
    companyHqCity: e.companyHqCity ?? null,
    companyHqCountry: e.companyHqCountry ?? null,
    companyLogoUrl: normalizeOptionalUrl(e.companyLogoUrl) ?? null,
  }))
  const education = (record.education ?? []).map((e) => ({
    school: e.school,
    degree: e.degree ?? null,
    field: e.field ?? null,
    endYear: e.endYear ?? null,
  }))
  // sourceTags = inferred + historical skills (dedup'd in adapter).
  const skills = record.sourceTags ?? []
  const topSkills = skills.slice(0, 12)
  return {
    userId,
    candidateProfile: {
      name: record.name ?? null,
      skills,
    },
    experiences,
    education,
    industryTags: [], // Adam directive: derive later via job-tag enricher
    topSkills,
    originalFileName: null,
    fileType: null,
    studentFrom: null,
    sessionId: null,
    mediaUrl: null,
    ingestedAt: nowIso,
    ingestedVia: "coresignal_collect_v2",
    createdAt: new Date(nowIso),
    parserVersion: "coresignal_collect_v2",
    // P2.5 — explicit external identity for dedup.
    source: "coresignal_collect_v2",
    coresignalEmployeeId,
    // External-source link back to the record + batch for audit.
    sourceRecordId: record.recordId,
    sourceBatchId: record.batchId,
  }
}

/**
 * D8 merge facts written under pa-users.tags by writeBoth. Extends the determined facts with the
 * ADDITIVE employer-history signals (Adam 2026-06-10) — all optional; absent keys never clobber.
 */
export type MirrorMergedFacts = {
  recentRoleTitle?: string
  recentCompany?: string
  careerStage?: string
  yoeRange?: [number, number]
  roleFunction?: string[]
} & EmployerHistorySignals

export interface MirrorDeps {
  /** Query existing parsedCandidateResumes rows for this user. */
  findExistingForUser?: (userId: string) => Promise<ExistingParsedResumeForMirror[]>
  /** Write the parsedCandidateResumes doc + the pa-users.coresignalEmployeeId field. */
  writeBoth?: (args: {
    parsedResumeDoc: Record<string, unknown>
    userId: string
    coresignalEmployeeId: number
    canonicalLinkedInUrl?: string
    experienceHighlights: Array<Record<string, unknown>>
    existingParsedResumeDocId?: string
    /**
     * D8 merge facts (recentRoleTitle / recentCompany / careerStage / yoeRange) from the unified
     * LinkedIn+résumé determination. When present, writeBoth MUST read+merge existing pa-users.tags and
     * write ONLY these keys (never clobber sibling tags). Absent on fail-open (leave existing tags).
     */
    mergedFacts?: MirrorMergedFacts
  }) => Promise<void>
  /**
   * Injectable unified merge+determine over (LinkedIn experiences, résumé experiences). Default = the
   * real gpt-5.4-mini json_schema-STRICT call. Tests stub it. Fail-open: returns null → leave existing.
   */
  mergeAndDetermine?: (input: {
    linkedinExperiences: SourceExperience[]
    resumeExperiences: SourceExperience[]
  }) => Promise<MergeAndDetermineResult | null>
  /**
   * Injectable employer-history signals derivation (Adam 2026-06-10) over the merged timeline.
   * Wired by makeFirestoreMirrorDeps (needs db for the pa-companies join); absent → skipped
   * entirely (fail-open, nothing written). ADDITIVE: empty result writes nothing.
   */
  deriveEmployerSignals?: (rows: EmployerHistoryRow[]) => Promise<EmployerHistorySignals>
  /**
   * THE ONE SEAM for "we now have this person's LinkedIn and their enrichment landed"
   * (Adam 2026-07-25: "只要拿到LinkedIn之后就要走这个", "扫码/网站注册的都要走这个").
   *
   * Every entry path converges HERE: website registration (`enrich-from-typed-linkedin.ts`), the
   * one-tap LinkedIn connect the QR scanner is offered (`linkedin-connect-submit.ts`), and external
   * supply (`resolve-identity.ts`) all build an `ExternalCandidateRecord` and call this runner. A
   * per-entry hook would silently miss whichever path is added next, and the copies would drift.
   *
   * Runs AFTER `writeBoth`, so the global profile is stored first and this is strictly additive.
   * Never throws into the mirror — the enrichment is the payload, this is bookkeeping on top.
   * Wired by `makeFirestoreMirrorDeps` (needs db); absent in tests → no-op.
   */
  afterMirror?: (record: ExternalCandidateRecord, userId: string) => Promise<void>
  now?: () => string
  log?: (event: string, fields?: Record<string, unknown>) => void
}

/**
 * Pure runner — deps-injected for tests. Default Firestore wrapper below.
 */
export async function runCoresignalExperiencesMirror(
  record: ExternalCandidateRecord,
  userId: string,
  deps: MirrorDeps,
): Promise<CoresignalExperiencesMirrorResult> {
  const now = (deps.now ?? (() => new Date().toISOString()))()

  if (record.source !== "coresignal_collect_v2") {
    return { status: "skipped_not_coresignal" }
  }
  if (!record.experience || record.experience.length === 0) {
    return { status: "skipped_no_experience" }
  }
  const coresignalEmployeeId = extractCoresignalEmployeeId(record)
  if (coresignalEmployeeId === null) {
    deps.log?.("coresignal_mirror.no_id_in_raw_payload", {
      recordId: record.recordId,
    })
    return { status: "skipped_no_coresignal_id" }
  }

  let existingParsedResumeDocId: string | undefined
  let existing: ExistingParsedResumeForMirror[] = []
  if (deps.findExistingForUser) {
    existing = await deps.findExistingForUser(userId)
    const dupe = existing.find(
      (r) =>
        r.source === "coresignal_collect_v2" &&
        r.coresignalEmployeeId === coresignalEmployeeId,
    )
    if (dupe) {
      if (!dupe.id) {
        return { status: "skipped_already_mirrored" }
      }
      existingParsedResumeDocId = dupe.id
    }
  }

  const recordWithDescriptions = mergeResumeDescriptionsIntoRecord(record, existing)
  const doc = buildParsedResumeDocFromRecord(recordWithDescriptions, userId, now, coresignalEmployeeId)
  const linkedinOnlyHighlights = buildExperienceHighlightsFromRecord(recordWithDescriptions)

  // UNIFIED MERGE + DETERMINE (Adam 2026-06-05): "merge the experience between linkedin & resume, and
  // ask llm to determine." Read the user's résumé timeline + this Coresignal/LinkedIn record's
  // experiences, let ONE gpt-5.4-mini json_schema-STRICT call merge them into a canonical timeline and
  // determine recentRoleTitle/recentCompany/careerStage/yoeRange. On non-null we write the MERGED
  // canonical set (replacing the LinkedIn-only highlights) + the facts under pa-users.tags. FAIL-OPEN:
  // null → keep the LinkedIn-only highlights and don't touch the facts (existing tags preserved).
  let experienceHighlights = linkedinOnlyHighlights
  let mergedFacts: MirrorMergedFacts | undefined
  const linkedinSources: SourceExperience[] = (recordWithDescriptions.experience ?? [])
    .map((e) => toSourceFromLinkedin(e as unknown as Record<string, unknown>))
    .filter((s) => s.title || s.company)
  const resumeSources = collectResumeSourceExperiences(existing)
  if (linkedinSources.length > 0 || resumeSources.length > 0) {
    const merge = deps.mergeAndDetermine ?? mergeAndDetermineProfile
    let merged: MergeAndDetermineResult | null = null
    try {
      merged = await merge({ linkedinExperiences: linkedinSources, resumeExperiences: resumeSources })
    } catch (err) {
      // Belt-and-suspenders: mergeAndDetermineProfile already fails open to null, but never let a
      // throw here crash the mirror.
      deps.log?.("coresignal_mirror.merge_threw", {
        userId,
        error: err instanceof Error ? err.message : String(err),
      })
      merged = null
    }
    if (merged && merged.mergedExperiences.length > 0) {
      experienceHighlights = mergedToHighlights(merged)
      const facts: NonNullable<typeof mergedFacts> = {}
      if (merged.recentRoleTitle) facts.recentRoleTitle = merged.recentRoleTitle
      if (merged.recentCompany) facts.recentCompany = merged.recentCompany
      if (merged.careerStage) facts.careerStage = merged.careerStage
      if (merged.yoeRange) facts.yoeRange = merged.yoeRange
      // roleFunction is closed-enum → LLM-only (the fail-open fallback never sets it, no regex→enum).
      if (merged.roleFunction && merged.roleFunction.length > 0) facts.roleFunction = merged.roleFunction
      if (Object.keys(facts).length > 0) mergedFacts = facts
      deps.log?.("coresignal_mirror.merged_profile", {
        userId,
        mergedRoles: merged.mergedExperiences.length,
        recentRoleTitle: merged.recentRoleTitle ?? null,
        careerStage: merged.careerStage ?? null,
      })
    } else {
      // FAIL-OPEN FALLBACK (no-regex, free-text ONLY): the merge LLM was unavailable / returned nothing.
      // Still fix the MOST VISIBLE staleness — recentRoleTitle/recentCompany — from the candidate's CURRENT
      // LinkedIn role (the agent opener reads these). These are free text, NOT enum, so no regex→enum
      // classification (D15 / no-regex rule honored). careerStage/yoeRange are enum/derived → left to the
      // LLM only; they stay untouched here until the merge actually runs.
      const current = linkedinSources.find((s) => s.isCurrent === true)
      if (current && current.title) {
        const facts: NonNullable<typeof mergedFacts> = { recentRoleTitle: current.title }
        if (current.company) facts.recentCompany = current.company
        mergedFacts = facts
        deps.log?.("coresignal_mirror.facts_fallback", { userId, recentRoleTitle: current.title })
      }
    }

    // EMPLOYER-HISTORY SIGNALS (Adam 2026-06-10) — derive the additive quality signals
    // (employerStages / employerTags / hasBigTechBackground / employerGrowthTier / founderRole /
    // scopeOfOwnership / selectivitySignals) from the merged timeline (or the raw source union when
    // the merge failed open). FAIL-OPEN: any error logs + skips; an empty result writes NOTHING.
    if (deps.deriveEmployerSignals) {
      try {
        const employerRows: EmployerHistoryRow[] =
          merged && merged.mergedExperiences.length > 0
            ? merged.mergedExperiences.map((e) => ({ ...e }))
            : [...resumeSources, ...linkedinSources]
        const signals = await deps.deriveEmployerSignals(employerRows)
        const keys = Object.keys(signals ?? {})
        if (keys.length > 0) {
          mergedFacts = { ...(mergedFacts ?? {}), ...signals }
          deps.log?.("coresignal_mirror.employer_signals", { userId, keys })
        }
      } catch (err) {
        deps.log?.("coresignal_mirror.employer_signals_error", {
          userId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  if (deps.writeBoth) {
    await deps.writeBoth({
      parsedResumeDoc: doc,
      userId,
      coresignalEmployeeId,
      canonicalLinkedInUrl: record.canonicalLinkedInUrl,
      experienceHighlights,
      existingParsedResumeDocId,
      mergedFacts,
    })
  }

  // The enrichment is stored. ONLY NOW may anything downstream act on it — see `afterMirror`.
  if (deps.afterMirror) {
    try {
      await deps.afterMirror(record, userId)
    } catch (err) {
      deps.log?.("coresignal_mirror.after_mirror_error", {
        userId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  deps.log?.("coresignal_mirror.ok", {
    userId,
    coresignalEmployeeId,
    experienceCount: (doc.experiences as unknown[]).length,
  })

  return { status: existingParsedResumeDocId ? "refreshed_existing" : "mirrored" }
}

// ---------------------------------------------------------------------------
// Default Firestore deps wrapper
// ---------------------------------------------------------------------------

export function makeFirestoreMirrorDeps(
  db: Firestore,
): Pick<MirrorDeps, "findExistingForUser" | "writeBoth" | "deriveEmployerSignals" | "afterMirror"> {
  return {
    // YC Startup School pool membership. GATED INSIDE `syncYcPoolMember` on `isYcPeopleUser` and
    // fail-closed there — this wiring is unconditional on purpose, so the gate lives in exactly one
    // place that a refactor of this factory cannot route around. Dynamic import keeps the descriptor
    // + embedding dependencies off this module's graph, which half the codebase imports.
    afterMirror: async (record, userId) => {
      const { syncYcPoolMember } = await import("../yc-pool-sync.js")
      await syncYcPoolMember({ db, record, userId })
    },
    // Employer-history signals default (Adam 2026-06-10): real pa-companies join + gpt-5.4-mini
    // ownership extraction. Lives in deps (not the pure runner) because the join needs db.
    deriveEmployerSignals: (rows: EmployerHistoryRow[]) =>
      deriveEmployerHistorySignals(rows, { getCompanyDocs: makeFirestoreCompanyLoader(db) }),
    findExistingForUser: async (userId: string) => {
      const snap = await db
        .collection(PARSED_RESUMES_COLLECTION)
        .where("userId", "==", userId)
        .limit(50)
        .get()
      return snap.docs.map((d) => {
        const data = d.data() as Record<string, unknown>
        const experiences = Array.isArray(data.experiences)
          ? data.experiences
          : Array.isArray(data.workHistory)
            ? data.workHistory
            : undefined
        return {
          id: d.id,
          coresignalEmployeeId:
            typeof data.coresignalEmployeeId === "number" ? data.coresignalEmployeeId : undefined,
          source: typeof data.source === "string" ? data.source : undefined,
          experiences: Array.isArray(experiences)
            ? experiences.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
            : undefined,
        }
      })
    },
    writeBoth: async ({
      parsedResumeDoc,
      userId,
      coresignalEmployeeId,
      canonicalLinkedInUrl,
      experienceHighlights,
      existingParsedResumeDocId,
      mergedFacts,
    }) => {
      const batch = db.batch()
      const userRef = db.collection(PA_USERS_COLLECTION).doc(userId)
      const selfProfileRef = db.collection("pa-candidate-self-profiles").doc(userId)
      const [userSnap, selfProfileSnap] = await Promise.all([userRef.get(), selfProfileRef.get()])
      const userData = (userSnap.data() ?? {}) as Record<string, unknown>
      const existingLinkedinUrl = userData.linkedinUrl
      const shouldWriteLinkedinUrl =
        typeof canonicalLinkedInUrl === "string" &&
        canonicalLinkedInUrl.trim().length > 0 &&
        (typeof existingLinkedinUrl !== "string" ||
          existingLinkedinUrl.trim().length === 0 ||
          isLinkedinOAuthMarker(existingLinkedinUrl))
      if (existingParsedResumeDocId) {
        const existingRef = db.collection(PARSED_RESUMES_COLLECTION).doc(existingParsedResumeDocId)
        const parsedResumePatch: Record<string, unknown> = { ...parsedResumeDoc, updatedAt: new Date().toISOString() }
        delete parsedResumePatch.createdAt
        batch.set(existingRef, parsedResumePatch, { merge: true })
      } else {
        const newRef = db.collection(PARSED_RESUMES_COLLECTION).doc()
        batch.set(newRef, parsedResumeDoc)
      }
      const userPatch: Record<string, unknown> = {
        coresignalEmployeeId,
        coresignalEmployeeIdUpdatedAt: new Date().toISOString(),
      }
      if (shouldWriteLinkedinUrl) {
        userPatch.linkedinUrl = canonicalLinkedInUrl
      }
      if (experienceHighlights.length > 0) {
        userPatch.experienceHighlights = experienceHighlights
        userPatch.experienceHighlightsUpdatedAt = new Date().toISOString()
      }
      // D8 — write the determined facts under pa-users.tags WITHOUT clobbering sibling tags. Read the
      // existing tags map and spread our keys over a clone, then write the full merged `tags` object.
      // (Firestore set(merge:true) deep-merges nested maps so a sibling like tags.skills would survive
      // anyway — but writing the explicit clone is deterministic and matches the D8 single-source rule.)
      if (mergedFacts && Object.keys(mergedFacts).length > 0) {
        const existingTags =
          userData.tags && typeof userData.tags === "object" && !Array.isArray(userData.tags)
            ? (userData.tags as Record<string, unknown>)
            : {}
        const nowIso = new Date().toISOString()
        const tags: Record<string, unknown> = { ...existingTags }
        if (mergedFacts.recentRoleTitle) tags.recentRoleTitle = mergedFacts.recentRoleTitle
        if (mergedFacts.recentCompany) tags.recentCompany = mergedFacts.recentCompany
        if (mergedFacts.careerStage) tags.careerStage = mergedFacts.careerStage
        if (mergedFacts.yoeRange) tags.yoeRange = mergedFacts.yoeRange
        // D1/D8 — write the canonical same-lane role under the matcher's hard-filter key. Closes the
        // Jasmaine gap: the LinkedIn seam now lands tags.targetRoleFunction (matching + gap-aware role-
        // question suppression) where before only the résumé seam did. Bare string[] (NOT envelope) to
        // keep projectTagsToGlobalTags + the matcher's array-contains-any readers unchanged.
        if (mergedFacts.roleFunction && mergedFacts.roleFunction.length > 0) {
          tags.targetRoleFunction = mergedFacts.roleFunction
        }
        // EMPLOYER-HISTORY signals (Adam 2026-06-10) — additive derived-history keys; only the
        // keys the derivation produced are written (absent keys never clobber existing values).
        if (Array.isArray(mergedFacts.employerStages) && mergedFacts.employerStages.length > 0) {
          tags.employerStages = mergedFacts.employerStages
        }
        if (Array.isArray(mergedFacts.employerTags) && mergedFacts.employerTags.length > 0) {
          tags.employerTags = mergedFacts.employerTags
        }
        if (mergedFacts.hasBigTechBackground === true) tags.hasBigTechBackground = true
        if (typeof mergedFacts.employerGrowthTier === "string") {
          tags.employerGrowthTier = mergedFacts.employerGrowthTier
        }
        if (mergedFacts.founderRole === true) tags.founderRole = true
        if (mergedFacts.scopeOfOwnership && Object.keys(mergedFacts.scopeOfOwnership).length > 0) {
          tags.scopeOfOwnership = mergedFacts.scopeOfOwnership
        }
        if (Array.isArray(mergedFacts.selectivitySignals) && mergedFacts.selectivitySignals.length > 0) {
          tags.selectivitySignals = mergedFacts.selectivitySignals
        }
        tags.lastUpdatedFromMergedExperience = nowIso
        userPatch.tags = tags
      }
      batch.set(userRef, userPatch, { merge: true })
      if (selfProfileSnap.exists && experienceHighlights.length > 0) {
        batch.set(
          selfProfileRef,
          {
            ...(shouldWriteLinkedinUrl ? { linkedinUrl: canonicalLinkedInUrl } : {}),
            experienceHighlights,
            updatedAt: new Date().toISOString(),
          },
          { merge: true },
        )
      }
      await batch.commit()
    },
  }
}
