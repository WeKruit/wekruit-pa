export type JobRecLang = "zh" | "en"

export type JobRecIntroContext = {
  role?: string
  skills?: string[]
}

export type JobRecommendationSource = {
  jobTitle?: unknown
  title?: unknown
  companyName?: unknown
  atsApplyUrl?: unknown
  primaryUrl?: unknown
  requiredSkills?: unknown
  reason?: unknown
}

export type JobRecommendationMessageItem = {
  title: string
  companyName?: string
  url: string
  requirementsLine: string
  reason?: string
  sourceJob: JobRecommendationSource
}

export function resolveJobRecVisibleCount(requestedCount: unknown): number {
  const requested = typeof requestedCount === "number" && Number.isFinite(requestedCount)
    ? Math.trunc(requestedCount)
    : 2
  return Math.max(1, Math.min(3, requested || 2))
}

export function formatJobRecIntro(
  lang: JobRecLang,
  visibleCount: number,
  context?: JobRecIntroContext,
): string {
  if (lang === "zh") {
    const count = visibleCount === 3 ? "三个" : visibleCount === 1 ? "一个" : "两个"
    if (context?.role) return `我记得你之前说过想看${context.role}方向, 这里先给你${count}对得上的岗位:`
    if (context?.skills?.length) return `我记得你提到过${context.skills.slice(0, 3).join(" / ")}经验, 这里先给你${count}对得上的岗位:`
    return `我根据你已经分享的资料, 这里先给你${count}对得上的岗位:`
  }
  const count = visibleCount === 3 ? "three" : visibleCount === 1 ? "one" : "two"
  const plural = visibleCount === 1 ? "role" : "roles"
  const verb = visibleCount === 1 ? "lines" : "line"
  if (context?.role) return `I remember you mentioned the ${context.role} direction; I found ${count} ${plural} that ${verb} up:`
  if (context?.skills?.length) return `I remember you mentioned ${context.skills.slice(0, 3).join(" / ")} experience; I found ${count} ${plural} that ${verb} up:`
  return `Based on the profile details you've shared so far, I found ${count} ${plural} that ${verb} up:`
}

export function formatJobRequirementsLine(lang: JobRecLang, requiredSkills: unknown): string {
  const skills = Array.isArray(requiredSkills)
    ? requiredSkills
        .filter((skill): skill is string => typeof skill === "string" && skill.trim().length > 0)
        .map((skill) => skill.trim().replace(/[_-]+/g, " "))
        .slice(0, 5)
    : []
  if (skills.length === 0) {
    return lang === "zh" ? "要求: 点开岗位看完整要求" : "requirements: see the job post for the full requirements"
  }
  return `${lang === "zh" ? "要求" : "requirements"}: ${skills.join(", ")}`
}

function cleanDisplayString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export function toJobRecommendationMessageItem(
  job: JobRecommendationSource,
  lang: JobRecLang,
  options?: { reason?: string | null },
): JobRecommendationMessageItem | null {
  const url = cleanJobRecUrl(job)
  if (!url) return null
  const title = cleanDisplayString(job.jobTitle) ?? cleanDisplayString(job.title) ?? "Open role"
  const companyName = cleanDisplayString(job.companyName)
  const reason = cleanDisplayString(options?.reason) ?? cleanDisplayString(job.reason)
  return {
    title,
    ...(companyName ? { companyName } : {}),
    url,
    requirementsLine: formatJobRequirementsLine(lang, job.requiredSkills),
    ...(reason ? { reason } : {}),
    sourceJob: job,
  }
}

export function collectJobRecommendationMessageItems(
  jobs: JobRecommendationSource[] | undefined,
  lang: JobRecLang,
  options?: { limit?: number; reasons?: Array<string | null | undefined> },
): JobRecommendationMessageItem[] {
  const limit = resolveJobRecVisibleCount(options?.limit)
  const items: JobRecommendationMessageItem[] = []
  for (let i = 0; i < (jobs?.length ?? 0); i++) {
    const job = jobs![i]!
    const item = toJobRecommendationMessageItem(job, lang, { reason: options?.reasons?.[i] ?? undefined })
    if (!item) continue
    items.push(item)
    if (items.length >= limit) break
  }
  return items
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
    lines.push(`• ${item.title}${tag}\n${item.url}\n${item.requirementsLine}${reason}`)
  }
  if (options?.footer) lines.push(options.footer)
  return lines.join("\n\n")
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
  if (ats) return ats
  const primary = typeof job.primaryUrl === "string" ? job.primaryUrl.trim() : ""
  if (!primary) return null
  try {
    const host = new URL(primary).hostname.toLowerCase()
    if (host === "jobright.ai" || host.endsWith(".jobright.ai")) return null
  } catch {
    return null
  }
  return primary
}
