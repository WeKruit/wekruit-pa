/**
 * Phase EX1 PR-A — heuristic title → seniority bucket.
 *
 * Deliberately string-pattern based, NOT LLM. Keeps `deriveExperienceModel`
 * pure and offline-testable. The full canonical mapping (and any LLM
 * augmentation) lives in PA's downstream user-tag enricher; this is
 * just enough signal for ranking weights.
 */

import type { DerivedExperienceModel } from "./types.js"

type Seniority = DerivedExperienceModel["seniorityCurrent"]

/**
 * Ordered list — first match wins. Patterns are tested against the
 * lowercased title with surrounding word boundaries where it matters
 * (e.g. "principal" must not match "principle").
 */
const RULES: Array<{ re: RegExp; level: Seniority }> = [
  { re: /\b(intern|internship|co-?op)\b/i, level: "intern" },
  { re: /\b(new[\s-]?grad|recent[\s-]?graduate)\b/i, level: "new_grad" },
  { re: /\b(entry[\s-]?level|associate|junior|trainee)\b/i, level: "entry_level" },
  { re: /\b(vp|vice[\s-]?president|chief|c[etfio]o|svp|evp|head\s+of)\b/i, level: "executive" },
  { re: /\b(director)\b/i, level: "director" },
  { re: /\b(manager|lead\s+manager|engineering\s+manager|people\s+manager)\b/i, level: "manager" },
  { re: /\b(staff|principal|distinguished|fellow)\b/i, level: "staff" },
  { re: /\b(senior|sr\.?|lead)\b/i, level: "senior" },
  { re: /\b(mid|mid[\s-]?level|software\s+engineer\s+ii|engineer\s+ii)\b/i, level: "mid" },
]

export function inferSeniorityFromTitle(title: string): Seniority {
  const t = (title || "").toLowerCase().trim()
  if (!t) return "unknown"
  for (const rule of RULES) {
    if (rule.re.test(t)) return rule.level
  }
  return "unknown"
}
