import type { Firestore } from "firebase-admin/firestore"

export type JobRecLang = "zh" | "en"

export type JobRecIntroContext = {
  role?: string
  skills?: string[]
}

export type JobRecommendationSource = {
  id?: unknown
  jobTitle?: unknown
  title?: unknown
  companyName?: unknown
  atsApplyUrl?: unknown
  primaryUrl?: unknown
  requiredSkills?: unknown
  seniorityLevel?: unknown
  reason?: unknown
  matchSourceLabel?: unknown
  previouslyRecommended?: unknown
  recommendationCount?: unknown
  lastRecommendedAt?: unknown
}

export type JobRecommendationMessageItem = {
  title: string
  companyName?: string
  url: string
  requirementsLine: string
  matchSourceLabel: "WeKruit collaborated" | "general match"
  previouslyRecommended: boolean
  recommendationCount?: number
  lastRecommendedAt?: string
  reason?: string
  sourceJob: JobRecommendationSource
}

export type JobRecUrlLivenessVerdict =
  | { alive: true }
  | { alive: false; reason: string }

export type JobRecUrlFetch = (url: string, init?: RequestInit) => Promise<Response>

function cleanRequiredSkills(requiredSkills: unknown): string[] {
  return Array.isArray(requiredSkills)
    ? requiredSkills
        .filter((skill): skill is string => typeof skill === "string" && skill.trim().length > 0)
        .map((skill) => skill.trim().replace(/[_-]+/g, " "))
        .slice(0, 5)
    : []
}

export function hasConcreteJobRequirements(requiredSkills: unknown): boolean {
  return cleanRequiredSkills(requiredSkills).length > 0
}

export function resolveJobRecVisibleCount(requestedCount: unknown): number {
  const requested = typeof requestedCount === "number" && Number.isFinite(requestedCount)
    ? Math.trunc(requestedCount)
    : 2
  return Math.max(1, Math.min(3, requested || 2))
}

/**
 * Default number of role bubbles a single live find_match delivery may ship.
 * Adam directive 2026-06-02: a live on-demand find_match must not bombard the
 * user with a "wall of messages" — cap the COMBINED (collab + regular) list.
 */
export const DEFAULT_MAX_RECS_PER_DELIVERY = 3

/**
 * Resolve the per-delivery role cap from a live `paMaxRecsPerDelivery` flag
 * value. Numeric flags ship through getFlag as `number`; we clamp to [1,6] and
 * fall back to {@link DEFAULT_MAX_RECS_PER_DELIVERY} for any non-numeric or
 * out-of-range value. Mirrors the resolveRecCadenceDays clamp pattern.
 */
export function resolveMaxRecsPerDelivery(flagValue: unknown): number {
  const raw =
    typeof flagValue === "number" && Number.isFinite(flagValue)
      ? Math.trunc(flagValue)
      : typeof flagValue === "string" && flagValue.trim().length > 0 && Number.isFinite(Number(flagValue))
        ? Math.trunc(Number(flagValue))
        : DEFAULT_MAX_RECS_PER_DELIVERY
  return Math.max(1, Math.min(6, raw || DEFAULT_MAX_RECS_PER_DELIVERY))
}

/**
 * Stable collab-first ordering for a list of resolved message items, then a
 * hard slice to `cap`. WeKruit partner/collab roles (matchSourceLabel ===
 * "WeKruit collaborated") are kept ahead of general matches so the cap never
 * drops a partner role to surface a regular one — collab roles are higher value
 * and carry the prescreen start line. Relative order within each group is
 * preserved (the input is already V16-ranked).
 */
export function prioritizeAndCapRecItems(
  items: JobRecommendationMessageItem[],
  cap: number,
): JobRecommendationMessageItem[] {
  if (cap <= 0) return []
  if (items.length <= cap && !items.some((i) => i.matchSourceLabel === "WeKruit collaborated")) {
    return items.slice(0, cap)
  }
  const collab: JobRecommendationMessageItem[] = []
  const general: JobRecommendationMessageItem[] = []
  for (const item of items) {
    if (item.matchSourceLabel === "WeKruit collaborated") collab.push(item)
    else general.push(item)
  }
  return [...collab, ...general].slice(0, cap)
}

export function formatJobRecIntro(
  lang: JobRecLang,
  visibleCount: number,
  context?: JobRecIntroContext,
): string {
  const count = visibleCount === 3 ? "three" : visibleCount === 1 ? "one" : "two"
  const plural = visibleCount === 1 ? "role" : "roles"
  const verb = visibleCount === 1 ? "lines" : "line"
  if (context?.role) return `I remember you mentioned the ${context.role} direction; I found ${count} ${plural} that ${verb} up:`
  if (context?.skills?.length) return `I remember you mentioned ${context.skills.slice(0, 3).join(" / ")} experience; I found ${count} ${plural} that ${verb} up:`
  return `Based on the profile details you've shared so far, I found ${count} ${plural} that ${verb} up:`
}

export function formatJobRequirementsLine(lang: JobRecLang, requiredSkills: unknown): string {
  const skills = cleanRequiredSkills(requiredSkills)
  if (skills.length === 0) return ""
  return `requirements: ${skills.join(", ")}`
}

function cleanDisplayString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function cleanMatchSourceLabel(value: unknown): "WeKruit collaborated" | "general match" {
  return value === "WeKruit collaborated" ? "WeKruit collaborated" : "general match"
}

function cleanPositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined
}

function cleanReason(value: unknown, lang: JobRecLang): string | undefined {
  const reason = cleanDisplayString(value)
  if (!reason) return undefined
  let cleaned = reason
    .replace(/\bmatchSourceLabel\s*:\s*(?:general match|WeKruit collaborated)\b\.?/gi, "")
    .replace(/\b(general match|WeKruit collaborated)\b\.?/gi, "")
    .replace(/\b([A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]*[A-Za-z0-9])\b/g, (token) =>
      token.replace(/_/g, " "),
    )
    .replace(/[ \t]{2,}/g, " ")
    .trim()
  if (!cleaned) return undefined
  if (lang === "en") cleaned = cleaned.replace(/^why\s+match\s*:/i, "why:")
  if (isWeakCandidateVisibleReason(cleaned)) return undefined
  return cleaned
}

function isWeakCandidateVisibleReason(reason: string): boolean {
  const lower = reason.toLowerCase()
  return [
    /\bsame lane as your\b/,
    /\blines up directly\b/,
    /\bindustry\s*(?:\+|and)\s*experience align\b/,
    /\boverall fit\b/,
    /\baligns? with your (?:resume|background|experience)\b/,
    /\bmatches your experience\b/,
    /\bgood fit for your background\b/,
  ].some((re) => re.test(lower))
}

function normalizeYoeRange(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined
  const min = Number(value[0])
  const max = Number(value[1])
  if (!Number.isFinite(min) || !Number.isFinite(max)) return undefined
  return [min, max]
}

function candidateWantsEarlyCareer(candidateTags: unknown): boolean {
  if (!candidateTags || typeof candidateTags !== "object") return false
  const tags = candidateTags as { careerStage?: unknown; yoeRange?: unknown }
  const stage = typeof tags.careerStage === "string" ? tags.careerStage.toLowerCase().trim() : ""
  if (["student", "intern", "entry_level", "entry", "junior", "new_grad"].includes(stage)) return true
  const yoe = normalizeYoeRange(tags.yoeRange)
  return !!yoe && yoe[1] <= 3
}

function isSeniorOrManagementJob(job: JobRecommendationSource): boolean {
  const title = cleanDisplayString(job.jobTitle) ?? cleanDisplayString(job.title) ?? ""
  const seniority = cleanDisplayString(job.seniorityLevel) ?? ""
  const haystack = `${title} ${seniority}`.toLowerCase()
  return /\b(?:senior|sr\.?|staff|principal|lead|manager|director|head|vp|vice\s+president|c[-\s]?level|chief)\b/.test(haystack)
}

export function passesCandidateVisibleSeniorityGate(
  job: JobRecommendationSource,
  candidateTags: unknown,
): boolean {
  if (!candidateWantsEarlyCareer(candidateTags)) return true
  return !isSeniorOrManagementJob(job)
}

export function toJobRecommendationMessageItem(
  job: JobRecommendationSource,
  lang: JobRecLang,
  options?: { reason?: string | null },
): JobRecommendationMessageItem | null {
  const url = cleanJobRecUrl(job)
  if (!url) return null
  const requirementsLine = formatJobRequirementsLine(lang, job.requiredSkills)
  if (!requirementsLine) return null
  const title = cleanDisplayString(job.jobTitle) ?? cleanDisplayString(job.title) ?? "Open role"
  const companyName = cleanDisplayString(job.companyName)
  const reason = cleanReason(options?.reason, lang) ?? cleanReason(job.reason, lang)
  const matchSourceLabel = cleanMatchSourceLabel(job.matchSourceLabel)
  const recommendationCount = cleanPositiveInt(job.recommendationCount)
  const lastRecommendedAt = cleanDisplayString(job.lastRecommendedAt)
  return {
    title,
    ...(companyName ? { companyName } : {}),
    url,
    requirementsLine,
    matchSourceLabel,
    previouslyRecommended: job.previouslyRecommended === true || !!recommendationCount,
    ...(recommendationCount ? { recommendationCount } : {}),
    ...(lastRecommendedAt ? { lastRecommendedAt } : {}),
    ...(reason ? { reason } : {}),
    sourceJob: job,
  }
}

export function collectJobRecommendationMessageItems(
  jobs: JobRecommendationSource[] | undefined,
  lang: JobRecLang,
  options?: {
    limit?: number
    reasons?: Array<string | null | undefined>
    candidateTags?: unknown
    /**
     * Hard cap on the COMBINED (collab + regular) role bubbles delivered. When
     * set, partner/collab roles are prioritized into the cap ahead of general
     * matches. Defaults to {@link resolveJobRecVisibleCount}(options.limit).
     */
    maxRecs?: number
  },
): JobRecommendationMessageItem[] {
  const cap = options?.maxRecs !== undefined
    ? Math.max(1, Math.trunc(options.maxRecs))
    : resolveJobRecVisibleCount(options?.limit)
  const items: JobRecommendationMessageItem[] = []
  for (let i = 0; i < (jobs?.length ?? 0); i++) {
    const job = jobs![i]!
    if (!passesCandidateVisibleSeniorityGate(job, options?.candidateTags)) continue
    const item = toJobRecommendationMessageItem(job, lang, { reason: options?.reasons?.[i] ?? undefined })
    if (!item) continue
    items.push(item)
    // Collect a small candidate pool past the cap so collab-priority can
    // reorder before the hard slice; bound it to avoid scanning the full corpus.
    if (items.length >= cap * 3) break
  }
  return prioritizeAndCapRecItems(items, cap)
}

export async function checkJobRecUrlLiveness(
  url: string,
  options?: {
    fetchImpl?: JobRecUrlFetch
    timeoutMs?: number
  },
): Promise<JobRecUrlLivenessVerdict> {
  const fetchImpl = options?.fetchImpl ?? (globalThis.fetch as JobRecUrlFetch | undefined)
  if (!fetchImpl) return { alive: false, reason: "fetch_unavailable" }
  const timeoutMs = options?.timeoutMs ?? 2500
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, {
      method: "HEAD",
      redirect: "follow",
      signal: ctrl.signal,
    })
    if ((res.status >= 200 && res.status < 400) || res.status === 405) {
      return { alive: true }
    }
    return { alive: false, reason: `http_${res.status}` }
  } catch (err) {
    const e = err as { name?: string; message?: string }
    if (e?.name === "AbortError" || (e?.message ?? "").toLowerCase().includes("aborted")) {
      return { alive: false, reason: "timeout" }
    }
    return { alive: false, reason: `network_error:${(e?.message ?? "unknown").slice(0, 80)}` }
  } finally {
    clearTimeout(timer)
  }
}

export async function collectLiveJobRecommendationMessageItems(
  jobs: JobRecommendationSource[] | undefined,
  lang: JobRecLang,
  options?: {
    limit?: number
    reasons?: Array<string | null | undefined>
    candidateTags?: unknown
    maxCandidates?: number
    /**
     * Hard cap on the COMBINED (collab + regular) role bubbles delivered. When
     * set, partner/collab roles are prioritized into the cap ahead of general
     * matches. Defaults to {@link resolveJobRecVisibleCount}(options.limit).
     */
    maxRecs?: number
    fetchImpl?: JobRecUrlFetch
    timeoutMs?: number
    onDeadJob?: (
      job: JobRecommendationSource,
      verdict: Exclude<JobRecUrlLivenessVerdict, { alive: true }>,
      url: string,
    ) => Promise<void> | void
    log?: (event: string, payload?: Record<string, unknown>) => void
  },
): Promise<JobRecommendationMessageItem[]> {
  const limit = options?.maxRecs !== undefined
    ? Math.max(1, Math.trunc(options.maxRecs))
    : resolveJobRecVisibleCount(options?.limit)
  const maxCandidates = Math.max(limit, Math.min(options?.maxCandidates ?? Math.max(8, limit * 4), jobs?.length ?? 0))
  const candidates: JobRecommendationMessageItem[] = []
  for (let i = 0; i < (jobs?.length ?? 0) && candidates.length < maxCandidates; i++) {
    const job = jobs![i]!
    if (!passesCandidateVisibleSeniorityGate(job, options?.candidateTags)) continue
    const item = toJobRecommendationMessageItem(job, lang, { reason: options?.reasons?.[i] ?? undefined })
    if (item) candidates.push(item)
  }
  if (candidates.length === 0) return []

  const checked = await Promise.all(
    candidates.map(async (item) => ({
      item,
      verdict: await checkJobRecUrlLiveness(item.url, {
        ...(options?.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      }),
    })),
  )

  const alive: JobRecommendationMessageItem[] = []
  for (const { item, verdict } of checked) {
    if (verdict.alive) {
      alive.push(item)
      // Collect a bounded pool past the cap so collab-priority can reorder
      // before the hard slice (don't stop at `limit` in V16 order).
      if (alive.length >= limit * 3) break
      continue
    }
    options?.log?.("pa.job_rec.visible_url_dead", {
      jobId: cleanDisplayString(item.sourceJob.id),
      companyName: item.companyName ?? null,
      url: item.url,
      reason: verdict.reason,
    })
    await options?.onDeadJob?.(item.sourceJob, verdict, item.url)
  }
  // Cap the COMBINED list to `limit`, keeping WeKruit partner/collab roles
  // ahead of general matches so the cap never drops a partner role.
  return prioritizeAndCapRecItems(alive, limit)
}

export async function markDeadJobRecommendationSource(
  db: Firestore,
  job: JobRecommendationSource,
  reason: string,
): Promise<void> {
  if (typeof job.id !== "string" || job.id.trim().length === 0) return
  const now = new Date().toISOString()
  await db.collection("matching-jobs").doc(job.id).set(
    {
      dead: true,
      deadCheckedAt: now,
      deadReason: `runtime_${reason}`,
      updatedAt: now,
    },
    { merge: true },
  )
}

export async function collectLiveFirestoreJobRecommendationMessageItems(
  db: Firestore,
  jobs: JobRecommendationSource[] | undefined,
  lang: JobRecLang,
  options?: {
    limit?: number
    reasons?: Array<string | null | undefined>
    candidateTags?: unknown
    maxCandidates?: number
    maxRecs?: number
    fetchImpl?: JobRecUrlFetch
    timeoutMs?: number
    log?: (event: string, payload?: Record<string, unknown>) => void
  },
): Promise<JobRecommendationMessageItem[]> {
  return collectLiveJobRecommendationMessageItems(jobs, lang, {
    ...options,
    onDeadJob: async (job, verdict) => {
      await markDeadJobRecommendationSource(db, job, verdict.reason)
    },
  })
}

export function composeJobRecommendationMessage(
  items: JobRecommendationMessageItem[],
  lang: JobRecLang,
  context?: JobRecIntroContext,
  options?: { footer?: string },
): string {
  const lines: string[] = [formatJobRecIntro(lang, items.length, context)]
  for (const item of items) {
    const tag = item.companyName ? ` @ ${item.companyName}` : ""
    const reason = item.reason ? `\n${item.reason}` : ""
    const repeat =
      item.previouslyRecommended
        ? "\nI may have shared this before, but it is worth another look because it still lines up."
        : ""
    lines.push(`• ${item.title}${tag}${repeat}\n${item.url}\n${item.requirementsLine}${reason}`)
  }
  if (options?.footer) lines.push(options.footer)
  return lines.join("\n\n")
}

export function buildJobRecommendationRuntimeContext(
  items: JobRecommendationMessageItem[],
  context?: JobRecIntroContext,
  options?: { requestedCount?: number; source?: string; eventKind?: string; footer?: string },
): Record<string, unknown> {
  const trustedOutboundBody = composeJobRecommendationMessage(items, "en", context, {
    ...(options?.footer ? { footer: options.footer } : {}),
  })
  return {
    eventKind: options?.eventKind ?? "job_recommendations_requested",
    source: options?.source ?? "job_rec",
    preferredLanguage: "en",
    requestedCount: options?.requestedCount ?? items.length,
    candidateContext: context ?? null,
    trustedOutboundBody,
    jobs: items.map((item) => ({
      id: cleanDisplayString(item.sourceJob.id),
      title: item.title,
      companyName: item.companyName ?? null,
      url: item.url,
      requirements: item.requirementsLine,
      reason: item.reason ?? null,
      previouslyRecommended: item.previouslyRecommended,
      recommendationCount: item.recommendationCount ?? 0,
      lastRecommendedAt: item.lastRecommendedAt ?? null,
      // Collab/partner jobs are the ONLY ones WeKruit can screen + forward. Surface
      // a neutral boolean (never the internal "matchSourceLabel" string, which must
      // stay out of the runtime/LLM-visible context) so downstream copy can gate the
      // "quick screen / move it forward" framing to collab jobs only.
      collab: item.matchSourceLabel === "WeKruit collaborated",
    })),
    instructions: [
      "Write candidate-visible copy in English only.",
      "Use exactly the number of roles requested unless the user asked for a different count.",
      "For every role include title, company, URL, requirements, and reason.",
      "Do not expose internal labels, field names, ids, or scoring metadata.",
      "If a role has previouslyRecommended=true, say briefly that it may be a repeat and why it is still worth another look.",
      "Only offer a WeKruit screen or to move a candidate forward when collab=true; for collab=false roles the candidate applies via the link themselves, so never imply WeKruit screens or forwards them.",
      "If timing is awkward or the request should not send, respond __NO_SEND__.",
    ],
  }
}

export function compactJobRecContext(tags: unknown): JobRecIntroContext | undefined {
  if (!tags || typeof tags !== "object") return undefined
  const data = tags as {
    targetRole?: unknown
    targetRoleFunction?: unknown
    skills?: unknown
  }
  const roleSource = Array.isArray(data.targetRole) && typeof data.targetRole[0] === "string"
    ? data.targetRole[0]
    : Array.isArray(data.targetRoleFunction) && typeof data.targetRoleFunction[0] === "string"
      ? data.targetRoleFunction[0]
      : undefined
  const role = roleSource?.replace(/_/g, " ").trim()
  const skills = Array.isArray(data.skills)
    ? data.skills
        .map((skill) => {
          if (typeof skill === "string") return skill.trim()
          if (skill && typeof skill === "object" && typeof (skill as { name?: unknown }).name === "string") {
            return (skill as { name: string }).name.trim()
          }
          return ""
        })
        .filter(Boolean)
        .slice(0, 3)
    : undefined
  return role || skills?.length ? { ...(role ? { role } : {}), ...(skills?.length ? { skills } : {}) } : undefined
}

export function cleanJobRecUrl(job: { atsApplyUrl?: unknown; primaryUrl?: unknown }): string | null {
  const ats = typeof job.atsApplyUrl === "string" ? job.atsApplyUrl.trim() : ""
  if (ats) return normalizeJobRecUrl(ats)
  const primary = typeof job.primaryUrl === "string" ? job.primaryUrl.trim() : ""
  if (!primary) return null
  try {
    const host = new URL(primary).hostname.toLowerCase()
    if (host === "jobright.ai" || host.endsWith(".jobright.ai")) return null
  } catch {
    return null
  }
  return normalizeJobRecUrl(primary)
}

export function normalizeJobRecUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    if (
      (host === "workatastartup.com" || host === "www.workatastartup.com") &&
      /^\/companies\/[^/]+\/jobs\/?$/.test(parsed.pathname)
    ) {
      parsed.pathname = parsed.pathname.replace(/\/jobs\/?$/, "")
      return parsed.toString()
    }
  } catch {
    return url
  }
  return url
}
