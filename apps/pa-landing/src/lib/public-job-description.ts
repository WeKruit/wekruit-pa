// Pure markdown helpers for sanitizing a job's `descriptionMd` before it reaches
// candidate-facing surfaces. Kept firebase-free (no `./firebase.js` import) so
// the logic is unit-testable under `node --test`/tsx, mirroring
// `public-job-labels.ts`. `public-jobs.ts` re-exports these for render sites.

function isSourceHeading(value: string): boolean {
  const normalized = value
    .replace(/^#{1,6}\s+/, "")
    .replace(/^\*\*/, "")
    .replace(/\*\*$/, "")
    .trim()
    .toLowerCase()
  return normalized === "source" || normalized === "job source" || normalized === "original source"
}

function isHeading(value: string): boolean {
  return /^#{1,6}\s+\S/.test(value) || /^\*\*[^*]+\*\*$/.test(value)
}

function isStandaloneSourceUrl(value: string): boolean {
  const trimmed = value.trim()
  if (/^https?:\/\/\S+$/i.test(trimmed)) return true
  if (/^\[[^\]]+\]\(https?:\/\/[^)]+\)$/i.test(trimmed)) return true
  return false
}

export function stripJobSourceSection(markdown?: string): string | undefined {
  const raw = markdown?.trim()
  if (!raw) return raw
  const lines = raw.split(/\r?\n/)
  const kept: string[] = []
  let skippingSource = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed && isSourceHeading(trimmed)) {
      skippingSource = true
      continue
    }
    if (skippingSource) {
      if (trimmed && isHeading(trimmed)) {
        skippingSource = false
      } else {
        continue
      }
    }
    if (isStandaloneSourceUrl(trimmed)) continue
    kept.push(line)
  }

  return kept.join("\n").trim()
}

// Visa / work-authorization is a candidate-facing sensitivity: WeKruit does not
// surface a job's sponsorship statement anywhere a candidate sees it. Two forms
// appear in real JDs and both must go:
//   1. field style:   "- Visa: OPT / H-1B sponsorship available"
//   2. inline clause:  "US work authorization required · Visa sponsorship + OPT/CPT eligible"
// plus any dedicated visa heading section.
//
// A line is dropped when it is *about* work authorization. Field style is the
// leading label+colon. Inline clauses are caught by visa keywords, but only when
// the line is a short clause/bullet (<= VISA_CLAUSE_MAX_WORDS) so a long
// descriptive paragraph that merely mentions sponsorship once is never nuked.
const VISA_FIELD_RE =
  /^(?:visa|work[\s-]*authoriz(?:ation|ed)?|work[\s-]*eligibility|sponsorship|immigration(?:[\s-]*status)?)\s*:/i

// Case-insensitive word forms.
const VISA_WORDS_RE =
  /\b(?:visa|sponsor(?:ship|ed|s)?|work[\s-]*authoriz(?:ation|ed)?|authoriz(?:ation|ed)\s+to\s+work|right\s+to\s+work|work\s+permit|green\s*card)\b/i
// Case-SENSITIVE acronyms — uppercase OPT/CPT/H-1B are visa terms; lowercase
// "opt-in"/"opt out" are not, so this must not be /i.
const VISA_ACRONYM_RE = /\b(?:OPT|CPT|H-?1B|H1-?B|EAD)\b/
const VISA_CLAUSE_MAX_WORDS = 25

function hasVisaContent(value: string): boolean {
  return VISA_WORDS_RE.test(value) || VISA_ACRONYM_RE.test(value)
}

function isVisaLine(cleaned: string): boolean {
  if (!cleaned) return false
  if (VISA_FIELD_RE.test(cleaned)) return true
  if (!hasVisaContent(cleaned)) return false
  return cleaned.split(/\s+/).length <= VISA_CLAUSE_MAX_WORDS
}

function isVisaHeading(value: string): boolean {
  const normalized = value
    .replace(/^#{1,6}\s+/, "")
    .replace(/^\*\*/, "")
    .replace(/\*\*$/, "")
    .trim()
    .toLowerCase()
  return (
    normalized === "visa" ||
    normalized === "work authorization" ||
    normalized === "work eligibility" ||
    normalized === "sponsorship" ||
    normalized === "immigration" ||
    normalized === "immigration status"
  )
}

export function stripVisaLines(markdown?: string): string | undefined {
  const raw = markdown?.trim()
  if (!raw) return raw
  const lines = raw.split(/\r?\n/)
  const kept: string[] = []
  let skippingVisaSection = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed && isHeading(trimmed) && isVisaHeading(trimmed)) {
      skippingVisaSection = true
      continue
    }
    if (skippingVisaSection) {
      if (trimmed && isHeading(trimmed)) {
        skippingVisaSection = false // fall through — this heading is kept
      } else {
        continue
      }
    }
    const cleaned = trimmed
      .replace(/^[-*]\s+/, "")
      .replace(/^#{1,6}\s+/, "")
      .replace(/\*\*/g, "")
      .trim()
    if (isVisaLine(cleaned)) continue
    kept.push(line)
  }

  return kept.join("\n").trim()
}
