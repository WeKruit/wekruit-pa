// Self-contained copy of @pa/core-types job-logistics (recruiter-web cannot import
// the @pa/core-types barrel — it drags node:crypto via external-supply into the
// browser bundle). Keep in sync with packages/core-types/src/job-logistics.ts.
/**
 * Structured job logistics — Pay · Location · Visa · Benefits.
 *
 * Pay + Location are real structured doc fields. Visa + Benefits usually live
 * only in the free-text JD, so they're extracted from it at read time (the user
 * declined a stored enrichment pass; this surfaces what exists, "Not specified"
 * otherwise — see the matching admin job-quality view).
 *
 * Visa is recruiter-INTERNAL: callers on the candidate surface omit the `visa`
 * field (the candidate site strips visa everywhere). Recruiter + admin show it.
 */
export interface JobLogistics {
  pay?: string
  location?: string
  /** Recruiter/admin only — candidate surfaces must not render this. */
  visa?: string
  benefits?: string
}

interface LogisticsInput {
  salaryRange?: unknown
  compSummary?: unknown
  location?: unknown
  benefits?: unknown
  sponsorship?: unknown
  descriptionMd?: unknown
  prescreenConfig?: unknown
  /** Recruiter payload carries jdBlocks instead of raw descriptionMd. */
  jdBlocks?: unknown
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined
}
function nested(obj: unknown, ...keys: string[]): unknown {
  let cur = obj
  for (const k of keys) {
    if (!cur || typeof cur !== "object") return undefined
    cur = (cur as Record<string, unknown>)[k]
  }
  return cur
}

export function resolveJobPay(d: LogisticsInput): string | undefined {
  return str(d.salaryRange) ?? str(d.compSummary) ?? str(nested(d.prescreenConfig, "level1Reveal", "salaryRange"))
}

export function resolveJobLocation(d: LogisticsInput): string | undefined {
  return str(d.location) ?? str(nested(d.prescreenConfig, "region"))
}

/** Plain text to scan for visa/benefit mentions — descriptionMd or jdBlocks joined. */
function jdText(d: LogisticsInput): string {
  if (str(d.descriptionMd)) return d.descriptionMd as string
  if (Array.isArray(d.jdBlocks)) {
    return d.jdBlocks
      .map((b) => {
        const blk = (b ?? {}) as Record<string, unknown>
        const items = Array.isArray(blk.items) ? (blk.items as unknown[]).map((i) => `- ${String(i)}`).join("\n") : ""
        return [str(blk.heading), str(blk.body), items].filter(Boolean).join("\n")
      })
      .join("\n")
  }
  return ""
}

// Field-style label "Visa: <value>" / "Work authorization: <value>".
const VISA_FIELD_RE = /^(?:visa|work[\s-]*authoriz(?:ation|ed)?|sponsorship|immigration(?:\s*status)?)\b\s*:?\s*(.*)$/i
// Case-insensitive words vs case-sensitive acronyms (so lowercase "opt-in" is not OPT).
const VISA_WORDS_RE = /\b(?:visa|sponsor(?:ship|ed)?|work[\s-]*authoriz(?:ation|ed)?|green\s*card)\b/i
const VISA_ACRONYM_RE = /\b(?:OPT|CPT|H-?1B|EAD)\b/

function hasVisaKeyword(s: string): boolean {
  return VISA_WORDS_RE.test(s) || VISA_ACRONYM_RE.test(s)
}

/** A visa/work-auth statement from the JD, or a label from the structured sponsorship flag. */
export function resolveJobVisa(d: LogisticsInput): string | undefined {
  if (typeof d.sponsorship === "boolean") return d.sponsorship ? "Sponsorship available" : "No sponsorship"
  for (const raw of jdText(d).split(/\r?\n/)) {
    const line = raw.replace(/^[-*#\s]+/, "").replace(/\*\*/g, "").trim()
    if (!line) continue
    const field = line.match(VISA_FIELD_RE)
    if (field) {
      const val = field[1].trim()
      if (val) return val // "Visa: OPT / H-1B ..." → value
      continue // bare "Visa" heading → fall through to the value line below
    }
    if (hasVisaKeyword(line) && line.split(/\s+/).length <= 18) return line
  }
  return undefined
}

// "Benefits"/"Perks"/"What we offer" — NOT "Compensation" (that yields salary lines).
const BENEFIT_HEADING_RE = /^(?:benefits?|perks?(?:\s*(?:&|and)\s*benefits?)?|what we offer|what you(?:'ll| will)? get)\b/i
const BENEFIT_KEYWORD_RE =
  /\b(benefit|perks?|health\s*(?:insurance|care)?|dental|vision|401\s*\(?k\)?|insurance|pto|paid time off|unlimited\s*(?:pto|vacation)|parental\s*leave|equity|stock options?|wellness|relocation)\b/i
// Lines that are really pay / job-type / location, not perks — never show as benefits.
const PAY_NOISE_RE =
  /[$¥€£]|\bsalary\b|\bbase\b|\bcomp(?:ensation)?\b|\brange\b|\/\s*(?:year|yr|month|mo)\b|\bfull[\s-]?time\b|\bpart[\s-]?time\b|\bon-?site\b|\bremote\b|\bhybrid\b/i

function looksLikeBenefit(line: string): boolean {
  return BENEFIT_KEYWORD_RE.test(line) && !PAY_NOISE_RE.test(line)
}

/** A benefits/perks statement from the JD's benefits section or a benefit line. */
export function resolveJobBenefits(d: LogisticsInput): string | undefined {
  if (str(d.benefits)) return d.benefits as string
  if (Array.isArray(d.benefits) && d.benefits.length) {
    return (d.benefits as unknown[]).map((b) => String(b)).filter(Boolean).join(", ")
  }
  const lines = jdText(d).split(/\r?\n/)
  // 1) a dedicated Benefits/Perks heading → collect following perk lines (skip pay noise).
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].replace(/^[#*\s]+/, "").replace(/\*\*/g, "").replace(/:$/, "").trim()
    if (BENEFIT_HEADING_RE.test(head)) {
      const out: string[] = []
      for (let j = i + 1; j < lines.length && out.length < 6; j++) {
        const t = lines[j].replace(/^[-*\s]+/, "").replace(/\*\*/g, "").trim()
        if (!t) { if (out.length) break; else continue }
        if (/^#{1,6}\s/.test(lines[j].trim())) break
        if (PAY_NOISE_RE.test(t)) continue
        out.push(t)
      }
      if (out.length) return out.join("; ")
    }
  }
  // 2) otherwise the first standalone benefit line that is clearly NOT pay/logistics.
  for (const raw of lines) {
    const line = raw.replace(/^[-*#\s]+/, "").replace(/\*\*/g, "").trim()
    if (line && looksLikeBenefit(line) && line.split(/\s+/).length <= 30) return line
  }
  return undefined
}

/** All four. Candidate callers should drop `.visa` before rendering. */
export function resolveJobLogistics(d: LogisticsInput): JobLogistics {
  return {
    pay: resolveJobPay(d),
    location: resolveJobLocation(d),
    visa: resolveJobVisa(d),
    benefits: resolveJobBenefits(d),
  }
}
