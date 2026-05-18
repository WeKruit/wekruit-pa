/**
 * v1.9 Phase 84 — Level 1 reveal template.
 *
 * After PASS terminal, a single follow-up SMS reveals employer-level info
 * to the candidate: company name, JD URL, salary range, next-step CTA.
 *
 * Pre-PASS messages MUST NEVER contain these fields — snapshot-tested.
 *
 * Source of fields:
 *   - jobTitle / company → pa-jobs/{jobId}.prescreenConfig (already present)
 *   - salary / applyUrl  → pa-jobs/{jobId}.level1Reveal (new optional block)
 *
 * If level1Reveal is not configured, falls back to a generic CTA message
 * with company + jobTitle only.
 */

import type { Lang } from "../onboarding/question.js"

export interface Level1RevealFields {
  /** Display name shown to candidate. */
  jobTitle: string
  /** Employer/company name. */
  company?: string
  /** Optional public application URL or hosted job page. */
  applyUrl?: string
  /** Optional human-readable salary range, e.g. "$120k-$160k". */
  salaryRange?: string
  /** Optional next-step deadline copy, e.g. "within 2-3 business days". */
  nextStepEta?: string
}

function visibleSalaryRange(value: string | undefined): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined

  const compact = trimmed.toLowerCase().replace(/[\s,]/g, "")
  if (/\b999000\b|\b999k\b/.test(compact)) return undefined

  return trimmed
}

/**
 * Compose Level 1 reveal text for a PASSED candidate. Always returns a
 * non-empty string. Bilingual (zh/en). Caller sends through the
 * runtime-approved outbox AFTER the terminal text.
 */
export function composeLevel1Reveal(fields: Level1RevealFields, lang: Lang): string {
  const eta = fields.nextStepEta ?? (lang === "zh" ? "2-3 个工作日内" : "within 2-3 business days")
  const salaryRange = visibleSalaryRange(fields.salaryRange)
  const companyLine = fields.company
    ? lang === "zh"
      ? `招聘方: ${fields.company}`
      : `Employer: ${fields.company}`
    : ""
  const salaryLine = salaryRange
    ? lang === "zh"
      ? `薪资范围: ${salaryRange}`
      : `Salary range: ${salaryRange}`
    : ""
  const linkLine = fields.applyUrl
    ? lang === "zh"
      ? `职位详情: ${fields.applyUrl}`
      : `Job details: ${fields.applyUrl}`
    : ""
  const header =
    lang === "zh"
      ? `恭喜通过 ${fields.jobTitle} 初筛。`
      : `Congrats — you've passed the initial screen for ${fields.jobTitle}.`
  const footer =
    lang === "zh"
      ? `招聘方会${eta}联系你下一步, 请留意短信。`
      : `The employer will follow up ${eta} — please watch for an SMS.`
  return [header, companyLine, salaryLine, linkLine, footer].filter((l) => l.length > 0).join("\n")
}

/**
 * Compose the FAIL job-rec bridge SMS (sent BEFORE the generateJobRecs
 * result lands). Keep it grounded in this screen so it does not feel like
 * a random match pivot.
 */
export function composeFailJobRecsPreamble(lang: Lang): string {
  return lang === "zh"
    ? "我会用你刚才这段 screen 里讲到的经历, 找带岗位链接和核心要求的机会 — 稍等。"
    : "I’ll use what you shared in this screen to look for roles with a usable job link and clear requirements — one moment."
}
