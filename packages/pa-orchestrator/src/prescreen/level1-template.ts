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
 * non-empty string. English-only. Caller sends through the
 * runtime-approved outbox AFTER the terminal text.
 */
export function composeLevel1Reveal(fields: Level1RevealFields, _lang: Lang): string {
  const salaryRange = visibleSalaryRange(fields.salaryRange)
  const companyLine = fields.company ? `Employer: ${fields.company}` : ""
  const salaryLine = salaryRange ? `Salary range: ${salaryRange}` : ""
  const linkLine = fields.applyUrl ? `Job details: ${fields.applyUrl}` : ""
  const header = `Congrats — you've passed the initial screen for ${fields.jobTitle}.`
  // 2026-06-10 trust audit (fix 9) — never invent a timeline. An operator-configured
  // nextStepEta (an intentional, job-specific promise) is honored verbatim; the
  // DEFAULT footer makes no time promise and commits only to what we control:
  // texting the candidate the moment it moves.
  const footer = fields.nextStepEta
    ? `The employer will follow up ${fields.nextStepEta} — please watch for an SMS.`
    : "The hiring team is reviewing — I'll text you the moment it moves."
  return [header, companyLine, salaryLine, linkLine, footer].filter((l) => l.length > 0).join("\n")
}

/**
 * Compose the FAIL job-rec bridge SMS (sent BEFORE the generateJobRecs
 * result lands). Keep it grounded in this screen so it does not feel like
 * a random match pivot.
 */
export function composeFailJobRecsPreamble(_lang: Lang): string {
  return "I’ll use what you shared in this screen to look for roles with a usable job link and clear requirements — one moment."
}
