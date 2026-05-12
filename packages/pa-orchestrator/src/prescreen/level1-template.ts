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

/**
 * Compose Level 1 reveal text for a PASSED candidate. Always returns a
 * non-empty string. Bilingual (zh/en). Caller sends via sendImessage AFTER
 * the terminal text.
 */
export function composeLevel1Reveal(fields: Level1RevealFields, lang: Lang): string {
  const eta = fields.nextStepEta ?? (lang === "zh" ? "2-3 个工作日内" : "within 2-3 business days")
  const companyLine = fields.company
    ? lang === "zh"
      ? `招聘方: ${fields.company}`
      : `Employer: ${fields.company}`
    : ""
  const salaryLine = fields.salaryRange
    ? lang === "zh"
      ? `薪资范围: ${fields.salaryRange}`
      : `Salary range: ${fields.salaryRange}`
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
 * Compose the FAIL "match other jobs?" preamble SMS (sent BEFORE the
 * generateJobRecs result lands). Reuses existing FAIL terminal text;
 * this is just the bridging line.
 */
export function composeFailJobRecsPreamble(lang: Lang): string {
  return lang === "zh"
    ? "我看看有没有其他更合适的机会推给你 — 稍等。"
    : "Let me look for better-aligned roles for you — one moment."
}
